import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import type { PromotionInput, TaxDefinitionInput } from "@berrypos/domain";
import type { CatalogSnapshot } from "@berrypos/sync-contracts";
import * as schema from "../src/db/schema.js";
import type { DeviceContext, PosDb } from "../src/db/context.js";
import { applyCatalogSnapshot, findProductByScan } from "../src/db/catalog.js";
import { openCashSession } from "../src/db/cash.js";
import { recordSale } from "../src/db/sales.js";
import {
  addScan,
  EMPTY_CART,
  quoteCart,
  removeLine,
  toRecordSaleParams,
  updateLine,
  type Cart,
} from "../src/cart.js";

const CTX: DeviceContext = { tenantId: "t1", storeId: "s1", deviceId: "caja-1" };
const SESSION_ID = "0d6a2cbe-9f7d-4a1a-8a44-aaaaaaaaaaaa";

const TAXES: TaxDefinitionInput[] = [
  { code: "IVA19", name: "IVA 19%", rateBp: 1900, includedInPrice: true },
];

const PROMOS: PromotionInput[] = [
  {
    id: "2x1-soda",
    name: "2x1 bebidas",
    type: "nxm",
    productIds: ["soda"],
    buyQty: 2,
    payQty: 1,
  },
];

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
  taxCatalog: TAXES,
  promotions: PROMOS,
  users: [],
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

describe("cart building", () => {
  it("merges repeated unit scans into one line", () => {
    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, findProductByScan(db, "7801234567897"));
    cart = addScan(cart, findProductByScan(db, "7801234567897"));
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.qtyMilli).toBe(2000);
  });

  it("keeps every scale weighing as its own line", () => {
    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, findProductByScan(db, "2012345015258")); // 1.525 kg
    cart = addScan(cart, findProductByScan(db, "2012345015258"));
    expect(cart.lines).toHaveLength(2);
    expect(cart.lines.every((l) => l.fromScale)).toBe(true);
  });

  it("ignores a not_found scan and supports edit/remove", () => {
    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, { kind: "not_found" });
    expect(cart.lines).toHaveLength(0);

    cart = addScan(cart, findProductByScan(db, "7801234567897"));
    const id = cart.lines[0]?.lineId as string;
    cart = updateLine(cart, id, { qtyMilli: 5000 });
    expect(cart.lines[0]?.qtyMilli).toBe(5000);
    cart = removeLine(cart, id);
    expect(cart.lines).toHaveLength(0);
  });
});

describe("quoteCart", () => {
  it("prices the cart with live promotions", () => {
    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, findProductByScan(db, "7801234567897"));
    cart = addScan(cart, findProductByScan(db, "7801234567897"));

    const quote = quoteCart(cart, PROMOS, TAXES);
    // 2 sodas at 1190 = 2380, minus one free (2x1) = 1190.
    expect(quote.totals.grossCents).toBe(2380);
    expect(quote.totals.totalCents).toBe(1190);
    expect(quote.promotions[0]?.promotionId).toBe("2x1-soda");
  });
});

describe("checkout", () => {
  it("freezes the quoted cart and records it end to end", () => {
    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, findProductByScan(db, "7801234567897"));
    cart = addScan(cart, findProductByScan(db, "7801234567897"));
    cart = addScan(cart, findProductByScan(db, "2012345015258"));

    const quote = quoteCart(cart, PROMOS, TAXES);
    const params = toRecordSaleParams(cart, PROMOS, {
      saleId: "0d6a2cbe-9f7d-4a1a-8a44-000000000009",
      cashSessionId: SESSION_ID,
      payments: [{ method: "cash", amountCents: 5000 }],
    });
    const r = recordSale(db, CTX, params);

    // What was persisted is exactly what was quoted: 1190 (2x1) + 1510.
    expect(r.totals.totalCents).toBe(quote.totals.totalCents);
    expect(r.totals.totalCents).toBe(2700);
    expect(r.settlement.changeCents).toBe(2300);
  });

  it("refuses an empty cart", () => {
    expect(() =>
      toRecordSaleParams(EMPTY_CART, [], {
        saleId: "0d6a2cbe-9f7d-4a1a-8a44-000000000010",
        cashSessionId: SESSION_ID,
        payments: [],
      }),
    ).toThrow("empty cart");
  });
});
