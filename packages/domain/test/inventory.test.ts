import { describe, expect, it } from "vitest";
import {
  projectProductStock,
  projectStock,
  type StockMovementInput,
} from "../src/inventory.js";

const HISTORY: StockMovementInput[] = [
  { id: "r1", kind: "reception", productId: "rice", qtyMilli: 25_000 },
  { id: "s1", kind: "sale", productId: "rice", qtyMilli: 1525 },
  { id: "s2", kind: "sale", productId: "rice", qtyMilli: 2000 },
  { id: "m1", kind: "shrinkage", productId: "rice", qtyMilli: 500, note: "bolsa rota" },
  { id: "r2", kind: "reception", productId: "soda", qtyMilli: 24_000 },
  { id: "s3", kind: "sale", productId: "soda", qtyMilli: 6000 },
  { id: "t1", kind: "transfer_out", productId: "soda", qtyMilli: 12_000 },
  { id: "c1", kind: "customer_return", productId: "soda", qtyMilli: 1000 },
];

describe("projectStock", () => {
  it("projects per-product stock from the movement history", () => {
    const stock = projectStock(HISTORY);
    expect(stock.get("rice")).toBe(20_975); // 25000 − 1525 − 2000 − 500
    expect(stock.get("soda")).toBe(7000); // 24000 − 6000 − 12000 + 1000
  });

  it("allows negative stock (sale recorded before its reception)", () => {
    const stock = projectStock([
      { id: "s1", kind: "sale", productId: "beans", qtyMilli: 3000 },
    ]);
    expect(stock.get("beans")).toBe(-3000);
  });

  it("rejects duplicate movement ids (idempotency guard)", () => {
    expect(() =>
      projectStock([
        { id: "x", kind: "sale", productId: "a", qtyMilli: 1 },
        { id: "x", kind: "reception", productId: "b", qtyMilli: 1 },
      ]),
    ).toThrow('duplicate stock movement id "x"');
  });

  it("rejects zero and non-integer quantities", () => {
    expect(() =>
      projectStock([{ id: "a", kind: "sale", productId: "p", qtyMilli: 0 }]),
    ).toThrow();
    expect(() =>
      projectStock([{ id: "a", kind: "sale", productId: "p", qtyMilli: 1.5 }]),
    ).toThrow();
  });

  it("adjustments move stock in both directions", () => {
    const stock = projectStock([
      { id: "a", kind: "adjustment_in", productId: "p", qtyMilli: 10_000 },
      { id: "b", kind: "adjustment_out", productId: "p", qtyMilli: 4000 },
    ]);
    expect(stock.get("p")).toBe(6000);
  });
});

describe("projectProductStock", () => {
  it("returns a single product's stock, 0 when unknown", () => {
    expect(projectProductStock(HISTORY, "rice")).toBe(20_975);
    expect(projectProductStock(HISTORY, "ghost")).toBe(0);
  });
});
