import { z } from "zod";
import {
  cents,
  roundToUnit,
  sumCents,
  type Cents,
} from "./money.js";

/**
 * Settlement of a sale total against one or more payments (multi-pago).
 *
 * Rules:
 * - Non-cash payments (card/transfer/credit) apply at face value and can
 *   never exceed the total — there is no change on a card.
 * - Cash covers whatever remains. Change comes exclusively from cash.
 * - Cash rounding (for currencies without small coins) applies only to the
 *   portion actually due in cash, never to card/transfer/credit amounts.
 *   The signed difference is reported so it can be posted to a rounding
 *   ledger account.
 * - Underpayment is not an error: the result reports `status: "partial"` and
 *   the outstanding amount, so the POS can drive an incremental tender flow
 *   by recomputing with the full payment list each time.
 */

/** "wallet" = digital wallet QR payments (Yape/Plin in Peru). */
export const PaymentMethodSchema = z.enum([
  "cash",
  "card",
  "wallet",
  "transfer",
  "credit",
]);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const PaymentInputSchema = z.object({
  method: PaymentMethodSchema,
  /** Amount tendered. For cash it may exceed what is due (change is returned). */
  amountCents: z
    .number()
    .int()
    .positive()
    .transform((n) => n as Cents),
});
export type PaymentInput = z.input<typeof PaymentInputSchema>;

export const CashRoundingSchema = z.object({
  /** Smallest cash denomination in minor units (e.g. 10, 50, 100). 1 = no-op. */
  unitCents: z.number().int().min(1),
  mode: z.enum(["nearest", "up", "down"]).default("nearest"),
});
export type CashRounding = z.input<typeof CashRoundingSchema>;

export const SettlementInputSchema = z.object({
  totalCents: z
    .number()
    .int()
    .min(0)
    .transform((n) => n as Cents),
  payments: z.array(PaymentInputSchema),
  cashRounding: CashRoundingSchema.optional(),
});
export type SettlementInput = z.input<typeof SettlementInputSchema>;

export interface AppliedPayment {
  method: PaymentMethod;
  /** Portion of the tender that actually pays the sale (tender − change for cash). */
  appliedCents: Cents;
}

export interface Settlement {
  totalCents: Cents;
  /** What the customer effectively owes after cash rounding (== total otherwise). */
  dueCents: Cents;
  /** Signed: due − total. Positive = customer pays extra, negative = merchant absorbs. */
  cashRoundingCents: Cents;
  /** Everything handed over, all methods. */
  tenderedCents: Cents;
  /** Cash returned to the customer. */
  changeCents: Cents;
  /** Remaining amount when the tender doesn't cover the due. */
  outstandingCents: Cents;
  status: "paid" | "partial";
  appliedByMethod: AppliedPayment[];
}

export function settlePayments(input: SettlementInput): Settlement {
  const { totalCents, payments, cashRounding } =
    SettlementInputSchema.parse(input);

  const nonCash = payments.filter((p) => p.method !== "cash");
  const nonCashTotal = sumCents(nonCash.map((p) => p.amountCents));
  if (nonCashTotal > totalCents) {
    throw new RangeError(
      `non-cash payments (${nonCashTotal}) exceed the total (${totalCents}); change can only be given on cash`,
    );
  }

  const cashTendered = sumCents(
    payments.filter((p) => p.method === "cash").map((p) => p.amountCents),
  );

  // Cash rounding applies only when cash actually participates.
  const remainder = cents(totalCents - nonCashTotal);
  const dueRemainder =
    cashTendered > 0 && cashRounding
      ? roundToUnit(remainder, cashRounding.unitCents, cashRounding.mode)
      : remainder;
  const dueCents = cents(nonCashTotal + dueRemainder);

  const cashApplied = cents(Math.min(cashTendered, dueRemainder));
  const changeCents = cents(cashTendered - cashApplied);
  const outstandingCents = cents(dueRemainder - cashApplied);

  const appliedByMethod: AppliedPayment[] = nonCash.map((p) => ({
    method: p.method,
    appliedCents: p.amountCents,
  }));
  if (cashTendered > 0) {
    appliedByMethod.push({ method: "cash", appliedCents: cashApplied });
  }

  return {
    totalCents,
    dueCents,
    cashRoundingCents: cents(dueCents - totalCents),
    tenderedCents: cents(nonCashTotal + cashTendered),
    changeCents,
    outstandingCents,
    status: outstandingCents === 0 ? "paid" : "partial",
    appliedByMethod,
  };
}
