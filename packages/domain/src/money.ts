/**
 * Monetary core of BerryPOS.
 *
 * System-wide invariants (see CLAUDE.md rule #1):
 * - Money is ALWAYS an integer amount of minor units (cents): `Cents`.
 * - Quantities are ALWAYS integer milli-units: `QtyMilli` (1.525 kg -> 1525).
 * - Percentages are ALWAYS integer basis points: `BasisPoints` (7.5% -> 750).
 * - Rounding happens in exactly one place: `roundHalfAwayFromZero`.
 *
 * The three quantity kinds are branded: a plain `number` (or a value of
 * another brand) is not assignable to them, so amounts, quantities and rates
 * can't be swapped by accident. Construct them with `cents`, `qtyMilli` and
 * `basisPoints`, which also assert integer safety at runtime.
 */

declare const brand: unique symbol;
type Brand<B extends string> = { readonly [brand]: B };

/** Integer amount of minor currency units (e.g. cents). */
export type Cents = number & Brand<"Cents">;

/** Integer quantity in thousandths of a unit (1.525 kg -> 1525). */
export type QtyMilli = number & Brand<"QtyMilli">;

/** Integer basis points: 100 bp = 1%, 10_000 bp = 100%. */
export type BasisPoints = number & Brand<"BasisPoints">;

export function assertSafeInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer, got ${value}`);
  }
}

export function cents(value: number): Cents {
  assertSafeInt(value, "Cents");
  return value as Cents;
}

export function qtyMilli(value: number): QtyMilli {
  assertSafeInt(value, "QtyMilli");
  return value as QtyMilli;
}

export function basisPoints(value: number): BasisPoints {
  assertSafeInt(value, "BasisPoints");
  return value as BasisPoints;
}

/**
 * The single rounding point of the whole system.
 * Half away from zero: 2.5 -> 3, -2.5 -> -3.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Line amount for a quantity: unitPrice × qty / 1000, rounded. */
export function mulQty(unitPriceCents: Cents, qty: QtyMilli): Cents {
  assertSafeInt(unitPriceCents, "unitPriceCents");
  assertSafeInt(qty, "qty");
  return cents(roundHalfAwayFromZero((unitPriceCents * qty) / 1000));
}

/** Portion of an amount expressed in basis points: amount × bp / 10000, rounded. */
export function applyBp(amountCents: Cents, bp: BasisPoints): Cents {
  assertSafeInt(amountCents, "amountCents");
  assertSafeInt(bp, "bp");
  return cents(roundHalfAwayFromZero((amountCents * bp) / 10_000));
}

/**
 * Split `total` across `weights` proportionally so the parts sum EXACTLY to
 * `total` (largest-remainder method). Used to allocate order-level discounts
 * across lines without losing or inventing cents.
 *
 * `total` and all weights must be >= 0. A zero weight sum splits equally.
 */
export function allocateProportional(
  total: Cents,
  weights: readonly number[],
): Cents[] {
  assertSafeInt(total, "total");
  if (total < 0) throw new RangeError(`total must be >= 0, got ${total}`);
  if (weights.length === 0) return [];
  for (const [i, w] of weights.entries()) {
    assertSafeInt(w, `weights[${i}]`);
    if (w < 0) throw new RangeError(`weights[${i}] must be >= 0, got ${w}`);
  }

  const weightSum = weights.reduce((a, b) => a + b, 0);
  const exact =
    weightSum === 0
      ? weights.map(() => total / weights.length)
      : weights.map((w) => (total * w) / weightSum);

  const shares = exact.map(Math.floor);
  let remainder = total - shares.reduce((a, b) => a + b, 0);

  // Hand out leftover cents to the largest fractional parts (index as tiebreak
  // so the result is deterministic).
  const byFraction = exact
    .map((v, i) => ({ frac: v - Math.floor(v), i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of byFraction) {
    if (remainder <= 0) break;
    shares[i] = (shares[i] ?? 0) + 1;
    remainder -= 1;
  }
  return shares.map(cents);
}

/** Sum of cent amounts. */
export function sumCents(values: readonly Cents[]): Cents {
  return cents(values.reduce<number>((a, b) => a + b, 0));
}

export type RoundingMode = "nearest" | "up" | "down";

/**
 * Round an amount to a multiple of `unitCents`. This is cash rounding for
 * currencies whose smallest circulating coin is bigger than the minor unit
 * (e.g. round to 10 or 50 when there are no 1-cent coins). `nearest` uses the
 * system-wide half-away-from-zero rule.
 */
export function roundToUnit(
  amountCents: Cents,
  unitCents: number,
  mode: RoundingMode = "nearest",
): Cents {
  assertSafeInt(amountCents, "amountCents");
  assertSafeInt(unitCents, "unitCents");
  if (unitCents <= 0) {
    throw new RangeError(`unitCents must be > 0, got ${unitCents}`);
  }
  const ratio = amountCents / unitCents;
  const units =
    mode === "nearest"
      ? roundHalfAwayFromZero(ratio)
      : mode === "up"
        ? Math.ceil(ratio)
        : Math.floor(ratio);
  return cents(units * unitCents);
}
