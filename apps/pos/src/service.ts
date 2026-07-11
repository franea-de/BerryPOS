import { isNull } from "drizzle-orm";
import type {
  PaymentInput,
  PromotionApplication,
  PromotionInput,
  SaleTotals,
  Settlement,
  TaxDefinitionInput,
} from "@berrypos/domain";
import type { CashRounding } from "@berrypos/domain";
import { quoteCart, toRecordSaleParams, type Cart } from "./cart.js";
import { SEED_CASH_ROUNDING, SEED_SNAPSHOT } from "./catalog-seed.js";
import {
  applyCatalogSnapshot,
  createProduct,
  findProductByScan,
  getCatalogRevision,
  getPromotions,
  getTaxCatalog,
  listProducts,
  type ProductWithBarcodes,
  type ScanResult,
} from "./db/catalog.js";
import { openCashSession } from "./db/cash.js";
import { recordSale } from "./db/sales.js";
import { cashSessions } from "./db/schema.js";
import type { DeviceContext, PosDb } from "./db/context.js";

/**
 * The register's application service: everything the sale screen needs,
 * backed by the real store DB. The HTTP server is a thin JSON wrapper over
 * this class, so it stays fully testable without sockets.
 */

export interface BootstrapData {
  products: ProductWithBarcodes[];
  taxCatalog: TaxDefinitionInput[];
  promotions: PromotionInput[];
  cashSessionId: string;
  /** Store cash-rounding rule; the UI needs it for the exact-cash button. */
  cashRounding: CashRounding;
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

export class PosService {
  constructor(
    private readonly db: PosDb,
    private readonly ctx: DeviceContext,
  ) {}

  /** Seed/upgrade the base catalog, open a cash session, load everything. */
  bootstrap(): BootstrapData {
    if (getCatalogRevision(this.db) < SEED_SNAPSHOT.revision) {
      applyCatalogSnapshot(this.db, SEED_SNAPSHOT);
    }
    return {
      products: listProducts(this.db),
      taxCatalog: getTaxCatalog(this.db),
      promotions: getPromotions(this.db),
      cashSessionId: this.ensureOpenSession(),
      cashRounding: SEED_CASH_ROUNDING,
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

  /** Freeze the cart, settle the tender and persist the sale atomically. */
  checkout(cart: Cart, payments: PaymentInput[]): CheckoutResult {
    const promotions = getPromotions(this.db);
    const taxCatalog = getTaxCatalog(this.db);
    const quote = quoteCart(cart, promotions, taxCatalog);
    const params = toRecordSaleParams(cart, promotions, {
      saleId: crypto.randomUUID(),
      cashSessionId: this.ensureOpenSession(),
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

  private ensureOpenSession(): string {
    const open = this.db
      .select({ id: cashSessions.id })
      .from(cashSessions)
      .where(isNull(cashSessions.closedAt))
      .get();
    if (open) return open.id;

    const sessionId = crypto.randomUUID();
    openCashSession(this.db, this.ctx, {
      sessionId,
      cashierId: "cajero-1",
      openingFloatCents: 0,
    });
    return sessionId;
  }
}
