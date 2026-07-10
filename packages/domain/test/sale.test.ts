import { describe, expect, it } from "vitest";
import { computeSaleTotals, type SaleInput } from "../src/sale.js";
import type { TaxDefinitionInput } from "../src/tax.js";

const TAXES: TaxDefinitionInput[] = [
  { code: "IVA19", name: "IVA 19%", rateBp: 1900, includedInPrice: true },
  { code: "EXEMPT", name: "Exento", rateBp: 0, includedInPrice: true },
  { code: "SVC10", name: "Servicio 10%", rateBp: 1000, includedInPrice: false },
];

function sale(partial: Partial<SaleInput>): SaleInput {
  return { lines: [], taxCatalog: TAXES, ...partial } as SaleInput;
}

describe("computeSaleTotals", () => {
  it("computes a simple minimarket sale with included IVA", () => {
    const r = computeSaleTotals(
      sale({
        lines: [
          { id: "a", qtyMilli: 2000, unitPriceCents: 1190, taxCodes: ["IVA19"] },
          { id: "b", qtyMilli: 1000, unitPriceCents: 500, taxCodes: ["EXEMPT"] },
        ],
      }),
    );
    expect(r.grossCents).toBe(2880);
    expect(r.totalCents).toBe(2880); // included taxes don't change the total
    expect(r.taxBreakdown).toEqual([
      { code: "IVA19", baseCents: 2000, taxCents: 380 },
      { code: "EXEMPT", baseCents: 500, taxCents: 0 },
    ]);
  });

  it("handles a weighed product (1.525 kg at 990/kg)", () => {
    const r = computeSaleTotals(
      sale({
        lines: [{ id: "w", qtyMilli: 1525, unitPriceCents: 990, taxCodes: ["IVA19"] }],
      }),
    );
    expect(r.totalCents).toBe(1510);
  });

  it("applies line discounts (percent and fixed) capped at the line amount", () => {
    const r = computeSaleTotals(
      sale({
        lines: [
          {
            id: "a",
            qtyMilli: 1000,
            unitPriceCents: 1000,
            discount: { type: "percent", valueBp: 1000 }, // 10%
            taxCodes: [],
          },
          {
            id: "b",
            qtyMilli: 1000,
            unitPriceCents: 300,
            discount: { type: "fixed", amountCents: 9999 }, // capped at 300
            taxCodes: [],
          },
        ],
      }),
    );
    expect(r.lines[0]?.netCents).toBe(900);
    expect(r.lines[1]?.netCents).toBe(0);
    expect(r.discountCents).toBe(400);
    expect(r.totalCents).toBe(900);
  });

  it("allocates an order discount across lines without losing a cent", () => {
    const r = computeSaleTotals(
      sale({
        lines: [
          { id: "a", qtyMilli: 1000, unitPriceCents: 333, taxCodes: ["IVA19"] },
          { id: "b", qtyMilli: 1000, unitPriceCents: 333, taxCodes: ["IVA19"] },
          { id: "c", qtyMilli: 1000, unitPriceCents: 334, taxCodes: ["IVA19"] },
        ],
        orderDiscount: { type: "fixed", amountCents: 100 },
      }),
    );
    const allocated = r.lines.reduce((a, l) => a + l.orderDiscountCents, 0);
    expect(allocated).toBe(100);
    expect(r.totalCents).toBe(900);
    expect(r.totalCents).toBe(r.lines.reduce((a, l) => a + l.totalCents, 0));
  });

  it("adds exclusive taxes on top (fast-food 10% service)", () => {
    const r = computeSaleTotals(
      sale({
        lines: [
          { id: "combo", qtyMilli: 1000, unitPriceCents: 5000, taxCodes: ["SVC10"] },
        ],
      }),
    );
    expect(r.netCents).toBe(5000);
    expect(r.taxCents).toBe(500);
    expect(r.totalCents).toBe(5500);
  });

  it("rejects unknown tax codes", () => {
    expect(() =>
      computeSaleTotals(
        sale({
          lines: [{ id: "x", qtyMilli: 1000, unitPriceCents: 100, taxCodes: ["NOPE"] }],
        }),
      ),
    ).toThrow('Unknown tax code "NOPE"');
  });

  it("rejects an empty sale and non-integer amounts", () => {
    expect(() => computeSaleTotals(sale({ lines: [] }))).toThrow();
    expect(() =>
      computeSaleTotals(
        sale({
          lines: [{ id: "x", qtyMilli: 1000, unitPriceCents: 10.5, taxCodes: [] }],
        }),
      ),
    ).toThrow();
  });

  it("keeps every invariant under fuzzing", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const codes = [["IVA19"], ["EXEMPT"], ["SVC10"], []];

    for (let run = 0; run < 300; run++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) => ({
        id: `l${i}`,
        qtyMilli: 1 + Math.floor(rnd() * 5000),
        unitPriceCents: Math.floor(rnd() * 100_000),
        ...(rnd() < 0.5
          ? {
              discount:
                rnd() < 0.5
                  ? ({ type: "percent", valueBp: Math.floor(rnd() * 10_001) } as const)
                  : ({ type: "fixed", amountCents: Math.floor(rnd() * 50_000) } as const),
            }
          : {}),
        taxCodes: codes[Math.floor(rnd() * codes.length)] as string[],
      }));
      const r = computeSaleTotals(
        sale({
          lines,
          ...(rnd() < 0.5
            ? { orderDiscount: { type: "percent", valueBp: Math.floor(rnd() * 10_001) } as const }
            : {}),
        }),
      );

      // Invariant 1: grand total equals the sum of line totals, to the cent.
      expect(r.totalCents).toBe(r.lines.reduce((a, l) => a + l.totalCents, 0));
      // Invariant 2: gross - discounts = net.
      expect(r.grossCents - r.discountCents).toBe(r.netCents);
      // Invariant 3: nothing goes negative.
      for (const l of r.lines) {
        expect(l.netCents).toBeGreaterThanOrEqual(0);
        expect(l.totalCents).toBeGreaterThanOrEqual(0);
      }
      // Invariant 4: tax breakdown sums match per-line taxes.
      expect(r.taxBreakdown.reduce((a, t) => a + t.taxCents, 0)).toBe(r.taxCents);
    }
  });
});
