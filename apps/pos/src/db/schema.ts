import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Local SQLite schema of the POS — the store's source of truth
 * (ARCHITECTURE.md §2). Two zones:
 *
 * - Master data (products, taxes, promotions, users): replaced atomically by
 *   downstream catalog snapshots, versioned in `sync_state`.
 * - Facts (sales, movements, sessions, outbox): append-only, client UUIDs as
 *   primary keys so every write is idempotent (CLAUDE.md rules #2 and #3).
 */

export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ---------- Master data (owned by the cloud, LWW by revision) ----------

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    categoryId: text("category_id"),
    /** 5-digit code embedded by the scale, when the product is weighed. */
    scaleItemCode: text("scale_item_code"),
    isWeighable: integer("is_weighable", { mode: "boolean" }).notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    taxCodes: text("tax_codes", { mode: "json" }).$type<string[]>().notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    /**
     * "cloud" rows are replaced by catalog snapshots; "local" rows were
     * registered at this device and survive snapshots until the cloud
     * adopts them (a snapshot carrying the same id supersedes).
     */
    source: text("source", { enum: ["cloud", "local"] })
      .notNull()
      .default("cloud"),
  },
  (t) => [index("idx_products_scale_code").on(t.scaleItemCode)],
);

export const productBarcodes = sqliteTable("product_barcodes", {
  barcode: text("barcode").primaryKey(),
  productId: text("product_id").notNull(),
});

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

export const taxes = sqliteTable("taxes", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  rateBp: integer("rate_bp").notNull(),
  includedInPrice: integer("included_in_price", { mode: "boolean" }).notNull(),
});

export const promotions = sqliteTable("promotions", {
  id: text("id").primaryKey(),
  /** Whole PromotionInput as JSON; the domain schema is the contract. */
  data: text("data", { mode: "json" }).notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  pinHash: text("pin_hash").notNull(),
  active: integer("active", { mode: "boolean" }).notNull(),
});

// ---------- Facts (append-only, produced by this device) ----------

export const cashSessions = sqliteTable("cash_sessions", {
  id: text("id").primaryKey(),
  cashierId: text("cashier_id").notNull(),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
  countedCents: integer("counted_cents"),
  expectedCents: integer("expected_cents"),
  overShortCents: integer("over_short_cents"),
});

export const cashMovements = sqliteTable(
  "cash_movements",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    kind: text("kind").notNull(),
    amountCents: integer("amount_cents").notNull(),
    saleId: text("sale_id"),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_cash_movements_session").on(t.sessionId)],
);

export const sales = sqliteTable("sales", {
  id: text("id").primaryKey(),
  cashSessionId: text("cash_session_id").notNull(),
  createdAt: text("created_at").notNull(),
  totalCents: integer("total_cents").notNull(),
  /** What the customer actually owed after cash rounding. */
  dueCents: integer("due_cents").notNull(),
  changeCents: integer("change_cents").notNull(),
  cashRoundingCents: integer("cash_rounding_cents").notNull(),
  /** Full input (sale + payments) for audit and event replay. */
  input: text("input", { mode: "json" }).notNull(),
});

export const saleLines = sqliteTable(
  "sale_lines",
  {
    id: text("id").notNull(),
    saleId: text("sale_id").notNull(),
    productId: text("product_id").notNull(),
    qtyMilli: integer("qty_milli").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    grossCents: integer("gross_cents").notNull(),
    discountCents: integer("discount_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    taxCodes: text("tax_codes", { mode: "json" }).$type<string[]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.saleId, t.id] })],
);

export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    saleId: text("sale_id").notNull(),
    method: text("method").notNull(),
    /** Tendered amount (change is on the sale row). */
    amountCents: integer("amount_cents").notNull(),
  },
  (t) => [index("idx_payments_sale").on(t.saleId)],
);

export const stockMovements = sqliteTable(
  "stock_movements",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    kind: text("kind").notNull(),
    qtyMilli: integer("qty_milli").notNull(),
    saleId: text("sale_id"),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_stock_movements_product").on(t.productId)],
);

/**
 * Events waiting to be pushed to the cloud. `deviceSeq` is the per-device
 * monotonic sequence stamped into the envelope (sync_state key "device_seq").
 */
export const outbox = sqliteTable("outbox", {
  eventId: text("event_id").primaryKey(),
  deviceSeq: integer("device_seq").notNull().unique(),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
  syncedAt: text("synced_at"),
});
