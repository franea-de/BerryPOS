import { describe, expect, it } from "vitest";
import { basisPoints, cents } from "../src/money.js";
import {
  aggregateTaxes,
  computeExclusiveTax,
  splitIncludedTaxes,
  type TaxDefinition,
} from "../src/tax.js";

const IVA19: TaxDefinition = {
  code: "IVA19",
  name: "IVA 19%",
  rateBp: basisPoints(1900),
  includedInPrice: true,
};
const IGV18: TaxDefinition = {
  code: "IGV18",
  name: "IGV 18%",
  rateBp: basisPoints(1800),
  includedInPrice: true,
};

describe("splitIncludedTaxes", () => {
  it("extracts a 19% included tax from a clean gross", () => {
    const r = splitIncludedTaxes(cents(1190), [IVA19]);
    expect(r.baseCents).toBe(1000);
    expect(r.taxes).toEqual([{ code: "IVA19", baseCents: 1000, taxCents: 190 }]);
  });

  it("base + taxes always reconstruct the gross exactly (fuzz)", () => {
    for (let gross = 0; gross < 3000; gross += 7) {
      const r = splitIncludedTaxes(cents(gross), [IVA19]);
      const taxSum = r.taxes.reduce((a, t) => a + t.taxCents, 0);
      expect(r.baseCents + taxSum).toBe(gross);
    }
  });

  it("reconciles multiple included taxes to the gross", () => {
    const r = splitIncludedTaxes(cents(9999), [IVA19, IGV18]);
    const taxSum = r.taxes.reduce((a, t) => a + t.taxCents, 0);
    expect(r.baseCents + taxSum).toBe(9999);
  });

  it("returns the gross untouched with no taxes", () => {
    expect(splitIncludedTaxes(cents(555), [])).toEqual({ baseCents: 555, taxes: [] });
  });
});

describe("computeExclusiveTax", () => {
  it("adds tax on top of the base", () => {
    expect(computeExclusiveTax(cents(1000), basisPoints(1900))).toBe(190);
    expect(computeExclusiveTax(cents(999), basisPoints(1800))).toBe(180); // 179.82 -> 180
  });
});

describe("aggregateTaxes", () => {
  it("sums per code across lines, preserving order", () => {
    const result = aggregateTaxes([
      [{ code: "IVA19", baseCents: cents(1000), taxCents: cents(190) }],
      [
        { code: "EXEMPT", baseCents: cents(500), taxCents: cents(0) },
        { code: "IVA19", baseCents: cents(2000), taxCents: cents(380) },
      ],
    ]);
    expect(result).toEqual([
      { code: "IVA19", baseCents: 3000, taxCents: 570 },
      { code: "EXEMPT", baseCents: 500, taxCents: 0 },
    ]);
  });
});
