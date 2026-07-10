import { z } from "zod";
import {
  applyBp,
  cents,
  mulQty,
  type BasisPoints,
  type Cents,
  type QtyMilli,
} from "./money.js";
import { DiscountSpecSchema, type SaleLineInput } from "./sale.js";

/**
 * Promotion engine. It runs BEFORE the pricing engine: it evaluates the cart,
 * decides which promotions hit which lines, and emits `SaleLineInput`s whose
 * `discount` is a fixed amount — `computeSaleTotals` stays the single place
 * where totals are computed.
 *
 * Rules:
 * - A line with a manual discount is skipped: the cashier's decision wins.
 * - Candidates apply in priority order (higher first; promotion id breaks
 *   ties deterministically). A non-stackable promotion must be alone on its
 *   line: once one applies, only stackable ones can join, and vice versa.
 * - The combined promotion discount never exceeds the line gross.
 */

const promotionBase = {
  id: z.string().min(1),
  name: z.string().min(1),
  /** Higher wins when promotions compete for the same line. */
  priority: z.number().int().default(0),
  /** Whether this promotion tolerates sharing a line with other stackables. */
  stackable: z.boolean().default(false),
};

export const PromotionSchema = z.discriminatedUnion("type", [
  /** Buy N units, pay M (2x1 = buy 2 pay 1). Whole units only. */
  z.object({
    ...promotionBase,
    type: z.literal("nxm"),
    productIds: z.array(z.string().min(1)).min(1),
    buyQty: z.number().int().min(2),
    payQty: z.number().int().min(1),
  }),
  /** Percent off every line in the given categories. */
  z.object({
    ...promotionBase,
    type: z.literal("category_percent"),
    categoryIds: z.array(z.string().min(1)).min(1),
    valueBp: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .transform((n) => n as BasisPoints),
  }),
  /** Special unit price when the line reaches a quantity threshold. */
  z.object({
    ...promotionBase,
    type: z.literal("volume_price"),
    productIds: z.array(z.string().min(1)).min(1),
    minQtyMilli: z.number().int().positive(),
    unitPriceCents: z
      .number()
      .int()
      .min(0)
      .transform((n) => n as Cents),
  }),
]);
export type PromotionInput = z.input<typeof PromotionSchema>;
type Promotion = z.output<typeof PromotionSchema>;

export const CartLineSchema = z.object({
  /** Client-generated UUID — carried through to the sale line. */
  id: z.string().min(1),
  productId: z.string().min(1),
  categoryId: z.string().min(1).optional(),
  qtyMilli: z
    .number()
    .int()
    .positive()
    .transform((n) => n as QtyMilli),
  unitPriceCents: z
    .number()
    .int()
    .min(0)
    .transform((n) => n as Cents),
  taxCodes: z.array(z.string().min(1)),
  /** Cashier-entered discount; when present, promotions skip this line. */
  manualDiscount: DiscountSpecSchema.optional(),
});
export type CartLineInput = z.input<typeof CartLineSchema>;
type CartLine = z.output<typeof CartLineSchema>;

export const PromotionEvaluationInputSchema = z.object({
  lines: z.array(CartLineSchema),
  promotions: z.array(PromotionSchema),
});
export type PromotionEvaluationInput = z.input<
  typeof PromotionEvaluationInputSchema
>;

export interface PromotionApplication {
  promotionId: string;
  promotionName: string;
  lineId: string;
  discountCents: Cents;
}

export interface PromotionEvaluation {
  /** Ready for computeSaleTotals: promo discounts baked in as fixed amounts. */
  lines: SaleLineInput[];
  applications: PromotionApplication[];
}

function lineGross(line: CartLine): Cents {
  return mulQty(line.unitPriceCents, line.qtyMilli);
}

/** Discount a single promotion produces on a line; 0 = does not apply. */
function promotionDiscount(promo: Promotion, line: CartLine): Cents {
  const gross = lineGross(line);
  switch (promo.type) {
    case "nxm": {
      if (!promo.productIds.includes(line.productId)) return cents(0);
      if (promo.payQty >= promo.buyQty) return cents(0);
      const wholeUnits = Math.floor(line.qtyMilli / 1000);
      const freeUnits =
        Math.floor(wholeUnits / promo.buyQty) * (promo.buyQty - promo.payQty);
      return cents(freeUnits * line.unitPriceCents);
    }
    case "category_percent": {
      if (!line.categoryId || !promo.categoryIds.includes(line.categoryId)) {
        return cents(0);
      }
      return applyBp(gross, promo.valueBp);
    }
    case "volume_price": {
      if (!promo.productIds.includes(line.productId)) return cents(0);
      if (line.qtyMilli < promo.minQtyMilli) return cents(0);
      const discounted = mulQty(promo.unitPriceCents, line.qtyMilli);
      return cents(Math.max(0, gross - discounted));
    }
  }
}

export function evaluatePromotions(
  input: PromotionEvaluationInput,
): PromotionEvaluation {
  const { lines, promotions } = PromotionEvaluationInputSchema.parse(input);

  const ordered = [...promotions].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );

  const applications: PromotionApplication[] = [];
  const outLines: SaleLineInput[] = lines.map((line) => {
    let promoDiscount = 0;

    if (!line.manualDiscount) {
      const gross = lineGross(line);
      let stackingState: "empty" | "exclusive" | "stackable" = "empty";
      for (const promo of ordered) {
        if (stackingState === "exclusive") break;
        if (stackingState === "stackable" && !promo.stackable) continue;

        const discount = promotionDiscount(promo, line);
        if (discount <= 0) continue;

        const capped = Math.min(discount, gross - promoDiscount);
        if (capped <= 0) break;
        promoDiscount += capped;
        applications.push({
          promotionId: promo.id,
          promotionName: promo.name,
          lineId: line.id,
          discountCents: cents(capped),
        });
        stackingState = promo.stackable ? "stackable" : "exclusive";
      }
    }

    return {
      id: line.id,
      qtyMilli: line.qtyMilli,
      unitPriceCents: line.unitPriceCents,
      taxCodes: line.taxCodes,
      ...(line.manualDiscount
        ? { discount: line.manualDiscount }
        : promoDiscount > 0
          ? { discount: { type: "fixed" as const, amountCents: promoDiscount } }
          : {}),
    };
  });

  return { lines: outLines, applications };
}
