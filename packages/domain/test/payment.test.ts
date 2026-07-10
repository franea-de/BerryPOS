import { describe, expect, it } from "vitest";
import { cents, roundToUnit } from "../src/money.js";
import { settlePayments, type PaymentInput } from "../src/payment.js";

describe("roundToUnit", () => {
  it("rounds to the nearest multiple, half away from zero", () => {
    expect(roundToUnit(cents(1997), 10)).toBe(2000);
    expect(roundToUnit(cents(1994), 10)).toBe(1990);
    expect(roundToUnit(cents(1995), 10)).toBe(2000);
    expect(roundToUnit(cents(125), 50)).toBe(150);
  });

  it("supports up and down modes", () => {
    expect(roundToUnit(cents(1991), 10, "up")).toBe(2000);
    expect(roundToUnit(cents(1999), 10, "down")).toBe(1990);
  });

  it("is a no-op for unit 1 and rejects invalid units", () => {
    expect(roundToUnit(cents(1997), 1)).toBe(1997);
    expect(() => roundToUnit(cents(100), 0)).toThrow(RangeError);
  });
});

describe("settlePayments", () => {
  it("settles an exact cash payment", () => {
    const r = settlePayments({
      totalCents: 2880,
      payments: [{ method: "cash", amountCents: 2880 }],
    });
    expect(r.status).toBe("paid");
    expect(r.changeCents).toBe(0);
    expect(r.outstandingCents).toBe(0);
    expect(r.dueCents).toBe(2880);
  });

  it("returns change on cash overpayment", () => {
    const r = settlePayments({
      totalCents: 2880,
      payments: [{ method: "cash", amountCents: 5000 }],
    });
    expect(r.status).toBe("paid");
    expect(r.changeCents).toBe(2120);
    expect(r.appliedByMethod).toEqual([{ method: "cash", appliedCents: 2880 }]);
  });

  it("settles a mixed card + cash payment with change", () => {
    const r = settlePayments({
      totalCents: 10_000,
      payments: [
        { method: "card", amountCents: 6000 },
        { method: "cash", amountCents: 5000 },
      ],
    });
    expect(r.status).toBe("paid");
    expect(r.changeCents).toBe(1000);
    expect(r.tenderedCents).toBe(11_000);
    expect(r.appliedByMethod).toEqual([
      { method: "card", appliedCents: 6000 },
      { method: "cash", appliedCents: 4000 },
    ]);
  });

  it("rejects non-cash overpayment (no change on a card)", () => {
    expect(() =>
      settlePayments({
        totalCents: 1000,
        payments: [{ method: "card", amountCents: 1001 }],
      }),
    ).toThrow(RangeError);
  });

  it("reports partial tender with the outstanding amount", () => {
    const r = settlePayments({
      totalCents: 5000,
      payments: [{ method: "cash", amountCents: 2000 }],
    });
    expect(r.status).toBe("partial");
    expect(r.outstandingCents).toBe(3000);
    expect(r.changeCents).toBe(0);
  });

  it("supports credit (fiado) as full payment", () => {
    const r = settlePayments({
      totalCents: 7500,
      payments: [{ method: "credit", amountCents: 7500 }],
    });
    expect(r.status).toBe("paid");
    expect(r.appliedByMethod).toEqual([{ method: "credit", appliedCents: 7500 }]);
  });

  it("a zero total with no payments is paid", () => {
    const r = settlePayments({ totalCents: 0, payments: [] });
    expect(r.status).toBe("paid");
    expect(r.tenderedCents).toBe(0);
  });

  describe("cash rounding", () => {
    it("rounds the cash due and reports the signed adjustment", () => {
      // Total 19.97, no coins under 0.10: customer owes 20.00 in cash.
      const r = settlePayments({
        totalCents: 1997,
        payments: [{ method: "cash", amountCents: 2000 }],
        cashRounding: { unitCents: 10 },
      });
      expect(r.status).toBe("paid");
      expect(r.dueCents).toBe(2000);
      expect(r.cashRoundingCents).toBe(3);
      expect(r.changeCents).toBe(0);
    });

    it("merchant absorbs the difference when rounding down", () => {
      const r = settlePayments({
        totalCents: 1997,
        payments: [{ method: "cash", amountCents: 1990 }],
        cashRounding: { unitCents: 10, mode: "down" },
      });
      expect(r.status).toBe("paid");
      expect(r.dueCents).toBe(1990);
      expect(r.cashRoundingCents).toBe(-7);
    });

    it("only rounds the portion actually due in cash", () => {
      // Card pays 99.95 exactly; only the 0.05 remainder is cash-rounded.
      const r = settlePayments({
        totalCents: 10_000,
        payments: [
          { method: "card", amountCents: 9995 },
          { method: "cash", amountCents: 10 },
        ],
        cashRounding: { unitCents: 10 },
      });
      expect(r.status).toBe("paid");
      expect(r.dueCents).toBe(10_005);
      expect(r.cashRoundingCents).toBe(5);
      expect(r.changeCents).toBe(0);
    });

    it("does not round when no cash participates", () => {
      const r = settlePayments({
        totalCents: 1997,
        payments: [{ method: "card", amountCents: 1997 }],
        cashRounding: { unitCents: 10 },
      });
      expect(r.status).toBe("paid");
      expect(r.dueCents).toBe(1997);
      expect(r.cashRoundingCents).toBe(0);
    });

    it("a tiny remainder can round to zero (merchant absorbs it)", () => {
      const r = settlePayments({
        totalCents: 10_004,
        payments: [
          { method: "card", amountCents: 10_000 },
          { method: "cash", amountCents: 10 },
        ],
        cashRounding: { unitCents: 10 },
      });
      expect(r.status).toBe("paid");
      expect(r.dueCents).toBe(10_000);
      expect(r.changeCents).toBe(10);
      expect(r.cashRoundingCents).toBe(-4);
    });
  });

  it("keeps every invariant under fuzzing", () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const units = [1, 10, 50, 100];
    const modes = ["nearest", "up", "down"] as const;

    for (let run = 0; run < 500; run++) {
      const totalCents = Math.floor(rnd() * 100_000);
      const payments: PaymentInput[] = [];
      const nonCashBudget = Math.floor(rnd() * (totalCents + 1));
      if (nonCashBudget > 0 && rnd() < 0.6) {
        payments.push({
          method: rnd() < 0.5 ? "card" : rnd() < 0.5 ? "transfer" : "credit",
          amountCents: nonCashBudget,
        });
      }
      if (rnd() < 0.8) {
        payments.push({
          method: "cash",
          amountCents: 1 + Math.floor(rnd() * 100_000),
        });
      }
      const withRounding = rnd() < 0.5;
      const unitCents = units[Math.floor(rnd() * units.length)] as number;

      const r = settlePayments({
        totalCents,
        payments,
        ...(withRounding
          ? { cashRounding: { unitCents, mode: modes[Math.floor(rnd() * 3)] as (typeof modes)[number] } }
          : {}),
      });

      const applied = r.appliedByMethod.reduce((a, p) => a + p.appliedCents, 0);
      // Invariant 1: money in = money applied + change.
      expect(r.tenderedCents).toBe(applied + r.changeCents);
      // Invariant 2: what's applied plus what's missing is exactly the due.
      expect(applied + r.outstandingCents).toBe(r.dueCents);
      // Invariant 3: rounding never moves the due more than one unit.
      expect(Math.abs(r.cashRoundingCents)).toBeLessThan(withRounding ? unitCents : 1);
      // Invariant 4: change and outstanding are never both positive.
      expect(r.changeCents === 0 || r.outstandingCents === 0).toBe(true);
      // Invariant 5: nothing negative.
      for (const v of [r.changeCents, r.outstandingCents, r.tenderedCents]) {
        expect(v).toBeGreaterThanOrEqual(0);
      }
      // Invariant 6: status is consistent.
      expect(r.status).toBe(r.outstandingCents === 0 ? "paid" : "partial");
    }
  });
});
