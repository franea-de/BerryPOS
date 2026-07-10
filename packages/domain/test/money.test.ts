import { describe, expect, it } from "vitest";
import {
  allocateProportional,
  applyBp,
  basisPoints,
  cents,
  mulQty,
  qtyMilli,
  roundHalfAwayFromZero,
  sumCents,
  type Cents,
  type QtyMilli,
} from "../src/money.js";

describe("branded constructors", () => {
  it("reject non-integer values", () => {
    expect(() => cents(10.5)).toThrow(RangeError);
    expect(() => qtyMilli(0.1)).toThrow(RangeError);
    expect(() => basisPoints(19.5)).toThrow(RangeError);
    expect(() => cents(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it("pass integers through unchanged", () => {
    expect(cents(-150)).toBe(-150);
    expect(qtyMilli(1525)).toBe(1525);
    expect(basisPoints(1900)).toBe(1900);
  });

  it("brands are not interchangeable (compile-time check)", () => {
    const price = cents(100);
    const qty = qtyMilli(1000);
    // @ts-expect-error a plain number is not Cents
    const plain: Cents = 100;
    // @ts-expect-error a QtyMilli cannot be used where Cents is expected
    mulQty(qty, qty);
    expect(plain).toBe(100);
    expect(mulQty(price, qty)).toBe(100);
  });
});

describe("roundHalfAwayFromZero", () => {
  it("rounds .5 away from zero in both directions", () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(2.4)).toBe(2);
    expect(roundHalfAwayFromZero(-2.4)).toBe(-2);
    expect(roundHalfAwayFromZero(0)).toBe(0);
  });
});

describe("mulQty", () => {
  it("computes a weighed product line (990 cents/kg × 1.525 kg)", () => {
    expect(mulQty(cents(990), qtyMilli(1525))).toBe(1510); // 1509.75 -> 1510
  });

  it("is exact for unit quantities", () => {
    expect(mulQty(cents(350), qtyMilli(3000))).toBe(1050);
  });

  it("rejects non-integer inputs even when the type system is bypassed", () => {
    expect(() => mulQty(10.5 as Cents, qtyMilli(1000))).toThrow(RangeError);
    expect(() => mulQty(cents(10), 1000.5 as QtyMilli)).toThrow(RangeError);
  });
});

describe("applyBp", () => {
  it("computes percentages in basis points", () => {
    expect(applyBp(cents(10_000), basisPoints(1900))).toBe(1900); // 19% of 100.00
    expect(applyBp(cents(999), basisPoints(1000))).toBe(100); // 10% of 9.99 = 99.9 -> 100
    expect(applyBp(cents(123), basisPoints(0))).toBe(0);
  });
});

describe("sumCents", () => {
  it("sums amounts and an empty list is zero", () => {
    expect(sumCents([cents(100), cents(-30), cents(5)])).toBe(75);
    expect(sumCents([])).toBe(0);
  });
});

describe("allocateProportional", () => {
  it("splits exactly with no lost or invented cents", () => {
    const parts = allocateProportional(cents(100), [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it("is proportional to weights", () => {
    expect(allocateProportional(cents(1000), [3000, 1000])).toEqual([750, 250]);
  });

  it("splits equally when all weights are zero", () => {
    const parts = allocateProportional(cents(10), [0, 0, 0]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("returns empty for no weights", () => {
    expect(allocateProportional(cents(100), [])).toEqual([]);
  });

  it("always sums to the total (fuzz)", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 500; run++) {
      const n = 1 + Math.floor(rnd() * 8);
      const weights = Array.from({ length: n }, () => Math.floor(rnd() * 10_000));
      const total = cents(Math.floor(rnd() * 1_000_000));
      const parts = allocateProportional(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      for (const p of parts) expect(p).toBeGreaterThanOrEqual(0);
    }
  });
});
