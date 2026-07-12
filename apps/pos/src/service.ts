import type {
  CashRounding,
  CashSessionZReport,
  PaymentInput,
  PromotionApplication,
  PromotionInput,
  SaleTotals,
  Settlement,
  TaxDefinitionInput,
} from "@berrypos/domain";
import { computeSaleTotals, type SaleInput } from "@berrypos/domain";
import { quoteCart, toRecordSaleParams, type Cart } from "./cart.js";
import { SEED_CASH_ROUNDING, SEED_SNAPSHOT } from "./catalog-seed.js";
import { hashPin } from "./pin.js";
import {
  applyCatalogSnapshot,
  createProduct,
  findProductById,
  findProductByScan,
  findUserById,
  getActiveUsers,
  getCatalogRevision,
  getPromotions,
  getTaxCatalog,
  listProducts,
  type ProductWithBarcodes,
  type ScanResult,
} from "./db/catalog.js";
import {
  closeCashSession,
  findSessionById,
  getOpenSession,
  openCashSession,
  recordCashMovement,
} from "./db/cash.js";
import {
  getSaleForTicket,
  listRecentSales,
  recordSale,
  voidSale,
  type RecentSale,
} from "./db/sales.js";
import { renderTicketText, type TicketData } from "./ticket.js";
import {
  getDailyCashierSummary,
  getSessionSalesSummary,
  type CashierDaySummary,
  type SessionSalesSummary,
} from "./db/reports.js";
import {
  getProductStock,
  projectAllStock,
  recordStockMovement,
} from "./db/stock.js";
import type { DeviceContext, PosDb } from "./db/context.js";

/**
 * The register's application service: everything the sale screen needs,
 * backed by the real store DB. The HTTP server is a thin JSON wrapper over
 * this class, so it stays fully testable without sockets.
 */

export interface UserSummary {
  id: string;
  name: string;
  role: string;
}

export interface SessionInfo {
  id: string;
  cashierId: string;
  cashierName: string;
  openedAt: string;
}

export interface ProductSummary extends ProductWithBarcodes {
  /** Current stock projection (milli-units; 1525 = 1.525 kg or units×1000). */
  stockMilli: number;
}

export interface BootstrapData {
  products: ProductSummary[];
  taxCatalog: TaxDefinitionInput[];
  promotions: PromotionInput[];
  /** Store cash-rounding rule; the UI needs it for the exact-cash button. */
  cashRounding: CashRounding;
  /** Who can sign in at this register (no PIN hashes here). */
  users: UserSummary[];
  /** The open shift, if any. Selling requires one. */
  session: SessionInfo | null;
}

export interface NewProductDraft {
  name: string;
  barcode: string;
  unitPriceCents: number;
  isWeighable: boolean;
}

export interface CheckoutResult {
  saleId: string;
  quote: { totals: SaleTotals; promotions: PromotionApplication[] };
  settlement: Settlement;
}

export interface ShiftCloseResult {
  z: CashSessionZReport;
  sales: SessionSalesSummary;
  cashierId: string;
}

export class PosService {
  constructor(
    private readonly db: PosDb,
    private readonly ctx: DeviceContext,
    private readonly storeName = "BerryPOS",
  ) {}

  /** Seed/upgrade the base catalog and load everything the UI needs. */
  bootstrap(): BootstrapData {
    if (getCatalogRevision(this.db) < SEED_SNAPSHOT.revision) {
      applyCatalogSnapshot(this.db, SEED_SNAPSHOT);
    }
    const stock = projectAllStock(this.db);
    return {
      products: listProducts(this.db).map((p) => ({
        ...p,
        stockMilli: stock.get(p.id) ?? 0,
      })),
      taxCatalog: getTaxCatalog(this.db),
      promotions: getPromotions(this.db),
      cashRounding: SEED_CASH_ROUNDING,
      users: getActiveUsers(this.db).map(({ id, name, role }) => ({
        id,
        name,
        role,
      })),
      session: this.sessionInfo(),
    };
  }

  /** PIN sign-in. Returns the user or throws. */
  async login(userId: string, pin: string): Promise<UserSummary> {
    const user = findUserById(this.db, userId);
    if (!user || !user.active || user.pinHash !== (await hashPin(pin))) {
      throw new Error("PIN incorrecto");
    }
    return { id: user.id, name: user.name, role: user.role };
  }

  /** Open a shift for a cashier. Only one shift can be open at a time. */
  openShift(params: {
    sessionId: string;
    cashierId: string;
    openingFloatCents: number;
  }): SessionInfo {
    const open = getOpenSession(this.db);
    if (open && open.id !== params.sessionId) {
      throw new Error("Ya hay un turno abierto; ciérralo antes de abrir otro");
    }
    openCashSession(this.db, this.ctx, params);
    const info = this.sessionInfo();
    if (!info) throw new Error("unreachable: shift just opened");
    return info;
  }

  /** Manual drawer movement (ingreso/retiro) on the open shift. */
  cashMovement(params: {
    movementId: string;
    kind: "pay_in" | "pay_out";
    amountCents: number;
    note?: string;
  }): { alreadyRecorded: boolean } {
    const session = this.requireOpenSession();
    return recordCashMovement(this.db, this.ctx, {
      ...params,
      sessionId: session.id,
    });
  }

  /**
   * Close the shift with a blind count: the caller sends what the cashier
   * counted, and only the response reveals expected cash and over/short.
   */
  closeShift(params: { countedCents: number }): ShiftCloseResult {
    const session = this.requireOpenSession();
    const z = closeCashSession(this.db, this.ctx, {
      sessionId: session.id,
      countedCents: params.countedCents,
    });
    return {
      z,
      sales: getSessionSalesSummary(this.db, session.id),
      cashierId: session.cashierId,
    };
  }

  /** Per-cashier activity for shifts opened today (local time). */
  dailySummary(): { cashiers: CashierDaySummary[]; dayIso: string } {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return {
      cashiers: getDailyCashierSummary(
        this.db,
        start.toISOString(),
        end.toISOString(),
      ),
      dayIso: start.toISOString(),
    };
  }

  scan(code: string): ScanResult {
    return findProductByScan(this.db, code);
  }

  /** Register a product at the register and return it ready for the cart. */
  registerProduct(draft: NewProductDraft): ScanResult {
    const r = createProduct(this.db, this.ctx, {
      id: crypto.randomUUID(),
      name: draft.name,
      barcode: draft.barcode,
      unitPriceCents: draft.unitPriceCents,
      isWeighable: draft.isWeighable,
      taxCodes: SEED_SNAPSHOT.taxCatalog.map((t) => t.code),
    });
    return { kind: "product", product: r.product };
  }

  /**
   * Receive merchandise: append a reception movement to the stock ledger.
   * `movementId` is client-generated so retries never double the stock.
   */
  receiveStock(params: {
    movementId: string;
    productId: string;
    qtyMilli: number;
    note?: string;
  }): { stockMilli: number } {
    if (!findProductById(this.db, params.productId)) {
      throw new Error(`product "${params.productId}" does not exist`);
    }
    recordStockMovement(this.db, this.ctx, {
      movementId: params.movementId,
      productId: params.productId,
      kind: "reception",
      qtyMilli: params.qtyMilli,
      ...(params.note ? { note: params.note } : {}),
    });
    return { stockMilli: getProductStock(this.db, params.productId) };
  }

  /** Freeze the cart, settle the tender and persist the sale atomically. */
  checkout(cart: Cart, payments: PaymentInput[]): CheckoutResult {
    const session = this.requireOpenSession();
    this.assertStockAvailable(cart);
    const promotions = getPromotions(this.db);
    const taxCatalog = getTaxCatalog(this.db);
    const quote = quoteCart(cart, promotions, taxCatalog);
    const params = toRecordSaleParams(cart, promotions, {
      saleId: crypto.randomUUID(),
      cashSessionId: session.id,
      payments,
      cashRounding: SEED_CASH_ROUNDING,
    });
    const r = recordSale(this.db, this.ctx, params);
    return {
      saleId: r.saleId,
      quote: { totals: r.totals, promotions: quote.promotions },
      settlement: r.settlement,
    };
  }

  /** Void a charged sale: stock returns, cash refunds from the open drawer. */
  voidSale(params: { saleId: string; voidedBy: string; reason?: string }): {
    alreadyVoided: boolean;
  } {
    const open = getOpenSession(this.db);
    return voidSale(this.db, this.ctx, {
      saleId: params.saleId,
      voidedBy: params.voidedBy,
      currentSessionId: open?.id ?? null,
      ...(params.reason ? { reason: params.reason } : {}),
    });
  }

  /** Build the receipt ticket of a persisted sale (data + text preview). */
  receiptTicket(saleId: string): { data: TicketData; text: string } {
    const { sale, lines, payments } = getSaleForTicket(this.db, saleId);

    const session = findSessionById(this.db, sale.cashSessionId);
    const cashier = session ? findUserById(this.db, session.cashierId) : undefined;
    const input = sale.input as { sale: SaleInput };
    const totals = computeSaleTotals(input.sale);

    const data: TicketData = {
      storeName: this.storeName,
      storeLine2: "Documento interno de venta",
      deviceId: this.ctx.deviceId,
      cashierName: cashier?.name ?? session?.cashierId ?? "-",
      saleId: sale.id,
      dateIso: sale.createdAt,
      lines: lines.map((line) => ({
        name: findProductById(this.db, line.productId)?.name ?? line.productId,
        qtyMilli: line.qtyMilli,
        isWeighable:
          findProductById(this.db, line.productId)?.isWeighable ?? false,
        unitPriceCents: line.unitPriceCents,
        totalCents: line.totalCents,
        discountCents: line.discountCents,
      })),
      grossCents: totals.grossCents,
      discountCents: totals.discountCents,
      totalCents: sale.totalCents,
      taxBreakdown: totals.taxBreakdown.map((t) => ({
        code: t.code,
        taxCents: t.taxCents,
      })),
      payments: payments.map((p) => ({
        method: p.method,
        amountCents: p.amountCents,
      })),
      changeCents: sale.changeCents,
      cashRoundingCents: sale.cashRoundingCents,
      voided: sale.voidedAt !== null,
    };
    return { data, text: renderTicketText(data) };
  }

  /** Today's sales, newest first (the void screen). */
  recentSales(): RecentSale[] {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return listRecentSales(this.db, { sinceIso: start.toISOString() });
  }

  /**
   * Store policy (owner decision): never sell below registered stock.
   * The ledger itself stays permissive — voids, receptions and sync
   * corrections are unaffected.
   */
  private assertStockAvailable(cart: Cart): void {
    const stock = projectAllStock(this.db);
    const required = new Map<string, number>();
    for (const line of cart.lines) {
      required.set(
        line.productId,
        (required.get(line.productId) ?? 0) + line.qtyMilli,
      );
    }
    for (const [productId, qtyMilli] of required) {
      const available = stock.get(productId) ?? 0;
      if (qtyMilli > available) {
        const product = findProductById(this.db, productId);
        throw new Error(
          `Sin stock suficiente de "${product?.name ?? productId}": disponible ${Math.max(available, 0) / 1000}, pedido ${qtyMilli / 1000}. Registra la recepción primero.`,
        );
      }
    }
  }

  private requireOpenSession() {
    const session = getOpenSession(this.db);
    if (!session) {
      throw new Error("No hay un turno de caja abierto");
    }
    return session;
  }

  private sessionInfo(): SessionInfo | null {
    const session = getOpenSession(this.db);
    if (!session) return null;
    const user = findUserById(this.db, session.cashierId);
    return {
      id: session.id,
      cashierId: session.cashierId,
      cashierName: user?.name ?? session.cashierId,
      openedAt: session.openedAt,
    };
  }
}
