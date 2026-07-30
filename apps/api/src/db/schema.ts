import {
  boolean,
  index,
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

export const tenants = pgTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Token the admin panel sends as x-admin-token. */
    adminToken: text("admin_token"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("idx_tenants_admin_token").on(t.adminToken)],
);

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
/**
 * Reporting projection derived exclusively from inbox_events (rebuildable
 * at any time). One row per sale; voids flip the flag, never delete.
 */
export const cloudSales = pgTable("cloud_sales", {
  saleId: text("sale_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  storeId: text("store_id").notNull(),
  deviceId: text("device_id").notNull(),
  totalCents: integer("total_cents").notNull(),
  occurredAt: text("occurred_at").notNull(),
  paymentMethods: jsonb("payment_methods").$type<string[]>().notNull(),
  voided: boolean("voided").notNull().default(false),
});

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

// ---------- Master data (owned by the cloud, RLS enabled) ----------

export const cloudCategories = pgTable(
  "cloud_categories",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const cloudProducts = pgTable(
  "cloud_products",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    categoryId: text("category_id"),
    scaleItemCode: text("scale_item_code"),
    isWeighable: boolean("is_weighable").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    taxCodes: jsonb("tax_codes").$type<string[]>().notNull(),
    active: boolean("active").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index("idx_cloud_products_scale_code").on(t.scaleItemCode),
  ],
);

export const cloudProductBarcodes = pgTable(
  "cloud_product_barcodes",
  {
    tenantId: text("tenant_id").notNull(),
    barcode: text("barcode").notNull(),
    productId: text("product_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.barcode] })],
);

export const cloudTaxes = pgTable(
  "cloud_taxes",
  {
    tenantId: text("tenant_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    rateBp: integer("rate_bp").notNull(),
    includedInPrice: boolean("included_in_price").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.code] })],
);

export const cloudPromotions = pgTable(
  "cloud_promotions",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    data: jsonb("data").notNull(), // contains full PromotionInput
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const cloudPosUsers = pgTable(
  "cloud_pos_users",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    pinHash: text("pin_hash").notNull(),
    active: boolean("active").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const cloudCatalogRevisions = pgTable(
  "cloud_catalog_revisions",
  {
    tenantId: text("tenant_id").primaryKey(),
    revision: integer("revision").notNull().default(0),
  }
);
