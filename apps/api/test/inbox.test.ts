import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SYNC_SCHEMA_VERSION } from "@berrypos/sync-contracts";
import { createDb, type ApiDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import {
  cloudSales,
  devices,
  inboxEvents,
  stores,
  tenants,
  cloudCatalogRevisions,
  cloudCategories,
  cloudProducts,
  cloudProductBarcodes,
} from "../src/db/schema.js";
import { CloudReports } from "../src/reports/reports.js";
import { SyncInbox } from "../src/sync/inbox.js";

// Tests run in their own database so they never clobber dev data.
const ADMIN_URL = (
  process.env.DATABASE_ADMIN_URL ??
  "postgres://postgres:berrypos@127.0.0.1:5434/berrypos"
).replace(/\/[^/]+$/, "/berrypos_test");
const APP_URL = (
  process.env.DATABASE_URL ??
  "postgres://berrypos_app:BerryPOS_Secure_1234_App!@127.0.0.1:5434/berrypos"
).replace(/\/[^/]+$/, "/berrypos_test");

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
const E4 = "0d6a2cbe-9f7d-4a1a-8a44-aaaaaaaaaaa4";

let adminPool: pg.Pool;
let adminDb: ReturnType<typeof drizzle<typeof schema>>;
let app: { db: ApiDb; pool: pg.Pool };
let inbox: SyncInbox;

beforeAll(async () => {
  // Create the test database (idempotent), then migrate it.
  const bootstrapPool = new pg.Pool({
    connectionString: ADMIN_URL.replace(/\/[^/]+$/, "/postgres"),
  });
  const exists = await bootstrapPool.query(
    "SELECT 1 FROM pg_database WHERE datname = 'berrypos_test'",
  );
  if (exists.rowCount === 0) {
    await bootstrapPool.query("CREATE DATABASE berrypos_test");
  }
  await bootstrapPool.end();

  adminPool = new pg.Pool({ connectionString: ADMIN_URL });
  adminDb = drizzle(adminPool, { schema });
  await migrate(adminDb, { migrationsFolder: "drizzle" });
  app = createDb(APP_URL);
  inbox = new SyncInbox(app.db);
});

beforeEach(async () => {
  await adminDb.delete(cloudSales);
  await adminDb.delete(inboxEvents);
  await adminDb.delete(devices);
  await adminDb.delete(stores);
  await adminDb.delete(tenants);
  await adminDb.insert(tenants).values([
    { id: "t-a", name: "Tenant A", adminToken: "token-a" },
    { id: "t-b", name: "Tenant B", adminToken: "token-b" },
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

  it("projects sales into cloud_sales and voids flip the flag", async () => {
    const now = new Date().toISOString();
    await inbox.push(IDENTITY, {
      events: [{ ...saleEvent(E1, 0), occurredAt: now }],
    });

    const reports = new CloudReports(app.db);
    const summary = await reports.summary("t-a");
    expect(summary.salesCount).toBe(1);
    expect(summary.totalCents).toBe(850);
    expect(summary.stores[0]).toMatchObject({ storeId: "s-1", totalCents: 850 });

    // Void arrives later: the sale drops out of the totals but stays listed.
    await inbox.push(IDENTITY, {
      events: [
        {
          ...envelope(E2, 1),
          type: "sale_voided" as const,
          saleId: "0d6a2cbe-9f7d-4a1a-8a44-000000000001",
          voidedBy: "admin",
        },
      ],
    });
    const after = await reports.summary("t-a");
    expect(after.salesCount).toBe(0);
    const recent = await reports.recent("t-a");
    expect(recent[0]?.voided).toBe(true);

    // The other tenant sees nothing of this.
    expect((await reports.summary("t-b")).salesCount).toBe(0);
  });

  it("backfill rebuilds the projection from raw inbox rows", async () => {
    const now = new Date().toISOString();
    // Simulate an event that predates the projection (raw insert as admin).
    const event = { ...saleEvent(E3, 5), occurredAt: now };
    await adminDb.insert(inboxEvents).values({
      eventId: E3,
      tenantId: "t-a",
      storeId: "s-1",
      deviceId: "caja-1",
      deviceSeq: 5,
      type: "sale_completed",
      payload: event,
      occurredAt: now,
    });

    const reports = new CloudReports(app.db);
    await reports.backfill();
    await reports.backfill(); // idempotent

    const summary = await reports.summary("t-a");
    expect(summary.salesCount).toBe(1);
    expect(summary.totalCents).toBe(850);
    const daily = await reports.daily("t-a");
    expect(daily[0]?.totalCents).toBe(850);
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

  it("projects product_created and product_barcode_added events into cloud catalog and increments revision", async () => {
    await adminDb.insert(cloudCatalogRevisions).values({ tenantId: "t-a", revision: 10 }).onConflictDoUpdate({ target: cloudCatalogRevisions.tenantId, set: { revision: 10 } });

    const createEvt = {
      ...envelope(E3, 0),
      type: "product_created" as const,
      product: {
        id: "p-test-1",
        name: "New Local Prod",
        isWeighable: false,
        unitPriceCents: 500,
        taxCodes: ["IGV18"],
        active: true,
        barcodes: ["9999999999999"],
      },
    };

    const r1 = await inbox.push(IDENTITY, { events: [createEvt] });
    expect(r1.accepted).toHaveLength(1);

    // Verify projected in cloudProducts
    const [p] = await adminDb.select().from(cloudProducts).where(eq(cloudProducts.id, "p-test-1"));
    expect(p).toBeDefined();
    expect(p?.name).toBe("New Local Prod");

    // Verify projected in cloudProductBarcodes
    const [b] = await adminDb.select().from(cloudProductBarcodes).where(eq(cloudProductBarcodes.barcode, "9999999999999"));
    expect(b).toBeDefined();
    expect(b?.productId).toBe("p-test-1");

    // Verify catalog revision incremented from 10 to 11
    const [rev1] = await adminDb.select().from(cloudCatalogRevisions).where(eq(cloudCatalogRevisions.tenantId, "t-a"));
    expect(rev1?.revision).toBe(11);

    // Test barcode addition
    const addBarcodeEvt = {
      ...envelope(E4, 1),
      type: "product_barcode_added" as const,
      productId: "p-test-1",
      barcode: "8888888888888",
    };

    const r2 = await inbox.push(IDENTITY, { events: [addBarcodeEvt] });
    expect(r2.accepted).toHaveLength(1);

    // Verify barcode registered
    const [b2] = await adminDb.select().from(cloudProductBarcodes).where(eq(cloudProductBarcodes.barcode, "8888888888888"));
    expect(b2).toBeDefined();

    // Verify revision incremented to 12
    const [rev2] = await adminDb.select().from(cloudCatalogRevisions).where(eq(cloudCatalogRevisions.tenantId, "t-a"));
    expect(rev2?.revision).toBe(12);
  });
});

describe("SyncInbox.pull", () => {
  it("returns up_to_date if the store revision matches or is newer", async () => {
    await adminDb.insert(tenants).values({ id: "t-pull-1", name: "Tenant Pull 1", adminToken: "t-pull-admin-1" }).onConflictDoNothing();
    await adminDb.insert(cloudCatalogRevisions).values({ tenantId: "t-pull-1", revision: 5 }).onConflictDoUpdate({ target: cloudCatalogRevisions.tenantId, set: { revision: 5 } });

    const result = await inbox.pull({ tenantId: "t-pull-1" }, { tenantId: "t-pull-1", storeId: "s-1", sinceRevision: 5 });
    expect(result).toEqual({ status: "up_to_date", revision: 5 });
  });

  it("returns snapshot if the cloud revision is newer", async () => {
    await adminDb.insert(tenants).values({ id: "t-pull-2", name: "Tenant Pull 2", adminToken: "t-pull-admin-2" }).onConflictDoNothing();
    await adminDb.insert(cloudCatalogRevisions).values({ tenantId: "t-pull-2", revision: 6 }).onConflictDoUpdate({ target: cloudCatalogRevisions.tenantId, set: { revision: 6 } });
    await adminDb.insert(cloudCategories).values({ tenantId: "t-pull-2", id: "c1", name: "Cat 1" }).onConflictDoNothing();
    await adminDb.insert(cloudProducts).values({ tenantId: "t-pull-2", id: "p1", name: "Prod 1", isWeighable: false, unitPriceCents: 100, taxCodes: ["IGV18"], active: true }).onConflictDoNothing();
    await adminDb.insert(cloudProductBarcodes).values({ tenantId: "t-pull-2", barcode: "12345", productId: "p1" }).onConflictDoNothing();

    const result = await inbox.pull({ tenantId: "t-pull-2" }, { tenantId: "t-pull-2", storeId: "s-1", sinceRevision: 2 });
    expect(result.status).toBe("snapshot");
    if (result.status === "snapshot") {
      expect(result.snapshot.revision).toBe(6);
      expect(result.snapshot.products).toHaveLength(1);
      expect(result.snapshot.products[0]?.name).toBe("Prod 1");
      expect(result.snapshot.products[0]?.barcodes).toEqual(["12345"]);
      expect(result.snapshot.categories).toHaveLength(1);
      expect(result.snapshot.categories[0]?.name).toBe("Cat 1");
    }
  });
});

