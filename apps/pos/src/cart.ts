import {
  computeSaleTotals,
  evaluatePromotions,
  type CartLineInput,
  type DiscountSpec,
  type PromotionApplication,
  type PromotionInput,
  type SaleTotals,
  type TaxDefinitionInput,
} from "@berrypos/domain";
import type { ScanResult } from "./db/catalog.js";
import type { RecordSaleParams } from "./db/sales.js";

/**
 * The sale-in-progress. Pure and immutable: every operation returns a new
 * cart, so the UI is a dumb renderer and undo is trivial. Money never gets
 * computed here — quoting delegates to the domain engines.
 */

export interface CartLine {
  lineId: string;
  productId: string;
  name: string;
  categoryId?: string;
  qtyMilli: number;
  unitPriceCents: number;
  taxCodes: string[];
  /** Lines created by a scale barcode never merge with unit lines. */
  fromScale: boolean;
  manualDiscount?: DiscountSpec;
}

export interface Cart {
  lines: readonly CartLine[];
  orderDiscount?: DiscountSpec;
}

export const EMPTY_CART: Cart = { lines: [] };

/**
 * Turn a scan into cart lines. Unit products merge into their existing line
 * (+1 unit); weighed/priced scale items always append a new line — two
 * bags of rice are two different weighings.
 */
export function addScan(cart: Cart, scan: ScanResult): Cart {
  if (scan.kind === "not_found") return cart;
  const { product } = scan;

  if (scan.kind === "product") {
    const existing = cart.lines.find(
      (l) => l.productId === product.id && !l.fromScale && !l.manualDiscount,
    );
    if (existing) {
      return updateLine(cart, existing.lineId, {
        qtyMilli: existing.qtyMilli + 1000,
      });
    }
  }

  const line: CartLine = {
    lineId: crypto.randomUUID(),
    productId: product.id,
    name: product.name,
    ...(product.categoryId ? { categoryId: product.categoryId } : {}),
    qtyMilli: scan.kind === "weighed" ? scan.qtyMilli : 1000,
    // A price-embedded barcode fixes the LINE total: model it as one unit
    // at that price so the domain math stays exact.
    unitPriceCents:
      scan.kind === "priced" ? scan.priceCents : product.unitPriceCents,
    taxCodes: product.taxCodes,
    fromScale: scan.kind !== "product",
  };
  return { ...cart, lines: [...cart.lines, line] };
}

export function updateLine(
  cart: Cart,
  lineId: string,
  patch: Partial<Pick<CartLine, "qtyMilli" | "manualDiscount">>,
): Cart {
  return {
    ...cart,
    lines: cart.lines.map((l) =>
      l.lineId === lineId ? { ...l, ...patch } : l,
    ),
  };
}

export function removeLine(cart: Cart, lineId: string): Cart {
  return { ...cart, lines: cart.lines.filter((l) => l.lineId !== lineId) };
}

export function setOrderDiscount(
  cart: Cart,
  discount: DiscountSpec | undefined,
): Cart {
  const { orderDiscount: _, ...rest } = cart;
  return discount ? { ...rest, orderDiscount: discount } : { ...rest };
}

export interface CartQuote {
  totals: SaleTotals;
  promotions: PromotionApplication[];
}

/** Price the cart right now: promotions first, then the totals engine. */
export function quoteCart(
  cart: Cart,
  promotions: PromotionInput[],
  taxCatalog: TaxDefinitionInput[],
): CartQuote {
  const evaluated = evaluatePromotions({
    lines: cart.lines.map(toCartLineInput),
    promotions,
  });
  const totals = computeSaleTotals({
    lines: evaluated.lines,
    ...(cart.orderDiscount ? { orderDiscount: cart.orderDiscount } : {}),
    taxCatalog,
  });
  return { totals, promotions: evaluated.applications };
}

/**
 * Freeze the cart into the parameters recordSale persists. The promotion
 * evaluation is re-run here so what is stored is exactly what was quoted.
 */
export function toRecordSaleParams(
  cart: Cart,
  promotions: PromotionInput[],
  args: {
    saleId: string;
    cashSessionId: string;
    payments: RecordSaleParams["payments"];
    cashRounding?: RecordSaleParams["cashRounding"];
    occurredAt?: string;
  },
): RecordSaleParams {
  if (cart.lines.length === 0) throw new Error("cannot check out an empty cart");
  const evaluated = evaluatePromotions({
    lines: cart.lines.map(toCartLineInput),
    promotions,
  });
  const productByLine = new Map(cart.lines.map((l) => [l.lineId, l.productId]));
  return {
    saleId: args.saleId,
    cashSessionId: args.cashSessionId,
    lines: evaluated.lines.map((line) => {
      const productId = productByLine.get(line.id);
      if (!productId) throw new Error("unreachable: line without product");
      return { line, productId };
    }),
    ...(cart.orderDiscount ? { orderDiscount: cart.orderDiscount } : {}),
    payments: args.payments,
    ...(args.cashRounding ? { cashRounding: args.cashRounding } : {}),
    ...(args.occurredAt ? { occurredAt: args.occurredAt } : {}),
  };
}

function toCartLineInput(line: CartLine): CartLineInput {
  return {
    id: line.lineId,
    productId: line.productId,
    ...(line.categoryId ? { categoryId: line.categoryId } : {}),
    qtyMilli: line.qtyMilli,
    unitPriceCents: line.unitPriceCents,
    taxCodes: line.taxCodes,
    ...(line.manualDiscount ? { manualDiscount: line.manualDiscount } : {}),
  };
}
