import { sql } from "drizzle-orm";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SYNC_SCHEMA_VERSION } from "@berrypos/sync-contracts";
import { createDb, type ApiDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { devices, inboxEvents, stores, tenants } from "../src/db/schema.js";
import { SyncInbox } from "../src/sync/inbox.js";

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  "postgres://postgres:berrypos@127.0.0.1:5433/berrypos";

const IDENTITY = { tenantId: "t-a", storeId: "s-1", deviceId: "caja-1" };

function envelope(eventId: string, seq: number) {
  return {
    eventId,
    tenantId: IDENTITY.tenantId,
    storeId: IDENTITY.storeId,
    deviceId: IDENTITY.deviceId,
    seq,
    occurredAt: "2026-07-12T15:00:00.000Z",
    schemaVersion: SYNC_SCHEMA_VERSION,
  };
}

function saleEvent(eventId: string, seq: number, reportedTotalCents = 850) {
  return {
    ...envelope(eventId, seq),
    type: "sale_completed" as const,
    saleId: "0d6a2cbe-9f7d-4a1a-8a44-000000000001",
    cashSessionId: "0d6a2cbe-9f7d-4a1a-8a44-000000000002",
    sale: {
      lines: [
        { id: "l1", qtyMilli: 1000, unitPriceCents: 850, taxCodes: ["IGV18"] },
      ],
      taxCatalog: [
        { code: "IGV18", name: "IGV 18%", rateBp: 1800, includedInPrice: true },
      ],
    },
    payments: [{ method: "cash" as const, amountCents: 850 }],
    reportedTotalCents,
  };
}

const E1 = "0d6a2cbe-9f7d-4a1a-8a44-aaaaaaaaaaa1";
const E2 = "0d6a2cbe-9f7d-4a1a-8a44-aaaaaaaaaaa2";
const E3 = "0d6a2cbe-9f7d-4a1a-8a44-aaaaaaaaaaa3";

let adminPool: pg.Pool;
let adminDb: ReturnType<typeof drizzle<typeof schema>>;
let app: { db: ApiDb; pool: pg.Pool };
let inbox: SyncInbox;

beforeAll(async () => {
  adminPool = new pg.Pool({ connectionString: ADMIN_URL });
  adminDb = drizzle(adminPool, { schema });
  await migrate(adminDb, { migrationsFolder: "drizzle" });
  app = createDb();
  inbox = new SyncInbox(app.db);
});

beforeEach(async () => {
  await adminDb.delete(inboxEvents);
  await adminDb.delete(devices);
  await adminDb.delete(stores);
  await adminDb.delete(tenants);
  await adminDb.insert(tenants).values([
    { id: "t-a", name: "Tenant A" },
    { id: "t-b", name: "Tenant B" },
  ]);
  await adminDb.insert(stores).values([
    { tenantId: "t-a", id: "s-1", name: "Tienda A1" },
    { tenantId: "t-b", id: "s-1", name: "Tienda B1" },
  ]);
  await adminDb.insert(devices).values([
    { tenantId: "t-a", storeId: "s-1", id: "caja-1", apiKey: "key-a" },
    { tenantId: "t-b", storeId: "s-1", id: "caja-1", apiKey: "key-b" },
  ]);
});

afterAll(async () => {
  await app.pool.end();
  await adminPool.end();
});

describe("SyncInbox.push", () => {
  it("accepts valid events once and reports retries as duplicates", async () => {
    const request = {
      events: [
        {
          ...envelope(E1, 0),
          type: "cash_session_opened" as const,
          cashSessionId: "0d6a2cbe-9f7d-4a1a-8a44-000000000002",
          cashierId: "cajero-1",
          openingFloatCents: 10_000,
        },
        saleEvent(E2, 1),
      ],
    };

    const first = await inbox.push(IDENTITY, request);
    expect(first).toEqual({ accepted: [E1, E2], duplicates: [], rejected: [] });

    // Retry after a lost ack: nothing duplicates, nothing errors.
    const retry = await inbox.push(IDENTITY, request);
    expect(retry).toEqual({ accepted: [], duplicates: [E1, E2], rejected: [] });

    const rows = await adminDb.select().from(inboxEvents);
    expect(rows).toHaveLength(2);
  });

  it("rejects a sale whose totals the cloud cannot reproduce", async () => {
    const r = await inbox.push(IDENTITY, {
      events: [saleEvent(E1, 0, 999)], // POS "reported" a wrong total
    });
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]?.eventId).toBe(E1);
    expect(r.rejected[0]?.reason).toContain("total mismatch");
  });

  it("rejects events whose envelope doesn't match the device credentials", async () => {
    const foreign = { ...saleEvent(E1, 0), tenantId: "t-b" };
    const r = await inbox.push(IDENTITY, { events: [foreign] });
    expect(r.rejected[0]?.reason).toContain("credentials");
    expect(await adminDb.select().from(inboxEvents)).toHaveLength(0);
  });

  it("rejects malformed payloads via the shared contract", async () => {
    await expect(
      inbox.push(IDENTITY, { events: [{ nonsense: true }] }),
    ).rejects.toThrow();
  });

  it("row-level security: a tenant can never read another tenant's events", async () => {
    await inbox.push(IDENTITY, { events: [saleEvent(E1, 0)] });
    const identityB = { tenantId: "t-b", storeId: "s-1", deviceId: "caja-1" };
    await inbox.push(identityB, {
      events: [
        {
          ...envelope(E3, 0),
          tenantId: "t-b",
          type: "cash_session_opened" as const,
          cashSessionId: "0d6a2cbe-9f7d-4a1a-8a44-000000000009",
          cashierId: "cajero-1",
          openingFloatCents: 0,
        },
      ],
    });

    // Through the app role with tenant A's context, only A's rows exist.
    const visible = await app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', 't-a', true)`);
      return tx.select().from(inboxEvents);
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.tenantId).toBe("t-a");

    // Without a tenant context the app role sees nothing at all.
    const blind = await app.db.select().from(inboxEvents);
    expect(blind).toHaveLength(0);

    // The admin (owner) sees both — the data is there, just isolated.
    expect(await adminDb.select().from(inboxEvents)).toHaveLength(2);
  });
});
