import {
  parseScaleEan13,
  settlePayments,
  type CashRounding,
  type PaymentInput,
  type PromotionInput,
  type Settlement,
  type TaxDefinitionInput,
} from "@berrypos/domain";
import { quoteCart, type Cart, type CartQuote } from "../cart.js";
import type { ScanResult } from "../db/catalog.js";

/**
 * What the sale screen needs from the world. The Tauri build will provide an
 * implementation backed by the local SQLite layer (recordSale et al.); the
 * browser dev build uses the in-memory demo below so the UI can be exercised
 * without a desktop shell.
 */
export interface PosBackend {
  readonly taxCatalog: TaxDefinitionInput[];
  readonly promotions: PromotionInput[];
  readonly cashRounding?: CashRounding;
  scan(code: string): ScanResult;
  /** Quote + settle + persist. Throws if the tender doesn't cover the total. */
  checkout(cart: Cart, payments: PaymentInput[]): CheckoutResult;
}

export interface CheckoutResult {
  saleId: string;
  quote: CartQuote;
  settlement: Settlement;
}

interface DemoProduct {
  id: string;
  name: string;
  categoryId?: string;
  barcodes: string[];
  scaleItemCode?: string;
  isWeighable: boolean;
  unitPriceCents: number;
  taxCodes: string[];
  active: boolean;
}

const DEMO_PRODUCTS: DemoProduct[] = [
  { id: "soda", name: "Bebida cola 1.5L", categoryId: "bebidas", barcodes: ["7801234567897"], isWeighable: false, unitPriceCents: 1890, taxCodes: ["IVA19"], active: true },
  { id: "bread", name: "Pan de molde", categoryId: "abarrotes", barcodes: ["7802345678904"], isWeighable: false, unitPriceCents: 2290, taxCodes: ["IVA19"], active: true },
  { id: "milk", name: "Leche entera 1L", categoryId: "lacteos", barcodes: ["7803456789011"], isWeighable: false, unitPriceCents: 1190, taxCodes: ["IVA19"], active: true },
  { id: "rice", name: "Arroz granel (kg)", categoryId: "abarrotes", barcodes: [], scaleItemCode: "12345", isWeighable: true, unitPriceCents: 1690, taxCodes: ["IVA19"], active: true },
  { id: "tomato", name: "Tomate (kg)", categoryId: "verduras", barcodes: [], scaleItemCode: "20001", isWeighable: true, unitPriceCents: 2490, taxCodes: ["IVA19"], active: true },
  { id: "chips", name: "Papas fritas 200g", categoryId: "snacks", barcodes: ["7804567890128"], isWeighable: false, unitPriceCents: 2590, taxCodes: ["IVA19"], active: true },
];

const DEMO_TAXES: TaxDefinitionInput[] = [
  { code: "IVA19", name: "IVA 19%", rateBp: 1900, includedInPrice: true },
];

const DEMO_PROMOTIONS: PromotionInput[] = [
  { id: "2x1-soda", name: "2x1 bebidas cola", type: "nxm", productIds: ["soda"], buyQty: 2, payQty: 1 },
  { id: "vol-rice", name: "Arroz desde 2 kg a $1.490", type: "volume_price", productIds: ["rice"], minQtyMilli: 2000, unitPriceCents: 1490 },
  { id: "snacks-10", name: "10% snacks", type: "category_percent", categoryIds: ["snacks"], valueBp: 1000 },
];

/** Browser demo: same domain engines, catalog and receipts kept in memory. */
export class MemoryBackend implements PosBackend {
  readonly taxCatalog = DEMO_TAXES;
  readonly promotions = DEMO_PROMOTIONS;
  readonly receipts: CheckoutResult[] = [];
  /** The demo products, exposed for the quick-pick buttons. */
  readonly products = DEMO_PRODUCTS;

  scan(code: string): ScanResult {
    const scale = parseScaleEan13(code);
    if (scale) {
      const product = DEMO_PRODUCTS.find(
        (p) => p.scaleItemCode === scale.itemCode && p.active,
      );
      if (!product) return { kind: "not_found" };
      return scale.kind === "weight"
        ? { kind: "weighed", product: toRow(product), qtyMilli: scale.weightQtyMilli }
        : { kind: "priced", product: toRow(product), priceCents: scale.priceCents };
    }
    const product = DEMO_PRODUCTS.find(
      (p) => p.barcodes.includes(code) && p.active,
    );
    return product
      ? { kind: "product", product: toRow(product) }
      : { kind: "not_found" };
  }

  checkout(cart: Cart, payments: PaymentInput[]): CheckoutResult {
    const quote = quoteCart(cart, this.promotions, this.taxCatalog);
    const settlement = settlePayments({
      totalCents: quote.totals.totalCents,
      payments,
    });
    if (settlement.status !== "paid") {
      throw new Error("El pago no cubre el total de la venta");
    }
    const result: CheckoutResult = {
      saleId: crypto.randomUUID(),
      quote,
      settlement,
    };
    this.receipts.push(result);
    return result;
  }
}

function toRow(p: DemoProduct): Extract<ScanResult, { kind: "product" }>["product"] {
  return {
    id: p.id,
    name: p.name,
    categoryId: p.categoryId ?? null,
    scaleItemCode: p.scaleItemCode ?? null,
    isWeighable: p.isWeighable,
    unitPriceCents: p.unitPriceCents,
    taxCodes: p.taxCodes,
    active: p.active,
  };
}
