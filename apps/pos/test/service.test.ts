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

function newService() {
  const db = openPosDb(":memory:");
  const service = new PosService(db, CTX);
  service.bootstrap();
  return { db, service };
}

function openShift(service: PosService, cashierId = "cajero-1", floatCents = 10_000) {
  return service.openShift({
    sessionId: crypto.randomUUID(),
    cashierId,
    openingFloatCents: floatCents,
  });
}

function stockUp(service: PosService, productId: string, qtyMilli: number) {
  service.receiveStock({
    movementId: crypto.randomUUID(),
    productId,
    qtyMilli,
  });
}

describe("PosService", () => {
  it("bootstrap seeds catalog and users; no shift is open by default", () => {
    const { service } = newService();
    const boot = service.bootstrap();
    expect(boot.products.length).toBeGreaterThan(0);
    expect(boot.taxCatalog.map((t) => t.code)).toContain("IGV18");
    expect(boot.cashRounding.unitCents).toBe(10);
    expect(boot.users.map((u) => u.id)).toEqual(
      expect.arrayContaining(["admin", "cajero-1"]),
    );
    expect(boot.session).toBeNull();
  });

  it("login validates the PIN and never leaks hashes in bootstrap", async () => {
    const { service } = newService();
    const user = await service.login("cajero-1", "1111");
    expect(user).toEqual({ id: "cajero-1", name: "Cajero 1", role: "cashier" });

    await expect(service.login("cajero-1", "0000")).rejects.toThrow("PIN incorrecto");
    await expect(service.login("ghost", "1111")).rejects.toThrow("PIN incorrecto");

    const boot = service.bootstrap();
    expect(JSON.stringify(boot)).not.toContain("pinHash");
  });

  it("selling requires an open shift; opening twice is rejected", () => {
    const { service } = newService();
    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, service.scan("7751234567892"));

    expect(() =>
      service.checkout(cart, [{ method: "cash", amountCents: 1000 }]),
    ).toThrow("turno");

    const session = openShift(service);
    expect(service.bootstrap().session?.id).toBe(session.id);
    expect(session.cashierName).toBe("Cajero 1");

    expect(() => openShift(service, "admin")).toThrow("Ya hay un turno abierto");
  });

  it("scan → checkout persists the sale and moves stock", () => {
    const { db, service } = newService();
    openShift(service);
    stockUp(service, "soda", 5000);

    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, service.scan("7751234567892")); // Inca Kola S/ 8.50
    cart = addScan(cart, service.scan("7751234567892")); // 2x1 applies

    const r = service.checkout(cart, [{ method: "cash", amountCents: 1000 }]);
    expect(r.quote.totals.totalCents).toBe(850);
    expect(r.settlement.changeCents).toBe(150);
    expect(r.quote.promotions[0]?.promotionId).toBe("2x1-soda");
    expect(getProductStock(db, "soda")).toBe(3000);
  });

  it("blocks a sale beyond the registered stock (store policy)", () => {
    const { service } = newService();
    openShift(service);
    stockUp(service, "soda", 1000);

    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, service.scan("7751234567892"));
    cart = addScan(cart, service.scan("7751234567892")); // 2 > 1 in stock

    expect(() =>
      service.checkout(cart, [{ method: "cash", amountCents: 2000 }]),
    ).toThrow("Sin stock suficiente");
  });

  it("cash rounds to 10 céntimos (Peru), cards pay the exact total", () => {
    const { service } = newService();
    openShift(service);
    stockUp(service, "chips", 2000);

    // Chips S/ 7.50 with 10% snacks promo -> S/ 6.75 (not a 10c multiple).
    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, service.scan("7754567890125"));

    const cash = service.checkout(cart, [{ method: "cash", amountCents: 700 }]);
    expect(cash.quote.totals.totalCents).toBe(675);
    expect(cash.settlement.dueCents).toBe(680); // 675 -> nearest 10
    expect(cash.settlement.cashRoundingCents).toBe(5);
    expect(cash.settlement.changeCents).toBe(20);

    let cart2: Cart = EMPTY_CART;
    cart2 = addScan(cart2, service.scan("7754567890125"));
    const card = service.checkout(cart2, [{ method: "card", amountCents: 675 }]);
    expect(card.settlement.dueCents).toBe(675); // no rounding without cash
    expect(card.settlement.cashRoundingCents).toBe(0);
  });

  it("closes the shift with a blind count and reports the Z + shift sales", () => {
    const { service } = newService();
    openShift(service, "cajero-1", 10_000);
    stockUp(service, "soda", 1000);

    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, service.scan("7751234567892"));
    service.checkout(cart, [
      { method: "card", amountCents: 500 },
      { method: "cash", amountCents: 350 },
    ]);
    service.cashMovement({
      movementId: crypto.randomUUID(),
      kind: "pay_out",
      amountCents: 2000,
      note: "compra de bolsas",
    });

    // Drawer: 10000 float + 350 cash − 2000 out = 8350; count 8300 → short 50.
    const r = service.closeShift({ countedCents: 8300 });
    expect(r.z.expectedCents).toBe(8350);
    expect(r.z.overShortCents).toBe(-50);
    expect(r.sales.salesCount).toBe(1);
    expect(r.sales.totalCents).toBe(850);
    expect(r.sales.byMethod).toEqual(
      expect.arrayContaining([
        { method: "card", amountCents: 500 },
        { method: "cash", amountCents: 350 },
      ]),
    );
    expect(r.cashierId).toBe("cajero-1");

    expect(service.bootstrap().session).toBeNull();
    expect(() => service.closeShift({ countedCents: 0 })).toThrow("turno");
  });

  it("daily summary groups activity per cashier", () => {
    const { service } = newService();
    stockUp(service, "soda", 1000);
    stockUp(service, "bread", 2000);

    openShift(service, "cajero-1", 5000);
    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, service.scan("7751234567892"));
    service.checkout(cart, [{ method: "cash", amountCents: 850 }]);
    service.closeShift({ countedCents: 5850 });

    openShift(service, "admin", 5000);
    let cart2: Cart = EMPTY_CART;
    cart2 = addScan(cart2, service.scan("7752345678903"));
    cart2 = addScan(cart2, service.scan("7752345678903"));
    service.checkout(cart2, [{ method: "card", amountCents: 1380 }]);

    const { cashiers } = service.dailySummary();
    const byId = new Map(cashiers.map((c) => [c.cashierId, c]));
    expect(byId.get("cajero-1")).toMatchObject({
      salesCount: 1,
      totalCents: 850,
      overShortCents: 0,
      sessionsCount: 1,
      openSessions: 0,
    });
    expect(byId.get("admin")).toMatchObject({
      salesCount: 1,
      totalCents: 1380,
      openSessions: 1,
    });
  });

  it("voids a sale: stock returns, cash refunds, summaries exclude it", () => {
    const { db, service } = newService();
    openShift(service, "cajero-1", 10_000);
    stockUp(service, "soda", 1000);

    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, service.scan("7751234567892"));
    const sale = service.checkout(cart, [{ method: "cash", amountCents: 850 }]);
    expect(getProductStock(db, "soda")).toBe(0);

    const r = service.voidSale({ saleId: sale.saleId, voidedBy: "admin" });
    expect(r.alreadyVoided).toBe(false);
    // Stock came back and voiding twice is a no-op.
    expect(getProductStock(db, "soda")).toBe(1000);
    expect(service.voidSale({ saleId: sale.saleId, voidedBy: "admin" }).alreadyVoided).toBe(true);

    // The recent list shows it voided; the daily summary no longer counts it.
    expect(service.recentSales()[0]).toMatchObject({
      id: sale.saleId,
      voidedAt: expect.any(String),
    });
    const { cashiers } = service.dailySummary();
    expect(cashiers.find((c) => c.cashierId === "cajero-1")?.salesCount).toBe(0);

    // The refund left the drawer: Z expects the float alone.
    const z = service.closeShift({ countedCents: 10_000 });
    expect(z.z.expectedCents).toBe(10_000);
    expect(z.z.byKind.refund).toBe(850);
  });

  it("voiding a cash sale without an open shift is rejected", () => {
    const { service } = newService();
    openShift(service);
    stockUp(service, "soda", 1000);
    stockUp(service, "bread", 1000);
    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, service.scan("7751234567892"));
    const sale = service.checkout(cart, [{ method: "cash", amountCents: 850 }]);
    service.closeShift({ countedCents: 10_850 });

    expect(() => service.voidSale({ saleId: sale.saleId, voidedBy: "admin" })).toThrow(
      "turno abierto",
    );

    // Card sales carry no drawer effect: voidable with the shift closed.
    openShift(service, "admin");
    let cart2: Cart = EMPTY_CART;
    cart2 = addScan(cart2, service.scan("7752345678903"));
    const cardSale = service.checkout(cart2, [{ method: "card", amountCents: 690 }]);
    service.closeShift({ countedCents: 10_000 });
    expect(
      service.voidSale({ saleId: cardSale.saleId, voidedBy: "admin" }).alreadyVoided,
    ).toBe(false);
  });

  it("registerProduct makes the code sellable immediately", () => {
    const { service } = newService();
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

  it("receives stock idempotently and exposes it in bootstrap", () => {
    const { service } = newService();
    const movementId = "0d6a2cbe-9f7d-4a1a-8a44-eeeeeeeeeeee";
    const first = service.receiveStock({
      movementId,
      productId: "soda",
      qtyMilli: 24_000,
    });
    expect(first.stockMilli).toBe(24_000);

    const retry = service.receiveStock({ movementId, productId: "soda", qtyMilli: 24_000 });
    expect(retry.stockMilli).toBe(24_000);

    const boot = service.bootstrap();
    expect(boot.products.find((p) => p.id === "soda")?.stockMilli).toBe(24_000);

    expect(() =>
      service.receiveStock({
        movementId: "0d6a2cbe-9f7d-4a1a-8a44-ffffffffffff",
        productId: "ghost",
        qtyMilli: 1000,
      }),
    ).toThrow("does not exist");
  });

  it("everything survives closing and reopening the DB file", () => {
    const file = tempDbFile();

    const firstDb = openPosDb(file);
    {
      const service = new PosService(firstDb, CTX);
      service.bootstrap();
      openShift(service);
      const created = service.registerProduct({
        name: "Yerba mate 500g",
        barcode: "7791111111116",
        unitPriceCents: 3990,
        isWeighable: false,
      });
      if (created.kind !== "product") throw new Error("expected product");
      stockUp(service, created.product.id, 1000);
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
      expect(getProductStock(db, scan.product.id)).toBe(0); // received 1, sold 1
      // The open shift survives the restart too.
      expect(boot.session?.cashierId).toBe("cajero-1");
    } finally {
      db.$client.close();
    }
  });
});
