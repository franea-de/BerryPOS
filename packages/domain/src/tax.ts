import { z } from "zod";
import {
  applyBp,
  assertSafeInt,
  cents,
  roundHalfAwayFromZero,
  type BasisPoints,
  type Cents,
} from "./money.js";

/**
 * Tax definitions are data, not code: each country/tenant configures its own
 * catalog (IVA 19%, IGV 18%, exempt 0%, ...). LatAm retail prices are usually
 * tax-inclusive (`includedInPrice: true`); B2B lines can be exclusive.
 */
export const TaxDefinitionSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  rateBp: z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .transform((n) => n as BasisPoints),
  includedInPrice: z.boolean(),
});
export type TaxDefinition = z.output<typeof TaxDefinitionSchema>;
/** Boundary shape (plain numbers) accepted wherever a catalog is parsed. */
export type TaxDefinitionInput = z.input<typeof TaxDefinitionSchema>;

export interface TaxAmount {
  code: string;
  baseCents: Cents;
  taxCents: Cents;
}

/** Tax charged ON TOP of a tax-exclusive base. */
export function computeExclusiveTax(baseCents: Cents, rateBp: BasisPoints): Cents {
  return applyBp(baseCents, rateBp);
}

/**
 * Split a tax-INCLUSIVE gross amount into base + one entry per tax, such that
 * base + sum(taxes) === gross exactly (any rounding residue lands on the
 * highest-rate tax, deterministically).
 */
export function splitIncludedTaxes(
  grossCents: Cents,
  taxes: readonly TaxDefinition[],
): { baseCents: Cents; taxes: TaxAmount[] } {
  assertSafeInt(grossCents, "grossCents");
  if (taxes.length === 0) return { baseCents: grossCents, taxes: [] };

  const totalRateBp = taxes.reduce((a, t) => a + t.rateBp, 0);
  const baseCents = cents(
    roundHalfAwayFromZero((grossCents * 10_000) / (10_000 + totalRateBp)),
  );

  const amounts = taxes.map((t) => ({
    code: t.code,
    baseCents,
    taxCents: applyBp(baseCents, t.rateBp),
  }));

  // Reconcile so the parts sum exactly to gross.
  const residue =
    grossCents - baseCents - amounts.reduce((a, t) => a + t.taxCents, 0);
  if (residue !== 0) {
    const target = amounts.reduce((max, t, i, arr) =>
      t.taxCents > (arr[max] as TaxAmount).taxCents ? i : max, 0);
    const hit = amounts[target] as TaxAmount;
    hit.taxCents = cents(hit.taxCents + residue);
  }
  return { baseCents, taxes: amounts };
}

/** Aggregate per-line tax amounts into a per-code breakdown, preserving first-seen order. */
export function aggregateTaxes(lines: readonly TaxAmount[][]): TaxAmount[] {
  const byCode = new Map<string, TaxAmount>();
  for (const line of lines) {
    for (const t of line) {
      const agg = byCode.get(t.code);
      if (agg) {
        agg.baseCents = cents(agg.baseCents + t.baseCents);
        agg.taxCents = cents(agg.taxCents + t.taxCents);
      } else {
        byCode.set(t.code, { ...t });
      }
    }
  }
  return [...byCode.values()];
}
