import { describe, expect, it } from "vitest";
import { computeSaleTotals, settlePayments } from "@berrypos/domain";
import {
  CatalogSnapshotSchema,
  OutboxEventSchema,
  SyncPullResponseSchema,
  SyncPushRequestSchema,
  SyncPushResponseSchema,
  SYNC_SCHEMA_VERSION,
} from "../src/index.js";

const envelope = {
  eventId: "0d6a2cbe-9f7d-4a1a-8a44-111111111111",
  tenantId: "t1",
  storeId: "s1",
  deviceId: "caja-1",
  seq: 42,
  occurredAt: "2026-07-09T14:30:00.000Z",
  schemaVersion: SYNC_SCHEMA_VERSION,
} as const;

const SALE_EVENT = {
  ...envelope,
  type: "sale_completed",
  saleId: "0d6a2cbe-9f7d-4a1a-8a44-222222222222",
  cashSessionId: "0d6a2cbe-9f7d-4a1a-8a44-333333333333",
  sale: {
    lines: [
      { id: "l1", qtyMilli: 2000, unitPriceCents: 1190, taxCodes: ["IVA19"] },
    ],
    taxCatalog: [
      { code: "IVA19", name: "IVA 19%", rateBp: 1900, includedInPrice: true },
    ],
  },
  payments: [{ method: "cash", amountCents: 3000 }],
  reportedTotalCents: 2380,
} as const;

describe("outbox events", () => {
  it("accepts a valid sale_completed event", () => {
    const parsed = OutboxEventSchema.parse(SALE_EVENT);
    expect(parsed.type).toBe("sale_completed");
  });

  it("the cloud can reproduce the reported total from the payload", () => {
    const event = OutboxEventSchema.parse(SALE_EVENT);
    if (event.type !== "sale_completed") throw new Error("unreachable");
    const totals = computeSaleTotals(event.sale);
    expect(totals.totalCents).toBe(event.reportedTotalCents);
    const settlement = settlePayments({
      totalCents: totals.totalCents,
      payments: event.payments,
    });
    expect(settlement.status).toBe("paid");
    expect(settlement.changeCents).toBe(620);
  });

  it("rejects a wrong schema version and a non-UUID event id", () => {
    expect(() =>
      OutboxEventSchema.parse({ ...SALE_EVENT, schemaVersion: 2 }),
    ).toThrow();
    expect(() =>
      OutboxEventSchema.parse({ ...SALE_EVENT, eventId: "not-a-uuid" }),
    ).toThrow();
  });

  it("accepts cash session lifecycle events", () => {
    const opened = OutboxEventSchema.parse({
      ...envelope,
      type: "cash_session_opened",
      cashSessionId: "0d6a2cbe-9f7d-4a1a-8a44-333333333333",
      cashierId: "u1",
      openingFloatCents: 10_000,
    });
    expect(opened.type).toBe("cash_session_opened");

    const closed = OutboxEventSchema.parse({
      ...envelope,
      eventId: "0d6a2cbe-9f7d-4a1a-8a44-444444444444",
      type: "cash_session_closed",
      cashSessionId: "0d6a2cbe-9f7d-4a1a-8a44-333333333333",
      cashierId: "u1",
      close: {
        movements: [
          { id: "m1", kind: "opening_float", amountCents: 10_000 },
          { id: "m2", kind: "cash_sale", amountCents: 2380 },
        ],
        countedCents: 12_380,
      },
    });
    expect(closed.type).toBe("cash_session_closed");
  });

  it("push request requires at least one event; response buckets are UUIDs", () => {
    expect(() => SyncPushRequestSchema.parse({ events: [] })).toThrow();
    const res = SyncPushResponseSchema.parse({
      accepted: [envelope.eventId],
      duplicates: [],
      rejected: [
        {
          eventId: "0d6a2cbe-9f7d-4a1a-8a44-555555555555",
          reason: "reported total mismatch",
        },
      ],
    });
    expect(res.accepted).toHaveLength(1);
  });
});

describe("downstream catalog", () => {
  const snapshot = {
    revision: 7,
    products: [
      {
        id: "p1",
        name: "Arroz granel",
        barcodes: [],
        scaleItemCode: "12345",
        isWeighable: true,
        unitPriceCents: 990,
        taxCodes: ["IVA19"],
        active: true,
      },
    ],
    categories: [{ id: "c1", name: "Abarrotes" }],
    taxCatalog: [
      { code: "IVA19", name: "IVA 19%", rateBp: 1900, includedInPrice: true },
    ],
    promotions: [
      {
        id: "vol-rice",
        name: "Arroz x mayor",
        type: "volume_price",
        productIds: ["p1"],
        minQtyMilli: 2000,
        unitPriceCents: 890,
      },
    ],
    users: [
      { id: "u1", name: "Cajera 1", role: "cashier", pinHash: "x", active: true },
    ],
  };

  it("accepts a full snapshot and both pull responses", () => {
    expect(CatalogSnapshotSchema.parse(snapshot).revision).toBe(7);
    expect(
      SyncPullResponseSchema.parse({ status: "snapshot", snapshot }).status,
    ).toBe("snapshot");
    expect(
      SyncPullResponseSchema.parse({ status: "up_to_date", revision: 7 }).status,
    ).toBe("up_to_date");
  });

  it("rejects a malformed scale item code", () => {
    expect(() =>
      CatalogSnapshotSchema.parse({
        ...snapshot,
        products: [{ ...snapshot.products[0], scaleItemCode: "123" }],
      }),
    ).toThrow();
  });
});
