import { describe, expect, it } from "vitest";
import {
  evaluatePromotions,
  type CartLineInput,
  type PromotionInput,
} from "../src/promotion.js";
import { computeSaleTotals } from "../src/sale.js";

const line = (partial: Partial<CartLineInput> & { id: string }): CartLineInput => ({
  productId: "p1",
  qtyMilli: 1000,
  unitPriceCents: 1000,
  taxCodes: [],
  ...partial,
});

const TWO_FOR_ONE: PromotionInput = {
  id: "2x1-soda",
  name: "2x1 bebidas",
  type: "nxm",
  productIds: ["soda"],
  buyQty: 2,
  payQty: 1,
};

describe("evaluatePromotions", () => {
  it("applies 2x1 on whole units of an eligible product", () => {
    const r = evaluatePromotions({
      lines: [line({ id: "a", productId: "soda", qtyMilli: 5000, unitPriceCents: 800 })],
      promotions: [TWO_FOR_ONE],
    });
    // 5 units -> 2 groups of 2 -> 2 free units = 1600.
    expect(r.applications).toEqual([
      {
        promotionId: "2x1-soda",
        promotionName: "2x1 bebidas",
        lineId: "a",
        discountCents: 1600,
      },
    ]);
    expect(r.lines[0]?.discount).toEqual({ type: "fixed", amountCents: 1600 });
  });

  it("3x2 charges two of every three units", () => {
    const r = evaluatePromotions({
      lines: [line({ id: "a", productId: "soda", qtyMilli: 7000, unitPriceCents: 900 })],
      promotions: [{ ...TWO_FOR_ONE, id: "3x2", name: "3x2", buyQty: 3, payQty: 2 }],
    });
    // 7 units -> 2 groups of 3 -> 2 free = 1800.
    expect(r.applications[0]?.discountCents).toBe(1800);
  });

  it("applies a category percent discount", () => {
    const r = evaluatePromotions({
      lines: [
        line({ id: "a", categoryId: "abarrotes", qtyMilli: 2000, unitPriceCents: 750 }),
        line({ id: "b", categoryId: "otra" }),
      ],
      promotions: [
        {
          id: "cat10",
          name: "10% abarrotes",
          type: "category_percent",
          categoryIds: ["abarrotes"],
          valueBp: 1000,
        },
      ],
    });
    expect(r.applications).toEqual([
      { promotionId: "cat10", promotionName: "10% abarrotes", lineId: "a", discountCents: 150 },
    ]);
    expect(r.lines[1]?.discount).toBeUndefined();
  });

  it("applies a volume price above the threshold, including weighables", () => {
    const r = evaluatePromotions({
      lines: [
        // 2.5 kg at 990/kg; from 2 kg the kilo drops to 890.
        line({ id: "a", productId: "rice", qtyMilli: 2500, unitPriceCents: 990 }),
        line({ id: "b", productId: "rice", qtyMilli: 1000, unitPriceCents: 990 }),
      ],
      promotions: [
        {
          id: "vol-rice",
          name: "Arroz x mayor",
          type: "volume_price",
          productIds: ["rice"],
          minQtyMilli: 2000,
          unitPriceCents: 890,
        },
      ],
    });
    // gross 2475 vs 2225 -> 250 off; line b under threshold.
    expect(r.applications).toEqual([
      { promotionId: "vol-rice", promotionName: "Arroz x mayor", lineId: "a", discountCents: 250 },
    ]);
    expect(r.lines[1]?.discount).toBeUndefined();
  });

  it("a manual discount on the line disables promotions there", () => {
    const r = evaluatePromotions({
      lines: [
        line({
          id: "a",
          productId: "soda",
          qtyMilli: 2000,
          manualDiscount: { type: "percent", valueBp: 500 },
        }),
      ],
      promotions: [TWO_FOR_ONE],
    });
    expect(r.applications).toEqual([]);
    expect(r.lines[0]?.discount).toEqual({ type: "percent", valueBp: 500 });
  });

  it("non-stackable promotions compete: highest priority wins alone", () => {
    const r = evaluatePromotions({
      lines: [line({ id: "a", productId: "soda", categoryId: "drinks", qtyMilli: 2000, unitPriceCents: 1000 })],
      promotions: [
        { ...TWO_FOR_ONE, priority: 1 }, // would give 1000
        {
          id: "cat50",
          name: "50% drinks",
          type: "category_percent",
          categoryIds: ["drinks"],
          valueBp: 5000,
          priority: 0,
        }, // would give 1000 too, but loses on priority
      ],
    });
    expect(r.applications).toHaveLength(1);
    expect(r.applications[0]?.promotionId).toBe("2x1-soda");
  });

  it("stackable promotions accumulate, capped at the line gross", () => {
    const r = evaluatePromotions({
      lines: [line({ id: "a", productId: "soda", categoryId: "drinks", qtyMilli: 2000, unitPriceCents: 1000 })],
      promotions: [
        { ...TWO_FOR_ONE, stackable: true, priority: 2 }, // 1000
        {
          id: "cat90",
          name: "90% drinks",
          type: "category_percent",
          categoryIds: ["drinks"],
          valueBp: 9000,
          stackable: true,
          priority: 1,
        }, // 1800, capped to the remaining 1000
      ],
    });
    expect(r.applications.map((a) => a.discountCents)).toEqual([1000, 1000]);
    expect(r.lines[0]?.discount).toEqual({ type: "fixed", amountCents: 2000 });
  });

  it("feeds computeSaleTotals and the totals still reconcile", () => {
    const evaluated = evaluatePromotions({
      lines: [
        line({ id: "a", productId: "soda", qtyMilli: 4000, unitPriceCents: 800, taxCodes: ["IVA19"] }),
        line({ id: "b", categoryId: "abarrotes", qtyMilli: 1000, unitPriceCents: 500, taxCodes: ["IVA19"] }),
      ],
      promotions: [
        TWO_FOR_ONE,
        {
          id: "cat10",
          name: "10% abarrotes",
          type: "category_percent",
          categoryIds: ["abarrotes"],
          valueBp: 1000,
        },
      ],
    });
    const totals = computeSaleTotals({
      lines: evaluated.lines,
      taxCatalog: [
        { code: "IVA19", name: "IVA 19%", rateBp: 1900, includedInPrice: true },
      ],
    });
    // soda: 3200 − 1600 (2x1); abarrotes: 500 − 50.
    expect(totals.grossCents).toBe(3700);
    expect(totals.discountCents).toBe(1650);
    expect(totals.totalCents).toBe(2050);
    const promoSum = evaluated.applications.reduce((a, p) => a + p.discountCents, 0);
    expect(promoSum).toBe(totals.discountCents);
  });

  it("ignores promotions that do not reach whole units (weighable NxM)", () => {
    const r = evaluatePromotions({
      lines: [line({ id: "a", productId: "soda", qtyMilli: 1999 })],
      promotions: [TWO_FOR_ONE],
    });
    expect(r.applications).toEqual([]);
  });
});
