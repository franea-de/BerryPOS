import { z } from "zod";

/**
 * Sync protocol v1 (see docs/ARCHITECTURE.md §3).
 *
 * Every store event travels inside an envelope. The pair
 * (`deviceId`, `seq`) gives causal order per device; `eventId` is the
 * idempotency key the cloud inbox dedups on. Events are immutable facts:
 * the protocol has no update or delete.
 */

export const SYNC_SCHEMA_VERSION = 1;

export const EventEnvelopeSchema = z.object({
  /** Client-generated UUID — THE dedup key (CLAUDE.md rule #3). */
  eventId: z.uuid(),
  tenantId: z.string().min(1),
  storeId: z.string().min(1),
  /** The POS device that produced the event. */
  deviceId: z.string().min(1),
  /** Per-device monotonic sequence; gives causal order on replay. */
  seq: z.number().int().min(0),
  /** Device wall clock, informative only — ordering uses `seq`. */
  occurredAt: z.iso.datetime(),
  schemaVersion: z.literal(SYNC_SCHEMA_VERSION),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
