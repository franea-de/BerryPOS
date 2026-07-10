import { z } from "zod";
import { cents, sumCents, type Cents } from "./money.js";

/**
 * Cash drawer session as an append-only ledger (CLAUDE.md rule #2).
 *
 * A session is a sequence of movements; the drawer balance is a projection
 * over them, never a stored value. Closing performs a blind count (arqueo
 * ciego): the cashier counts without seeing the expected amount, and the
 * over/short is `counted − expected`.
 */

export const CashMovementKindSchema = z.enum([
  /** Initial float placed in the drawer when the session opens. */
  "opening_float",
  /** Net cash from a sale (tendered − change, i.e. the applied cash). */
  "cash_sale",
  /** Cash returned to a customer for a refund. */
  "refund",
  /** Cash added outside of sales (e.g. change replenishment). */
  "pay_in",
  /** Cash removed (retiro, drop to safe, supplier paid from drawer). */
  "pay_out",
]);
export type CashMovementKind = z.infer<typeof CashMovementKindSchema>;

const INFLOW: Readonly<Record<CashMovementKind, 1 | -1>> = {
  opening_float: 1,
  cash_sale: 1,
  refund: -1,
  pay_in: 1,
  pay_out: -1,
};

export const CashMovementSchema = z.object({
  /** Client-generated UUID — idempotency key for sync (CLAUDE.md rule #3). */
  id: z.string().min(1),
  kind: CashMovementKindSchema,
  /** Always positive; the kind determines the direction. */
  amountCents: z
    .number()
    .int()
    .positive()
    .transform((n) => n as Cents),
  note: z.string().optional(),
});
export type CashMovementInput = z.input<typeof CashMovementSchema>;
type CashMovement = z.output<typeof CashMovementSchema>;

/** Signed effect of a movement on the drawer. */
export function movementDelta(movement: CashMovement): Cents {
  return cents(INFLOW[movement.kind] * movement.amountCents);
}

const MovementListSchema = z.array(CashMovementSchema);

function parseMovements(input: readonly CashMovementInput[]): CashMovement[] {
  const movements = MovementListSchema.parse(input);

  const seen = new Set<string>();
  for (const m of movements) {
    if (seen.has(m.id)) {
      throw new Error(`duplicate cash movement id "${m.id}"`);
    }
    seen.add(m.id);
  }

  let balance = 0;
  for (const [i, m] of movements.entries()) {
    if (m.kind === "opening_float" && i !== 0) {
      throw new Error("opening_float must be the first movement of a session");
    }
    balance += movementDelta(m);
    if (balance < 0) {
      throw new RangeError(
        `movement "${m.id}" would leave the drawer negative (${balance})`,
      );
    }
  }
  return movements;
}

/** Expected cash in the drawer: the projection over all movements. */
export function computeExpectedCash(
  movements: readonly CashMovementInput[],
): Cents {
  return sumCents(parseMovements(movements).map(movementDelta));
}

export const CashSessionCloseInputSchema = z.object({
  movements: MovementListSchema,
  /** Blind count entered by the cashier at close. */
  countedCents: z
    .number()
    .int()
    .min(0)
    .transform((n) => n as Cents),
});
export type CashSessionCloseInput = z.input<typeof CashSessionCloseInputSchema>;

export interface CashSessionZReport {
  /** Gross amount moved per kind (always positive; direction is the kind's). */
  byKind: Record<CashMovementKind, Cents>;
  expectedCents: Cents;
  countedCents: Cents;
  /** counted − expected: positive = surplus, negative = shortage (descuadre). */
  overShortCents: Cents;
}

/** Close the session: project the expected cash and compare the blind count. */
export function closeCashSession(input: CashSessionCloseInput): CashSessionZReport {
  const { countedCents } = CashSessionCloseInputSchema.parse(input);
  const movements = parseMovements(input.movements);

  const byKind = Object.fromEntries(
    CashMovementKindSchema.options.map((k) => [k, cents(0)]),
  ) as Record<CashMovementKind, Cents>;
  for (const m of movements) {
    byKind[m.kind] = cents(byKind[m.kind] + m.amountCents);
  }

  const expectedCents = sumCents(movements.map(movementDelta));
  return {
    byKind,
    expectedCents,
    countedCents,
    overShortCents: cents(countedCents - expectedCents),
  };
}
