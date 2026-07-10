import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  OutboxEventSchema,
  SYNC_SCHEMA_VERSION,
  type OutboxEvent,
} from "@berrypos/sync-contracts";
import * as schema from "./schema.js";
import { outbox, syncState } from "./schema.js";

/**
 * The repositories are written against the better-sqlite3 driver (used by
 * tests and, later, by the Tauri sidecar). When the Tauri webview needs
 * direct access it will go through drizzle's sqlite-proxy with the same
 * schema — the repository signatures stay put.
 */
export type PosDb = BetterSQLite3Database<typeof schema>;
type TxCallback = Parameters<PosDb["transaction"]>[0];
export type PosTx = Parameters<TxCallback>[0];
export type DbLike = PosDb | PosTx;

/** Identity of this POS device; stamped into every sync envelope. */
export interface DeviceContext {
  tenantId: string;
  storeId: string;
  deviceId: string;
}

const DEVICE_SEQ_KEY = "device_seq";

/** Next per-device monotonic sequence. Call inside the writing transaction. */
export function nextDeviceSeq(tx: DbLike): number {
  const row = tx
    .select()
    .from(syncState)
    .where(eq(syncState.key, DEVICE_SEQ_KEY))
    .get();
  const next = row ? Number(row.value) + 1 : 0;
  tx.insert(syncState)
    .values({ key: DEVICE_SEQ_KEY, value: String(next) })
    .onConflictDoUpdate({
      target: syncState.key,
      set: { value: String(next) },
    })
    .run();
  return next;
}

/** Build the envelope fields for a new outbox event. */
export function buildEnvelope(
  tx: DbLike,
  ctx: DeviceContext,
  occurredAt: string,
) {
  return {
    eventId: crypto.randomUUID(),
    tenantId: ctx.tenantId,
    storeId: ctx.storeId,
    deviceId: ctx.deviceId,
    seq: nextDeviceSeq(tx),
    occurredAt,
    schemaVersion: SYNC_SCHEMA_VERSION,
  } as const;
}

/**
 * Validate against the sync contract and append. Parsing here means a
 * malformed event aborts the whole business transaction — the outbox can
 * never hold an event the cloud would reject as unreadable.
 */
export function appendOutboxEvent(tx: DbLike, event: OutboxEvent): void {
  const parsed = OutboxEventSchema.parse(event);
  tx.insert(outbox)
    .values({
      eventId: parsed.eventId,
      deviceSeq: parsed.seq,
      type: parsed.type,
      payload: parsed,
      createdAt: parsed.occurredAt,
    })
    .run();
}

export function nowIso(): string {
  return new Date().toISOString();
}
