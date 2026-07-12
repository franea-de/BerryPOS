import { and, desc, eq, gte, sql } from "drizzle-orm";
import { cloudSales, tenants } from "../db/schema.js";
import type { ApiDb } from "../db/client.js";

/**
 * Tenant-scoped reporting over the cloud_sales projection. Every query runs
 * in a transaction with app.tenant_id set, so RLS guarantees the panel can
 * only ever see its own tenant — even if a query here had a bug.
 */
export class CloudReports {
  constructor(private readonly db: ApiDb) {}

  /** Rebuild the projection from the inbox (idempotent; runs at boot). */
  async backfill(): Promise<void> {
    const allTenants = await this.db.select({ id: tenants.id }).from(tenants);
    for (const tenant of allTenants) {
      await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenant.id}, true)`,
        );
        await tx.execute(sql`
          INSERT INTO cloud_sales
            (sale_id, tenant_id, store_id, device_id, total_cents, occurred_at, payment_methods, voided)
          SELECT
            payload->>'saleId', tenant_id, store_id, device_id,
            (payload->>'reportedTotalCents')::int, occurred_at,
            COALESCE((SELECT jsonb_agg(DISTINCT p->>'method')
                        FROM jsonb_array_elements(payload->'payments') p), '[]'::jsonb),
            false
          FROM inbox_events
          WHERE type = 'sale_completed'
          ON CONFLICT (sale_id) DO NOTHING
        `);
        await tx.execute(sql`
          UPDATE cloud_sales SET voided = true
          WHERE voided = false AND sale_id IN (
            SELECT payload->>'saleId' FROM inbox_events WHERE type = 'sale_voided'
          )
        `);
      });
    }
  }

  /** Today's totals (per store) for the dashboard header. */
  async summary(tenantId: string) {
    const dayStart = startOfTodayIso();
    return this.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({
          storeId: cloudSales.storeId,
          salesCount: sql<number>`count(*)::int`,
          totalCents: sql<number>`coalesce(sum(${cloudSales.totalCents}), 0)::int`,
        })
        .from(cloudSales)
        .where(
          and(
            eq(cloudSales.voided, false),
            gte(cloudSales.occurredAt, dayStart),
          ),
        )
        .groupBy(cloudSales.storeId);
      return {
        dayStartIso: dayStart,
        stores: rows,
        totalCents: rows.reduce((a, r) => a + r.totalCents, 0),
        salesCount: rows.reduce((a, r) => a + r.salesCount, 0),
      };
    });
  }

  /** Daily totals for the last N days (newest first). */
  async daily(tenantId: string, days = 14) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    return this.withTenant(tenantId, (tx) =>
      tx
        .select({
          day: sql<string>`substr(${cloudSales.occurredAt}, 1, 10)`,
          salesCount: sql<number>`count(*)::int`,
          totalCents: sql<number>`coalesce(sum(${cloudSales.totalCents}), 0)::int`,
        })
        .from(cloudSales)
        .where(
          and(
            eq(cloudSales.voided, false),
            gte(cloudSales.occurredAt, since.toISOString()),
          ),
        )
        .groupBy(sql`substr(${cloudSales.occurredAt}, 1, 10)`)
        .orderBy(desc(sql`substr(${cloudSales.occurredAt}, 1, 10)`)),
    );
  }

  /** Latest sales, voided included (marked), for the activity feed. */
  async recent(tenantId: string, limit = 20) {
    return this.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(cloudSales)
        .orderBy(desc(cloudSales.occurredAt))
        .limit(limit),
    );
  }

  private withTenant<T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<ApiDb["transaction"]>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true)`,
      );
      return fn(tx);
    });
  }
}

function startOfTodayIso(): string {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).toISOString();
}
