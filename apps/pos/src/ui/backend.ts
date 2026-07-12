import {
  closeCashSession as computeZReport,
  parseScaleEan13,
  settlePayments,
  type CashMovementInput,
  type PaymentInput,
} from "@berrypos/domain";
import { quoteCart, type Cart } from "../cart.js";
import { SEED_CASH_ROUNDING, SEED_SNAPSHOT } from "../catalog-seed.js";
import type { ScanResult } from "../db/catalog.js";
import { hashPin } from "../pin.js";
import type {
  BootstrapData,
  CheckoutResult,
  NewProductDraft,
  ProductSummary,
  SessionInfo,
  ShiftCloseResult,
  UserSummary,
} from "../service.js";
import type { CashierDaySummary } from "../db/reports.js";
import type { RecentSale } from "../db/sales.js";

export type {
  BootstrapData,
  CheckoutResult,
  NewProductDraft,
  ProductSummary,
  SessionInfo,
  ShiftCloseResult,
  UserSummary,
  CashierDaySummary,
  RecentSale,
};

export interface ReceiveStockInput {
  /** Client-generated UUID so a retry never doubles the stock. */
  movementId: string;
  productId: string;
  qtyMilli: number;
  note?: string;
}

/**
 * What the sale screen needs from the world. `HttpBackend` talks to the
 * local register server (the store SQLite); `MemoryBackend` is the fallback
 * demo when the server isn't running.
 */
export interface PosBackend {
  /** "server" = real persistence, "demo" = in-memory. */
  readonly mode: "server" | "demo";
  bootstrap(): Promise<BootstrapData>;
  scan(code: string): Promise<ScanResult>;
  createProduct(draft: NewProductDraft): Promise<ScanResult>;
  checkout(cart: Cart, payments: PaymentInput[]): Promise<CheckoutResult>;
  /** Merchandise reception: adds to the stock ledger. */
  receiveStock(input: ReceiveStockInput): Promise<{ stockMilli: number }>;
  login(userId: string, pin: string): Promise<UserSummary>;
  openShift(input: {
    sessionId: string;
    cashierId: string;
    openingFloatCents: number;
  }): Promise<SessionInfo>;
  cashMovement(input: {
    movementId: string;
    kind: "pay_in" | "pay_out";
    amountCents: number;
    note?: string;
  }): Promise<unknown>;
  closeShift(input: { countedCents: number }): Promise<ShiftCloseResult>;
  dailySummary(): Promise<{ cashiers: CashierDaySummary[]; dayIso: string }>;
  recentSales(): Promise<RecentSale[]>;
  voidSale(input: {
    saleId: string;
    voidedBy: string;
    reason?: string;
  }): Promise<{ alreadyVoided: boolean }>;
}

const SERVER_URL = "http://127.0.0.1:1421";

export class HttpBackend implements PosBackend {
  readonly mode = "server";

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  }

  bootstrap() {
    return this.call<BootstrapData>("GET", "/bootstrap");
  }
  scan(code: string) {
    return this.call<ScanResult>("POST", "/scan", { code });
  }
  createProduct(draft: NewProductDraft) {
    return this.call<ScanResult>("POST", "/products", draft);
  }
  checkout(cart: Cart, payments: PaymentInput[]) {
    return this.call<CheckoutResult>("POST", "/checkout", { cart, payments });
  }
  receiveStock(input: ReceiveStockInput) {
    return this.call<{ stockMilli: number }>("POST", "/receive", input);
  }
  login(userId: string, pin: string) {
    return this.call<UserSummary>("POST", "/login", { userId, pin });
  }
  openShift(input: { sessionId: string; cashierId: string; openingFloatCents: number }) {
    return this.call<SessionInfo>("POST", "/session/open", input);
  }
  cashMovement(input: { movementId: string; kind: "pay_in" | "pay_out"; amountCents: number; note?: string }) {
    return this.call<unknown>("POST", "/session/movement", input);
  }
  closeShift(input: { countedCents: number }) {
    return this.call<ShiftCloseResult>("POST", "/session/close", input);
  }
  dailySummary() {
    return this.call<{ cashiers: CashierDaySummary[]; dayIso: string }>("GET", "/summary/today");
  }
  recentSales() {
    return this.call<RecentSale[]>("GET", "/sales/recent");
  }
  voidSale(input: { saleId: string; voidedBy: string; reason?: string }) {
    return this.call<{ alreadyVoided: boolean }>("POST", "/sales/void", input);
  }
}

type SeedProduct = BootstrapData["products"][number];

/** Browser demo without the server: same engines, nothing persists. */
export class MemoryBackend implements PosBackend {
  readonly mode = "demo";
  private readonly products: SeedProduct[] = SEED_SNAPSHOT.products.map((p) => ({
    id: p.id,
    name: p.name,
    categoryId: p.categoryId ?? null,
    scaleItemCode: p.scaleItemCode ?? null,
    isWeighable: p.isWeighable,
    unitPriceCents: p.unitPriceCents,
    taxCodes: p.taxCodes,
    active: p.active,
    source: "cloud" as const,
    barcodes: [...p.barcodes],
    stockMilli: 10_000, // demo starts with 10 units / 10 kg of everything
  }));

  private session: SessionInfo | null = null;
  private movements: CashMovementInput[] = [];
  private shiftSales = { salesCount: 0, totalCents: 0, byMethod: new Map<string, number>() };
  private day: CashierDaySummary[] = [];
  private salesLog: RecentSale[] = [];
  private saleDetails = new Map<
    string,
    { items: Array<{ productId: string; qtyMilli: number }>; cashApplied: number }
  >();

  async bootstrap(): Promise<BootstrapData> {
    return {
      products: this.products,
      taxCatalog: SEED_SNAPSHOT.taxCatalog,
      promotions: SEED_SNAPSHOT.promotions,
      cashRounding: SEED_CASH_ROUNDING,
      users: SEED_SNAPSHOT.users.map(({ id, name, role }) => ({ id, name, role })),
      session: this.session,
    };
  }

  async login(userId: string, pin: string): Promise<UserSummary> {
    const user = SEED_SNAPSHOT.users.find((u) => u.id === userId && u.active);
    if (!user || user.pinHash !== (await hashPin(pin))) {
      throw new Error("PIN incorrecto");
    }
    return { id: user.id, name: user.name, role: user.role };
  }

  async openShift(input: {
    sessionId: string;
    cashierId: string;
    openingFloatCents: number;
  }): Promise<SessionInfo> {
    if (this.session) throw new Error("Ya hay un turno abierto; ciérralo antes de abrir otro");
    const user = SEED_SNAPSHOT.users.find((u) => u.id === input.cashierId);
    this.session = {
      id: input.sessionId,
      cashierId: input.cashierId,
      cashierName: user?.name ?? input.cashierId,
      openedAt: new Date().toISOString(),
    };
    this.movements =
      input.openingFloatCents > 0
        ? [{ id: `${input.sessionId}/open`, kind: "opening_float", amountCents: input.openingFloatCents }]
        : [];
    this.shiftSales = { salesCount: 0, totalCents: 0, byMethod: new Map() };
    return this.session;
  }

  async cashMovement(input: {
    movementId: string;
    kind: "pay_in" | "pay_out";
    amountCents: number;
    note?: string;
  }): Promise<unknown> {
    if (!this.session) throw new Error("No hay un turno de caja abierto");
    this.movements.push({
      id: input.movementId,
      kind: input.kind,
      amountCents: input.amountCents,
    });
    return { alreadyRecorded: false };
  }

  async closeShift(input: { countedCents: number }): Promise<ShiftCloseResult> {
    if (!this.session) throw new Error("No hay un turno de caja abierto");
    const z = computeZReport({
      movements: this.movements,
      countedCents: input.countedCents,
    });
    const result: ShiftCloseResult = {
      z,
      sales: {
        salesCount: this.shiftSales.salesCount,
        totalCents: this.shiftSales.totalCents,
        byMethod: [...this.shiftSales.byMethod.entries()].map(
          ([method, amountCents]) => ({ method: method as PaymentInput["method"], amountCents }),
        ),
      },
      cashierId: this.session.cashierId,
    };
    this.day.push({
      cashierId: this.session.cashierId,
      salesCount: this.shiftSales.salesCount,
      totalCents: this.shiftSales.totalCents,
      overShortCents: z.overShortCents,
      sessionsCount: 1,
      openSessions: 0,
    });
    this.session = null;
    this.movements = [];
    return result;
  }

  async dailySummary(): Promise<{ cashiers: CashierDaySummary[]; dayIso: string }> {
    return { cashiers: this.day, dayIso: new Date().toISOString() };
  }

  async scan(code: string): Promise<ScanResult> {
    const scale = parseScaleEan13(code);
    if (scale) {
      const product = this.products.find(
        (p) => p.scaleItemCode === scale.itemCode && p.active,
      );
      if (!product) return { kind: "not_found" };
      return scale.kind === "weight"
        ? { kind: "weighed", product, qtyMilli: scale.weightQtyMilli }
        : { kind: "priced", product, priceCents: scale.priceCents };
    }
    const product = this.products.find(
      (p) => p.barcodes.includes(code) && p.active,
    );
    return product ? { kind: "product", product } : { kind: "not_found" };
  }

  async createProduct(draft: NewProductDraft): Promise<ScanResult> {
    if (this.products.some((p) => p.barcodes.includes(draft.barcode))) {
      throw new Error(`El código ${draft.barcode} ya está asignado a otro producto`);
    }
    const product: SeedProduct = {
      id: crypto.randomUUID(),
      name: draft.name,
      categoryId: null,
      scaleItemCode: null,
      isWeighable: draft.isWeighable,
      unitPriceCents: draft.unitPriceCents,
      taxCodes: SEED_SNAPSHOT.taxCatalog.map((t) => t.code),
      active: true,
      source: "local",
      barcodes: [draft.barcode],
      stockMilli: 0,
    };
    this.products.push(product);
    return { kind: "product", product };
  }

  async receiveStock(input: ReceiveStockInput): Promise<{ stockMilli: number }> {
    const product = this.products.find((p) => p.id === input.productId);
    if (!product) throw new Error(`El producto no existe`);
    product.stockMilli += input.qtyMilli;
    return { stockMilli: product.stockMilli };
  }

  async checkout(cart: Cart, payments: PaymentInput[]): Promise<CheckoutResult> {
    if (!this.session) throw new Error("No hay un turno de caja abierto");
    const required = new Map<string, number>();
    for (const l of cart.lines) {
      required.set(l.productId, (required.get(l.productId) ?? 0) + l.qtyMilli);
    }
    for (const [productId, qtyMilli] of required) {
      const product = this.products.find((p) => p.id === productId);
      if (product && qtyMilli > product.stockMilli) {
        throw new Error(
          `Sin stock suficiente de "${product.name}". Registra la recepción primero.`,
        );
      }
    }
    const quote = quoteCart(cart, SEED_SNAPSHOT.promotions, SEED_SNAPSHOT.taxCatalog);
    const settlement = settlePayments({
      totalCents: quote.totals.totalCents,
      payments,
      cashRounding: SEED_CASH_ROUNDING,
    });
    if (settlement.status !== "paid") {
      throw new Error("El pago no cubre el total de la venta");
    }
    const saleId = crypto.randomUUID();
    for (const applied of settlement.appliedByMethod) {
      this.shiftSales.byMethod.set(
        applied.method,
        (this.shiftSales.byMethod.get(applied.method) ?? 0) + applied.appliedCents,
      );
      if (applied.method === "cash" && applied.appliedCents > 0) {
        this.movements.push({
          id: `${saleId}/cash`,
          kind: "cash_sale",
          amountCents: applied.appliedCents,
        });
      }
    }
    this.shiftSales.salesCount += 1;
    this.shiftSales.totalCents += quote.totals.totalCents;
    this.salesLog.unshift({
      id: saleId,
      createdAt: new Date().toISOString(),
      totalCents: quote.totals.totalCents,
      methods: [...new Set(payments.map((p) => p.method))],
      voidedAt: null,
    });
    this.saleDetails.set(saleId, {
      items: cart.lines.map((l) => ({ productId: l.productId, qtyMilli: l.qtyMilli })),
      cashApplied:
        settlement.appliedByMethod.find((p) => p.method === "cash")?.appliedCents ?? 0,
    });
    for (const item of cart.lines) {
      const product = this.products.find((p) => p.id === item.productId);
      if (product) product.stockMilli -= item.qtyMilli;
    }
    return { saleId, quote, settlement };
  }

  async recentSales(): Promise<RecentSale[]> {
    return this.salesLog;
  }

  async voidSale(input: {
    saleId: string;
    voidedBy: string;
    reason?: string;
  }): Promise<{ alreadyVoided: boolean }> {
    const sale = this.salesLog.find((s) => s.id === input.saleId);
    if (!sale) throw new Error("La venta no existe");
    if (sale.voidedAt) return { alreadyVoided: true };
    const detail = this.saleDetails.get(input.saleId);
    if (detail?.cashApplied && !this.session) {
      throw new Error(
        "Para anular una venta en efectivo debe haber un turno abierto (el dinero sale de la caja)",
      );
    }
    sale.voidedAt = new Date().toISOString();
    for (const item of detail?.items ?? []) {
      const product = this.products.find((p) => p.id === item.productId);
      if (product) product.stockMilli += item.qtyMilli;
    }
    if (detail && detail.cashApplied > 0) {
      this.movements.push({
        id: `${input.saleId}/void`,
        kind: "refund",
        amountCents: detail.cashApplied,
      });
    }
    this.shiftSales.salesCount -= 1;
    this.shiftSales.totalCents -= sale.totalCents;
    return { alreadyVoided: false };
  }
}
