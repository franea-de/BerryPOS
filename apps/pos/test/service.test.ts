import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addScan, EMPTY_CART, type Cart } from "../src/cart.js";
import { openPosDb } from "../src/db/connect.js";
import type { DeviceContext } from "../src/db/context.js";
import { getProductStock } from "../src/db/stock.js";
import { PosService } from "../src/service.js";

const CTX: DeviceContext = { tenantId: "t1", storeId: "s1", deviceId: "caja-1" };

const dirs: string[] = [];
function tempDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "berrypos-"));
  dirs.push(dir);
  return join(dir, "test.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PosService", () => {
  it("bootstrap seeds a fresh DB once and reuses the open session", () => {
    const service = new PosService(openPosDb(":memory:"), CTX);
    const a = service.bootstrap();
    expect(a.products.length).toBeGreaterThan(0);
    expect(a.taxCatalog.map((t) => t.code)).toContain("IVA19");

    const b = service.bootstrap();
    expect(b.cashSessionId).toBe(a.cashSessionId);
  });

  it("scan → checkout persists the sale and moves stock", () => {
    const db = openPosDb(":memory:");
    const service = new PosService(db, CTX);
    service.bootstrap();

    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, service.scan("7801234567897")); // soda 1890
    cart = addScan(cart, service.scan("7801234567897")); // 2x1 applies

    const r = service.checkout(cart, [{ method: "cash", amountCents: 2000 }]);
    expect(r.quote.totals.totalCents).toBe(1890);
    expect(r.settlement.changeCents).toBe(110);
    expect(r.quote.promotions[0]?.promotionId).toBe("2x1-soda");
    expect(getProductStock(db, "soda")).toBe(-2000);
  });

  it("registerProduct makes the code sellable immediately", () => {
    const service = new PosService(openPosDb(":memory:"), CTX);
    service.bootstrap();

    expect(service.scan("7809876543217").kind).toBe("not_found");
    const created = service.registerProduct({
      name: "Galletas surtidas",
      barcode: "7809876543217",
      unitPriceCents: 1490,
      isWeighable: false,
    });
    if (created.kind !== "product") throw new Error("expected product");

    const rescanned = service.scan("7809876543217");
    if (rescanned.kind !== "product") throw new Error("expected product");
    expect(rescanned.product.name).toBe("Galletas surtidas");
    expect(rescanned.product.source).toBe("local");
  });

  it("everything survives closing and reopening the DB file", () => {
    const file = tempDbFile();

    const firstDb = openPosDb(file);
    {
      const service = new PosService(firstDb, CTX);
      service.bootstrap();
      service.registerProduct({
        name: "Yerba mate 500g",
        barcode: "7791111111116",
        unitPriceCents: 3990,
        isWeighable: false,
      });
      let cart: Cart = EMPTY_CART;
      cart = addScan(cart, service.scan("7791111111116"));
      service.checkout(cart, [{ method: "card", amountCents: 3990 }]);
    }
    firstDb.$client.close();

    // "Restart": a brand-new connection to the same file.
    const db = openPosDb(file);
    try {
      const service = new PosService(db, CTX);
      const boot = service.bootstrap();

      const scan = service.scan("7791111111116");
      if (scan.kind !== "product") throw new Error("expected product");
      expect(scan.product.name).toBe("Yerba mate 500g");
      expect(getProductStock(db, scan.product.id)).toBe(-1000);
      // Seed must NOT re-apply over the existing catalog.
      expect(boot.products.some((p) => p.name === "Yerba mate 500g")).toBe(true);
    } finally {
      db.$client.close();
    }
  });
});
