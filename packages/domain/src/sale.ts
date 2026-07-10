import { z } from "zod";
import {
  allocateProportional,
  applyBp,
  cents,
  mulQty,
  sumCents,
  type BasisPoints,
  type Cents,
  type QtyMilli,
} from "./money.js";
import {
  aggregateTaxes,
  computeExclusiveTax,
  splitIncludedTaxes,
  TaxDefinitionSchema,
  type TaxAmount,
  type TaxDefinition,
} from "./tax.js";

/**
 * Pure sale-total computation. This is THE pricing engine: POS, API and admin
 * all call this — never reimplement totals anywhere else (CLAUDE.md rule #4).
 *
 * Boundary rule: the exported input types (`SaleInput`, `SaleLineInput`,
 * `DiscountSpec`) are plain-number shapes — callers build them from JSON/forms.
 * Parsing brands them (`Cents`/`QtyMilli`/`BasisPoints`), and everything the
 * engine returns is branded.
 */

export const DiscountSpecSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("percent"),
    valueBp: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .transform((n) => n as BasisPoints),
  }),
  z.object({
    type: z.literal("fixed"),
    amountCents: z
      .number()
      .int()
      .min(0)
      .transform((n) => n as Cents),
  }),
]);
export type DiscountSpec = z.input<typeof DiscountSpecSchema>;
type ParsedDiscountSpec = z.output<typeof DiscountSpecSchema>;

export const SaleLineInputSchema = z.object({
  /** Client-generated UUID — idempotency key for sync (CLAUDE.md rule #3). */
  id: z.string().min(1),
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
  discount: DiscountSpecSchema.optional(),
  taxCodes: z.array(z.string().min(1)),
});
export type SaleLineInput = z.input<typeof SaleLineInputSchema>;

export const SaleInputSchema = z.object({
  lines: z.array(SaleLineInputSchema).min(1),
  orderDiscount: DiscountSpecSchema.optional(),
  taxCatalog: z.array(TaxDefinitionSchema),
});
export type SaleInput = z.input<typeof SaleInputSchema>;

export interface SaleLineTotals {
  id: string;
  /** unitPrice × qty, before any discount. */
  grossCents: Cents;
  lineDiscountCents: Cents;
  /** This line's allocated share of the order-level discount. */
  orderDiscountCents: Cents;
  /** gross − discounts. Tax-inclusive when the line's taxes are included-in-price. */
  netCents: Cents;
  taxes: TaxAmount[];
  /** net + exclusive taxes: what the customer pays for this line. */
  totalCents: Cents;
}

export interface SaleTotals {
  lines: SaleLineTotals[];
  grossCents: Cents;
  discountCents: Cents;
  netCents: Cents;
  taxCents: Cents;
  /** Grand total payable: sum of line totals, exact to the cent. */
  totalCents: Cents;
  taxBreakdown: TaxAmount[];
}

/** A discount can never exceed what it applies to. */
function discountAmount(base: Cents, spec: ParsedDiscountSpec | undefined): Cents {
  if (!spec || base <= 0) return cents(0);
  const raw = spec.type === "percent" ? applyBp(base, spec.valueBp) : spec.amountCents;
  return cents(Math.min(raw, base));
}

export function computeSaleTotals(input: SaleInput): SaleTotals {
  const sale = SaleInputSchema.parse(input);
  const catalog = new Map<string, TaxDefinition>(
    sale.taxCatalog.map((t) => [t.code, t]),
  );

  const gross = sale.lines.map((l) => mulQty(l.unitPriceCents, l.qtyMilli));
  const lineDiscounts = sale.lines.map((l, i) =>
    discountAmount(gross[i] as Cents, l.discount),
  );
  const afterLineDiscount = gross.map((g, i) =>
    cents(g - (lineDiscounts[i] as Cents)),
  );

  // Order-level discount is computed on the discounted subtotal, then spread
  // across lines proportionally without losing a cent.
  const subtotal = sumCents(afterLineDiscount);
  const orderDiscountTotal = discountAmount(subtotal, sale.orderDiscount);
  const orderDiscounts = allocateProportional(orderDiscountTotal, afterLineDiscount);

  const lines: SaleLineTotals[] = sale.lines.map((l, i) => {
    const netCents = cents(
      (afterLineDiscount[i] as Cents) - (orderDiscounts[i] as Cents),
    );

    const defs = l.taxCodes.map((code) => {
      const def = catalog.get(code);
      if (!def) throw new Error(`Unknown tax code "${code}" on line "${l.id}"`);
      return def;
    });
    const included = defs.filter((d) => d.includedInPrice);
    const exclusive = defs.filter((d) => !d.includedInPrice);

    const taxes: TaxAmount[] = [...splitIncludedTaxes(netCents, included).taxes];
    let exclusiveTotal = 0;
    for (const d of exclusive) {
      const taxCents = computeExclusiveTax(netCents, d.rateBp);
      taxes.push({ code: d.code, baseCents: netCents, taxCents });
      exclusiveTotal += taxCents;
    }

    return {
      id: l.id,
      grossCents: gross[i] as Cents,
      lineDiscountCents: lineDiscounts[i] as Cents,
      orderDiscountCents: orderDiscounts[i] as Cents,
      netCents,
      taxes,
      totalCents: cents(netCents + exclusiveTotal),
    };
  });

  return {
    lines,
    grossCents: sumCents(gross),
    discountCents: cents(sumCents(lineDiscounts) + orderDiscountTotal),
    netCents: sumCents(lines.map((l) => l.netCents)),
    taxCents: cents(
      lines.reduce((a, l) => a + l.taxes.reduce((s, t) => s + t.taxCents, 0), 0),
    ),
    totalCents: sumCents(lines.map((l) => l.totalCents)),
    taxBreakdown: aggregateTaxes(lines.map((l) => l.taxes)),
  };
}
