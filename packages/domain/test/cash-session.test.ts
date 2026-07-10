import { describe, expect, it } from "vitest";
import {
  closeCashSession,
  computeExpectedCash,
  type CashMovementInput,
} from "../src/cash-session.js";

const SESSION: CashMovementInput[] = [
  { id: "m1", kind: "opening_float", amountCents: 10_000 },
  { id: "m2", kind: "cash_sale", amountCents: 2880 },
  { id: "m3", kind: "cash_sale", amountCents: 1510 },
  { id: "m4", kind: "pay_out", amountCents: 5000, note: "retiro a bóveda" },
  { id: "m5", kind: "refund", amountCents: 500 },
  { id: "m6", kind: "pay_in", amountCents: 2000, note: "sencillo" },
];

describe("computeExpectedCash", () => {
  it("projects the drawer balance from the movements", () => {
    // 10000 + 2880 + 1510 − 5000 − 500 + 2000
    expect(computeExpectedCash(SESSION)).toBe(10_890);
  });

  it("an empty session holds zero", () => {
    expect(computeExpectedCash([])).toBe(0);
  });

  it("rejects duplicate movement ids (idempotency guard)", () => {
    expect(() =>
      computeExpectedCash([
        { id: "x", kind: "cash_sale", amountCents: 100 },
        { id: "x", kind: "cash_sale", amountCents: 100 },
      ]),
    ).toThrow('duplicate cash movement id "x"');
  });

  it("rejects an opening float that is not the first movement", () => {
    expect(() =>
      computeExpectedCash([
        { id: "a", kind: "pay_in", amountCents: 100 },
        { id: "b", kind: "opening_float", amountCents: 5000 },
      ]),
    ).toThrow("first movement");
  });

  it("rejects a movement that would leave the drawer negative", () => {
    expect(() =>
      computeExpectedCash([
        { id: "a", kind: "opening_float", amountCents: 1000 },
        { id: "b", kind: "pay_out", amountCents: 1500 },
      ]),
    ).toThrow(RangeError);
  });

  it("rejects zero and non-integer amounts", () => {
    expect(() =>
      computeExpectedCash([{ id: "a", kind: "cash_sale", amountCents: 0 }]),
    ).toThrow();
    expect(() =>
      computeExpectedCash([{ id: "a", kind: "cash_sale", amountCents: 10.5 }]),
    ).toThrow();
  });
});

describe("closeCashSession", () => {
  it("computes the Z report with a perfect blind count", () => {
    const z = closeCashSession({ movements: SESSION, countedCents: 10_890 });
    expect(z.expectedCents).toBe(10_890);
    expect(z.overShortCents).toBe(0);
    expect(z.byKind).toEqual({
      opening_float: 10_000,
      cash_sale: 4390,
      refund: 500,
      pay_in: 2000,
      pay_out: 5000,
    });
  });

  it("reports a shortage as negative over/short", () => {
    const z = closeCashSession({ movements: SESSION, countedCents: 10_000 });
    expect(z.overShortCents).toBe(-890);
  });

  it("reports a surplus as positive over/short", () => {
    const z = closeCashSession({ movements: SESSION, countedCents: 11_000 });
    expect(z.overShortCents).toBe(110);
  });

  it("keeps every invariant under fuzzing", () => {
    let seed = 1234;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const inKinds = ["cash_sale", "pay_in"] as const;
    const outKinds = ["refund", "pay_out"] as const;

    for (let run = 0; run < 300; run++) {
      // Build a valid session: outflows never exceed the running balance.
      const movements: CashMovementInput[] = [
        { id: "open", kind: "opening_float", amountCents: 1 + Math.floor(rnd() * 50_000) },
      ];
      let balance = movements[0]?.amountCents as number;
      const n = Math.floor(rnd() * 20);
      for (let i = 0; i < n; i++) {
        if (rnd() < 0.6 || balance === 0) {
          const amount = 1 + Math.floor(rnd() * 20_000);
          movements.push({
            id: `m${i}`,
            kind: inKinds[Math.floor(rnd() * 2)] as (typeof inKinds)[number],
            amountCents: amount,
          });
          balance += amount;
        } else {
          const amount = 1 + Math.floor(rnd() * balance);
          movements.push({
            id: `m${i}`,
            kind: outKinds[Math.floor(rnd() * 2)] as (typeof outKinds)[number],
            amountCents: amount,
          });
          balance -= amount;
        }
      }

      const counted = Math.floor(rnd() * 100_000);
      const z = closeCashSession({ movements, countedCents: counted });

      // Invariant 1: expected matches the independently tracked balance.
      expect(z.expectedCents).toBe(balance);
      // Invariant 2: over/short is exactly counted − expected.
      expect(z.overShortCents).toBe(counted - z.expectedCents);
      // Invariant 3: byKind gross totals reconcile back to the expected.
      const reconstructed =
        z.byKind.opening_float +
        z.byKind.cash_sale +
        z.byKind.pay_in -
        z.byKind.refund -
        z.byKind.pay_out;
      expect(reconstructed).toBe(z.expectedCents);
    }
  });
});
