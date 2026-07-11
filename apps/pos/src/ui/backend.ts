import {
  parseScaleEan13,
  settlePayments,
  type PaymentInput,
} from "@berrypos/domain";
import { quoteCart, type Cart } from "../cart.js";
import { SEED_CASH_ROUNDING, SEED_SNAPSHOT } from "../catalog-seed.js";
import type { ScanResult } from "../db/catalog.js";
import type {
  BootstrapData,
  CheckoutResult,
  NewProductDraft,
  ProductSummary,
} from "../service.js";

export type { BootstrapData, CheckoutResult, NewProductDraft, ProductSummary };

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
    stockMilli: 0,
  }));

  async bootstrap(): Promise<BootstrapData> {
    return {
      products: this.products,
      taxCatalog: SEED_SNAPSHOT.taxCatalog,
      promotions: SEED_SNAPSHOT.promotions,
      cashSessionId: "demo-session",
      cashRounding: SEED_CASH_ROUNDING,
    };
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
    const quote = quoteCart(cart, SEED_SNAPSHOT.promotions, SEED_SNAPSHOT.taxCatalog);
    const settlement = settlePayments({
      totalCents: quote.totals.totalCents,
      payments,
      cashRounding: SEED_CASH_ROUNDING,
    });
    if (settlement.status !== "paid") {
      throw new Error("El pago no cubre el total de la venta");
    }
    return { saleId: crypto.randomUUID(), quote, settlement };
  }
}
