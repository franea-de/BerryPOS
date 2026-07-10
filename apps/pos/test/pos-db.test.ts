import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import { OutboxEventSchema, type CatalogSnapshot } from "@berrypos/sync-contracts";
import * as schema from "../src/db/schema.js";
import type { DeviceContext, PosDb } from "../src/db/context.js";
import {
  addProductBarcode,
  applyCatalogSnapshot,
  createProduct,
  findProductByScan,
  getCatalogRevision,
} from "../src/db/catalog.js";
import { recordSale } from "../src/db/sales.js";
import {
  closeCashSession,
  getExpectedCash,
  openCashSession,
  recordCashMovement,
} from "../src/db/cash.js";
import { getProductStock, recordStockMovement } from "../src/db/stock.js";
import { applyPushResponse, buildPushRequest, getPendingEvents } from "../src/db/outbox.js";

const CTX: DeviceContext = { tenantId: "t1", storeId: "s1", deviceId: "caja-1" };
const SESSION_ID = "0d6a2cbe-9f7d-4a1a-8a44-aaaaaaaaaaaa";

const SNAPSHOT: CatalogSnapshot = {
  revision: 1,
  products: [
    {
      id: "soda",
      name: "Bebida 1.5L",
      categoryId: "drinks",
      barcodes: ["7801234567897"],
      isWeighable: false,
      unitPriceCents: 1190,
      taxCodes: ["IVA19"],
      active: true,
    },
    {
      id: "rice",
      name: "Arroz granel",
      barcodes: [],
      scaleItemCode: "12345",
      isWeighable: true,
      unitPriceCents: 990,
      taxCodes: ["IVA19"],
      active: true,
    },
  ],
  categories: [{ id: "drinks", name: "Bebidas" }],
  taxCatalog: [
    { code: "IVA19", name: "IVA 19%", rateBp: 1900, includedInPrice: true },
  ],
  promotions: [],
  users: [
    { id: "u1", name: "Cajera", role: "cashier", pinHash: "h", active: true },
  ],
};

function createDb(): PosDb {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  return db;
}

let db: PosDb;
beforeEach(() => {
  db = createDb();
  applyCatalogSnapshot(db, SNAPSHOT);
  openCashSession(db, CTX, {
    sessionId: SESSION_ID,
    cashierId: "u1",
    openingFloatCents: 10_000,
  });
});

describe("catalog", () => {
  it("applies a snapshot and ignores stale revisions", () => {
    expect(getCatalogRevision(db)).toBe(1);
    expect(applyCatalogSnapshot(db, SNAPSHOT)).toEqual({
      applied: false,
      revision: 1,
    });
    const r = applyCatalogSnapshot(db, {
      ...SNAPSHOT,
      revision: 2,
      categories: [],
    });
    expect(r).toEqual({ applied: true, revision: 2 });
  });

  it("resolves a regular barcode, a scale weight code, and a miss", () => {
    const direct = findProductByScan(db, "7801234567897");
    expect(direct.kind).toBe("product");

    const weighed = findProductByScan(db, "2012345015258");
    if (weighed.kind !== "weighed") throw new Error("expected weighed");
    expect(weighed.product.id).toBe("rice");
    expect(weighed.qtyMilli).toBe(1525);

    expect(findProductByScan(db, "9999999999994").kind).toBe("not_found");
  });
});

describe("product registration at the register", () => {
  const NEW_PRODUCT = {
    id: "0d6a2cbe-9f7d-4a1a-8a44-bbbbbbbbbbbb",
    name: "Galletas surtidas",
    barcode: "7809876543217",
    unitPriceCents: 1490,
    isWeighable: false,
    taxCodes: ["IVA19"],
  };

  it("registers a scanned unknown product and it becomes sellable", () => {
    expect(findProductByScan(db, NEW_PRODUCT.barcode).kind).toBe("not_found");

    const r = createProduct(db, CTX, NEW_PRODUCT);
    expect(r.alreadyExists).toBe(false);
    expect(r.product.source).toBe("local");

    const scan = findProductByScan(db, NEW_PRODUCT.barcode);
    if (scan.kind !== "product") throw new Error("expected product");
    expect(scan.product.name).toBe("Galletas surtidas");

    const event = getPendingEvents(db).find((e) => e.type === "product_created");
    if (event?.type !== "product_created") throw new Error("expected event");
    expect(event.product.barcodes).toEqual([NEW_PRODUCT.barcode]);
  });

  it("is idempotent by id and rejects a taken barcode", () => {
    createProduct(db, CTX, NEW_PRODUCT);
    expect(createProduct(db, CTX, NEW_PRODUCT).alreadyExists).toBe(true);
    expect(() =>
      createProduct(db, CTX, {
        ...NEW_PRODUCT,
        id: "0d6a2cbe-9f7d-4a1a-8a44-cccccccccccc",
        barcode: "7801234567897", // already the soda's
      }),
    ).toThrow("already assigned");
  });

  it("assigns an extra barcode to an existing product", () => {
    const r = addProductBarcode(db, CTX, {
      productId: "soda",
      barcode: "0412345678905",
    });
    expect(r.alreadyAssigned).toBe(false);
    expect(
      addProductBarcode(db, CTX, { productId: "soda", barcode: "0412345678905" })
        .alreadyAssigned,
    ).toBe(true);
    expect(() =>
      addProductBarcode(db, CTX, { productId: "rice", barcode: "0412345678905" }),
    ).toThrow("already assigned");
    expect(() =>
      addProductBarcode(db, CTX, { productId: "ghost", barcode: "0499999999996" }),
    ).toThrow("does not exist");

    const scan = findProductByScan(db, "0412345678905");
    if (scan.kind !== "product") throw new Error("expected product");
    expect(scan.product.id).toBe("soda");
  });

  it("locally registered products survive catalog snapshots", () => {
    createProduct(db, CTX, NEW_PRODUCT);
    applyCatalogSnapshot(db, { ...SNAPSHOT, revision: 2 });

    // Cloud products replaced, the local one still scans.
    expect(findProductByScan(db, NEW_PRODUCT.barcode).kind).toBe("product");
    expect(findProductByScan(db, "7801234567897").kind).toBe("product");
  });

  it("a snapshot carrying the same id supersedes the local copy", () => {
    createProduct(db, CTX, NEW_PRODUCT);
    applyCatalogSnapshot(db, {
      ...SNAPSHOT,
      revision: 2,
      products: [
        ...SNAPSHOT.products,
        {
          id: NEW_PRODUCT.id,
          name: "Galletas surtidas 250g", // cloud normalized the name
          barcodes: [NEW_PRODUCT.barcode],
          isWeighable: false,
          unitPriceCents: 1590,
          taxCodes: ["IVA19"],
          active: true,
        },
      ],
    });

    const scan = findProductByScan(db, NEW_PRODUCT.barcode);
    if (scan.kind !== "product") throw new Error("expected product");
    expect(scan.product.name).toBe("Galletas surtidas 250g");
    expect(scan.product.source).toBe("cloud");
    expect(scan.product.unitPriceCents).toBe(1590);
  });
});

describe("recordSale", () => {
  const saleParams = {
    saleId: "0d6a2cbe-9f7d-4a1a-8a44-000000000001",
    cashSessionId: SESSION_ID,
    lines: [
      {
        line: { id: "l1", qtyMilli: 2000, unitPriceCents: 1190, taxCodes: ["IVA19"] },
        productId: "soda",
      },
      {
        line: { id: "l2", qtyMilli: 1525, unitPriceCents: 990, taxCodes: ["IVA19"] },
        productId: "rice",
      },
    ],
    payments: [{ method: "cash" as const, amountCents: 5000 }],
    occurredAt: "2026-07-09T15:00:00.000Z",
  };

  it("persists sale, movements and a contract-valid outbox event atomically", () => {
    const r = recordSale(db, CTX, saleParams);
    expect(r.alreadyRecorded).toBe(false);
    expect(r.totals.totalCents).toBe(3890); // 2380 + 1510
    expect(r.settlement.changeCents).toBe(1110);

    // Stock moved: the projection reflects the sale.
    expect(getProductStock(db, "soda")).toBe(-2000);
    expect(getProductStock(db, "rice")).toBe(-1525);

    // Drawer got the applied cash: 10000 float + 3890.
    expect(getExpectedCash(db, SESSION_ID)).toBe(13_890);

    // Outbox holds session-open + sale, valid against the sync contract.
    const pending = getPendingEvents(db);
    expect(pending.map((e) => e.type)).toEqual([
      "cash_session_opened",
      "sale_completed",
    ]);
    const sale = pending[1];
    if (sale?.type !== "sale_completed") throw new Error("expected sale event");
    expect(sale.reportedTotalCents).toBe(3890);
    expect(sale.seq).toBe(1); // per-device sequence is monotonic
  });

  it("is idempotent: replaying the same saleId writes nothing new", () => {
    recordSale(db, CTX, saleParams);
    const replay = recordSale(db, CTX, saleParams);
    expect(replay.alreadyRecorded).toBe(true);

    expect(getProductStock(db, "soda")).toBe(-2000); // not doubled
    expect(getExpectedCash(db, SESSION_ID)).toBe(13_890);
    expect(getPendingEvents(db).filter((e) => e.type === "sale_completed")).toHaveLength(1);
  });

  it("rejects an underpaid sale and writes nothing", () => {
    expect(() =>
      recordSale(db, CTX, {
        ...saleParams,
        saleId: "0d6a2cbe-9f7d-4a1a-8a44-000000000002",
        payments: [{ method: "cash", amountCents: 100 }],
      }),
    ).toThrow("not fully paid");
    expect(getProductStock(db, "soda")).toBe(0);
  });

  it("splits mixed card + cash and only cash reaches the drawer", () => {
    const r = recordSale(db, CTX, {
      ...saleParams,
      saleId: "0d6a2cbe-9f7d-4a1a-8a44-000000000003",
      payments: [
        { method: "card", amountCents: 3000 },
        { method: "cash", amountCents: 1000 },
      ],
    });
    expect(r.settlement.changeCents).toBe(110);
    // Drawer: float + cash applied (890), the card never touches it.
    expect(getExpectedCash(db, SESSION_ID)).toBe(10_890);
  });
});

describe("cash session", () => {
  it("supports manual movements and blocks drawer overdrafts", () => {
    recordCashMovement(db, CTX, {
      movementId: "mv-1",
      sessionId: SESSION_ID,
      kind: "pay_out",
      amountCents: 4000,
      note: "retiro",
    });
    expect(getExpectedCash(db, SESSION_ID)).toBe(6000);

    expect(() =>
      recordCashMovement(db, CTX, {
        movementId: "mv-2",
        sessionId: SESSION_ID,
        kind: "pay_out",
        amountCents: 99_999,
      }),
    ).toThrow(RangeError);
  });

  it("closes with a blind count, freezes the Z and rejects reuse", () => {
    const z = closeCashSession(db, CTX, {
      sessionId: SESSION_ID,
      countedCents: 9_500,
    });
    expect(z.expectedCents).toBe(10_000);
    expect(z.overShortCents).toBe(-500);

    expect(() =>
      recordCashMovement(db, CTX, {
        movementId: "mv-3",
        sessionId: SESSION_ID,
        kind: "pay_in",
        amountCents: 100,
      }),
    ).toThrow("already closed");

    const closed = getPendingEvents(db).find(
      (e) => e.type === "cash_session_closed",
    );
    expect(closed).toBeDefined();
  });
});

describe("stock movements", () => {
  it("records a reception idempotently and projects stock", () => {
    const params = {
      movementId: "rcv-1",
      productId: "rice",
      kind: "reception" as const,
      qtyMilli: 25_000,
    };
    expect(recordStockMovement(db, CTX, params).alreadyRecorded).toBe(false);
    expect(recordStockMovement(db, CTX, params).alreadyRecorded).toBe(true);
    expect(getProductStock(db, "rice")).toBe(25_000);
  });
});

describe("outbox sync flow", () => {
  it("pushes pending events and clears accepted + duplicates, keeps rejected", () => {
    recordStockMovement(db, CTX, {
      movementId: "rcv-1",
      productId: "rice",
      kind: "reception",
      qtyMilli: 25_000,
    });

    const request = buildPushRequest(db);
    if (!request) throw new Error("expected pending events");
    expect(request.events).toHaveLength(2);
    for (const e of request.events) OutboxEventSchema.parse(e);

    const [first, second] = request.events.map((e) => e.eventId);
    const r = applyPushResponse(db, {
      accepted: [first as string],
      duplicates: [],
      rejected: [{ eventId: second as string, reason: "total mismatch" }],
    });
    expect(r.cleared).toBe(1);
    expect(r.rejected).toHaveLength(1);

    // Only the rejected one is still pending.
    const remaining = getPendingEvents(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.eventId).toBe(second);

    // A retry acked as duplicate clears it too.
    applyPushResponse(db, {
      accepted: [],
      duplicates: [second as string],
      rejected: [],
    });
    expect(buildPushRequest(db)).toBeNull();
  });
});
