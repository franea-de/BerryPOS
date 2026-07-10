import { z } from "zod";
import {
  CashMovementSchema,
  CashSessionCloseInputSchema,
  PaymentInputSchema,
  SaleInputSchema,
  StockMovementSchema,
} from "@berrypos/domain";
import { EventEnvelopeSchema } from "./envelope.js";

/**
 * Store → cloud events (the outbox). Payloads reuse the domain schemas so
 * the contract can never drift from what the domain actually computes.
 *
 * The cloud re-runs `computeSaleTotals`/`settlePayments` on the reported
 * inputs and rejects the event if its own numbers disagree with
 * `reportedTotalCents` — the ticket and the cloud can never tell different
 * stories silently.
 */

export const SaleCompletedSchema = EventEnvelopeSchema.extend({
  type: z.literal("sale_completed"),
  /** Sale id (client UUID) shared by the stock/cash movements it caused. */
  saleId: z.uuid(),
  cashSessionId: z.uuid(),
  sale: SaleInputSchema,
  payments: z.array(PaymentInputSchema).min(1),
  /** Grand total the POS charged; the cloud must reproduce it exactly. */
  reportedTotalCents: z.number().int().min(0),
});

export const StockMovementRecordedSchema = EventEnvelopeSchema.extend({
  type: z.literal("stock_movement_recorded"),
  movement: StockMovementSchema,
  /** Present when the movement was caused by a sale/refund. */
  saleId: z.uuid().optional(),
});

export const CashMovementRecordedSchema = EventEnvelopeSchema.extend({
  type: z.literal("cash_movement_recorded"),
  cashSessionId: z.uuid(),
  movement: CashMovementSchema,
  saleId: z.uuid().optional(),
});

export const CashSessionOpenedSchema = EventEnvelopeSchema.extend({
  type: z.literal("cash_session_opened"),
  cashSessionId: z.uuid(),
  cashierId: z.string().min(1),
  openingFloatCents: z.number().int().min(0),
});

export const CashSessionClosedSchema = EventEnvelopeSchema.extend({
  type: z.literal("cash_session_closed"),
  cashSessionId: z.uuid(),
  cashierId: z.string().min(1),
  /** Movements + blind count; the cloud recomputes the Z report from them. */
  close: CashSessionCloseInputSchema,
});

export const OutboxEventSchema = z.discriminatedUnion("type", [
  SaleCompletedSchema,
  StockMovementRecordedSchema,
  CashMovementRecordedSchema,
  CashSessionOpenedSchema,
  CashSessionClosedSchema,
]);
export type OutboxEvent = z.input<typeof OutboxEventSchema>;

/** Push request: a batch of events in per-device `seq` order. */
export const SyncPushRequestSchema = z.object({
  events: z.array(OutboxEventSchema).min(1),
});
export type SyncPushRequest = z.input<typeof SyncPushRequestSchema>;

/**
 * Push response. `duplicates` are events the inbox had already applied
 * (a retry after a lost ack) — the POS treats them exactly like `accepted`
 * and clears them from its outbox. Only `rejected` stays for review.
 */
export const SyncPushResponseSchema = z.object({
  accepted: z.array(z.uuid()),
  duplicates: z.array(z.uuid()),
  rejected: z.array(
    z.object({
      eventId: z.uuid(),
      reason: z.string().min(1),
    }),
  ),
});
export type SyncPushResponse = z.input<typeof SyncPushResponseSchema>;
