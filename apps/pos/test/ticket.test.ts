import { describe, expect, it } from "vitest";
import { addScan, EMPTY_CART, type Cart } from "../src/cart.js";
import { openPosDb } from "../src/db/connect.js";
import type { DeviceContext } from "../src/db/context.js";
import { PosService } from "../src/service.js";
import {
  renderTicketEscPos,
  renderTicketText,
  type TicketData,
} from "../src/ticket.js";

const CTX: DeviceContext = { tenantId: "t1", storeId: "s1", deviceId: "caja-1" };

const SAMPLE: TicketData = {
  storeName: "Bodega Doña María",
  storeAddress: "Av. Los Próceres 123",
  storeCity: "Lima, Perú",
  storeRuc: "20601234567",
  deviceId: "caja-1",
  cashierName: "Cajero 1",
  saleId: "0d6a2cbe-9f7d-4a1a-8a44-000000000001",
  dateIso: "2026-07-10T15:30:00.000Z",
  lines: [
    { name: "Inca Kola 1.5L", qtyMilli: 2000, isWeighable: false, unitPriceCents: 850, totalCents: 850, discountCents: 850 },
    { name: "Arroz a granel (kg)", qtyMilli: 1525, isWeighable: true, unitPriceCents: 450, totalCents: 686, discountCents: 0 },
  ],
  grossCents: 2386,
  discountCents: 850,
  totalCents: 1536,
  taxBreakdown: [{ code: "IGV18", taxCents: 234 }],
  payments: [{ method: "cash", amountCents: 2000 }],
  changeCents: 460,
  cashRoundingCents: 4,
  voided: false,
  documentType: "boleta",
  documentNumber: "B001-00000001",
};

describe("renderTicketText", () => {
  it("lays out header, lines, totals and payments within the width", () => {
    const text = renderTicketText(SAMPLE, 42);
    const rows = text.split("\n");
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(42);

    expect(text).toContain("BODEGA DONA MARIA"); // accents stripped
    expect(text).toContain("2 x Inca Kola 1.5L");
    expect(text).toContain("1.525 kg Arroz a granel (kg)");
    expect(text).toContain("DESCUENTOS");
    expect(text).toContain("TOTAL");
    expect(text).toContain("S/ 15.36");
    expect(text).toContain("IGV18 incluido");
    expect(text).toContain("EFECTIVO");
    expect(text).toContain("VUELTO");
    expect(text).toContain("4.60");
    expect(text).toContain("Representacion impresa");
    expect(text).not.toContain("ANULADA");
  });

  it("marks voided tickets", () => {
    expect(renderTicketText({ ...SAMPLE, voided: true })).toContain(
      "*** VENTA ANULADA ***",
    );
  });
});

describe("renderTicketEscPos", () => {
  it("wraps the ticket in init, feed and cut commands", () => {
    const bytes = renderTicketEscPos(SAMPLE);
    expect([...bytes.slice(0, 2)]).toEqual([0x1b, 0x40]); // ESC @ init
    expect([...bytes.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00]); // cut
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("BODEGA DONA MARIA");
  });
});

describe("PosService.receiptTicket", () => {
  it("rebuilds the ticket from the persisted sale", () => {
    const service = new PosService(openPosDb(":memory:"), CTX, "Mi Bodega");
    service.bootstrap();
    service.openShift({
      sessionId: crypto.randomUUID(),
      cashierId: "cajero-1",
      openingFloatCents: 5000,
    });
    service.receiveStock({
      movementId: crypto.randomUUID(),
      productId: "soda",
      qtyMilli: 2000,
    });

    let cart: Cart = EMPTY_CART;
    cart = addScan(cart, service.scan("7751234567892"));
    const sale = service.checkout(cart, [{ method: "cash", amountCents: 1000 }]);

    const { text } = service.receiptTicket(sale.saleId);
    expect(text).toContain("MI BODEGA");
    expect(text).toContain("Cajero 1");
    expect(text).toContain("Inca Kola 1.5L");
    expect(text).toContain("S/ 8.50");
    expect(text).toContain("EFECTIVO");
    expect(text).toContain("VUELTO");

    expect(() => service.receiptTicket(crypto.randomUUID())).toThrow(
      "does not exist",
    );
  });
});
