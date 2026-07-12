import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Cloud schema v1. Multi-tenant from migration 0001 (CLAUDE.md rule #5):
 * every tenant-scoped table carries tenant_id and gets Row-Level Security
 * (policies live in the hand-written RLS migration). The app connects as
 * the non-owner role `berrypos_app`, so policies actually apply.
 */

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const stores = pgTable(
  "stores",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const devices = pgTable(
  "devices",
  {
    tenantId: text("tenant_id").notNull(),
    storeId: text("store_id").notNull(),
    id: text("id").notNull(),
    name: text("name"),
    /** Shared secret the register sends as x-api-key. */
    apiKey: text("api_key").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    uniqueIndex("idx_devices_api_key").on(t.apiKey),
  ],
);

/**
 * The sync inbox: every store event lands here exactly once (PK on the
 * client-generated event id makes retries harmless). Projections into
 * reporting tables come later and always derive from these rows.
 */
export const inboxEvents = pgTable("inbox_events", {
  eventId: text("event_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  storeId: text("store_id").notNull(),
  deviceId: text("device_id").notNull(),
  deviceSeq: integer("device_seq").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  occurredAt: text("occurred_at").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
