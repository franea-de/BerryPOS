import { describe, expect, it } from "vitest";
import { isValidEan13, parseScaleEan13 } from "../src/barcode.js";

describe("isValidEan13", () => {
  it("accepts codes with a correct check digit", () => {
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("2012345015258")).toBe(true);
  });

  it("rejects wrong check digits and malformed input", () => {
    expect(isValidEan13("4006381333932")).toBe(false);
    expect(isValidEan13("123")).toBe(false);
    expect(isValidEan13("40063813339XX")).toBe(false);
  });
});

describe("parseScaleEan13", () => {
  it("parses a weight-embedded code (grams map 1:1 to QtyMilli)", () => {
    // prefix 20, item 12345, 1525 g
    expect(parseScaleEan13("2012345015258")).toEqual({
      kind: "weight",
      itemCode: "12345",
      weightQtyMilli: 1525,
    });
  });

  it("parses a price-embedded code", () => {
    // prefix 26, item 00042, $9.99
    expect(parseScaleEan13("2600042009993")).toEqual({
      kind: "price",
      itemCode: "00042",
      priceCents: 999,
    });
  });

  it("returns null for regular product barcodes", () => {
    expect(parseScaleEan13("4006381333931")).toBeNull();
    expect(parseScaleEan13("7791234")).toBeNull(); // EAN-8-ish, not ours
  });

  it("throws on a scale-prefixed code with a bad check digit (misread)", () => {
    expect(() => parseScaleEan13("2012345015250")).toThrow("check digit");
  });

  it("respects a custom prefix configuration", () => {
    const config = { weightPrefixes: ["28"], pricePrefixes: ["29"] };
    expect(parseScaleEan13("2012345015258", config)).toBeNull();
    const reparsed = parseScaleEan13("2600042009993", {
      weightPrefixes: ["26"],
      pricePrefixes: [],
    });
    expect(reparsed).toEqual({
      kind: "weight",
      itemCode: "00042",
      weightQtyMilli: 999,
    });
  });

  it("rejects a prefix configured as both weight and price", () => {
    expect(() =>
      parseScaleEan13("2012345015258", {
        weightPrefixes: ["20"],
        pricePrefixes: ["20"],
      }),
    ).toThrow("both weight and price");
  });
});
