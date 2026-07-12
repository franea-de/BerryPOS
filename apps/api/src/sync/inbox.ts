import { sql } from "drizzle-orm";
import { computeSaleTotals } from "@berrypos/domain";
import {
  SyncPushRequestSchema,
  type SyncPushResponse,
} from "@berrypos/sync-contracts";
import { inboxEvents } from "../db/schema.js";
import type { ApiDb } from "../db/client.js";

export interface DeviceIdentity {
  tenantId: string;
  storeId: string;
  deviceId: string;
}

/**
 * The cloud half of the sync protocol (ARCHITECTURE.md §3): an idempotent
 * inbox. Every event is validated against the shared contract, verified
 * (the cloud must reproduce the totals the POS reported — a mismatch is a
 * rejection, never a silent discrepancy) and inserted exactly once: the
 * client-generated event id is the primary key, so a retry after a lost
 * ack simply reports "duplicate" and the register clears its outbox.
 */
export class SyncInbox {
  constructor(private readonly db: ApiDb) {}

  async push(identity: DeviceIdentity, body: unknown): Promise<SyncPushResponse> {
    const { events } = SyncPushRequestSchema.parse(body);

    const accepted: string[] = [];
    const duplicates: string[] = [];
    const rejected: Array<{ eventId: string; reason: string }> = [];

    await this.db.transaction(async (tx) => {
      // Scope the whole transaction to the authenticated tenant (RLS).
      await tx.execute(
        sql`select set_config('app.tenant_id', ${identity.tenantId}, true)`,
      );

      for (const event of events) {
        // The envelope must match the credentials that pushed it.
        if (
          event.tenantId !== identity.tenantId ||
          event.storeId !== identity.storeId ||
          event.deviceId !== identity.deviceId
        ) {
          rejected.push({
            eventId: event.eventId,
            reason: "envelope does not match the device credentials",
          });
          continue;
        }

        if (event.type === "sale_completed") {
          const totals = computeSaleTotals(event.sale);
          if (totals.totalCents !== event.reportedTotalCents) {
            rejected.push({
              eventId: event.eventId,
              reason: `reported total mismatch: cloud computed ${totals.totalCents}, POS reported ${event.reportedTotalCents}`,
            });
            continue;
          }
        }

        const inserted = await tx
          .insert(inboxEvents)
          .values({
            eventId: event.eventId,
            tenantId: event.tenantId,
            storeId: event.storeId,
            deviceId: event.deviceId,
            deviceSeq: event.seq,
            type: event.type,
            payload: event,
            occurredAt: event.occurredAt,
          })
          .onConflictDoNothing({ target: inboxEvents.eventId })
          .returning({ eventId: inboxEvents.eventId });

        if (inserted.length > 0) {
          accepted.push(event.eventId);
        } else {
          duplicates.push(event.eventId);
        }
      }
    });

    return { accepted, duplicates, rejected };
  }
}
