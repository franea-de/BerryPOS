import { asc, inArray, isNull } from "drizzle-orm";
import {
  OutboxEventSchema,
  type SyncPushRequest,
  type SyncPushResponse,
} from "@berrypos/sync-contracts";
import { nowIso, type DbLike, type PosDb } from "./context.js";
import { outbox } from "./schema.js";

/** Events not yet acknowledged by the cloud, in per-device causal order. */
export function getPendingEvents(db: DbLike, limit = 100) {
  return db
    .select()
    .from(outbox)
    .where(isNull(outbox.syncedAt))
    .orderBy(asc(outbox.deviceSeq))
    .limit(limit)
    .all()
    .map((row) => OutboxEventSchema.parse(row.payload));
}

export function buildPushRequest(db: DbLike, limit = 100): SyncPushRequest | null {
  const events = getPendingEvents(db, limit);
  return events.length > 0 ? { events } : null;
}

/**
 * Apply the cloud's answer to a push. Accepted AND duplicate events clear
 * (a duplicate means an earlier push landed but its ack was lost); rejected
 * events stay pending for review — they are returned so the caller can alert.
 */
export function applyPushResponse(
  db: PosDb,
  response: SyncPushResponse,
): { cleared: number; rejected: SyncPushResponse["rejected"] } {
  const clearedIds = [...response.accepted, ...response.duplicates];
  if (clearedIds.length > 0) {
    db.update(outbox)
      .set({ syncedAt: nowIso() })
      .where(inArray(outbox.eventId, clearedIds))
      .run();
  }
  return { cleared: clearedIds.length, rejected: response.rejected };
}
