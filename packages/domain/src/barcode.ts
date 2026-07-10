import { z } from "zod";
import { cents, qtyMilli, type Cents, type QtyMilli } from "./money.js";

/**
 * EAN-13 with embedded weight or price, as printed by supermarket scales.
 *
 * Layout: `PP IIIII VVVVV C` — 2-digit store prefix (GS1 reserves 20–29 for
 * in-store use), 5-digit item code, 5-digit value, check digit. Whether the
 * value is a weight (grams) or a price (cents) per prefix is a store-level
 * convention, so it is configuration, not code.
 */

/** Standard EAN-13 check digit for a 12-digit body. */
export function ean13CheckDigit(body12: string): number {
  if (!/^\d{12}$/.test(body12)) {
    throw new Error(`EAN-13 body must be 12 digits, got "${body12}"`);
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(body12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/**
 * In-store EAN-13 for products that arrive without a factory barcode
 * (print-and-stick). Prefix "04" is GS1 restricted-distribution, safely
 * outside the scale range 20-29, so it always scans as a regular product.
 */
export function generateInternalEan13(
  random: () => number = Math.random,
): string {
  const digits = Array.from({ length: 10 }, () =>
    Math.floor(random() * 10),
  ).join("");
  const body = `04${digits}`;
  return body + ean13CheckDigit(body);
}

const prefixList = z
  .array(z.string().regex(/^\d{2}$/))
  .default([]);

export const ScaleBarcodeConfigSchema = z.object({
  /** Prefixes whose embedded value is a weight in grams. */
  weightPrefixes: prefixList,
  /** Prefixes whose embedded value is a total price in cents. */
  pricePrefixes: prefixList,
});
export type ScaleBarcodeConfig = z.input<typeof ScaleBarcodeConfigSchema>;

/** Common LatAm default: 20–25 embed weight, 26–29 embed price. */
export const DEFAULT_SCALE_CONFIG: ScaleBarcodeConfig = {
  weightPrefixes: ["20", "21", "22", "23", "24", "25"],
  pricePrefixes: ["26", "27", "28", "29"],
};

export type ScaleBarcode =
  | { kind: "weight"; itemCode: string; weightQtyMilli: QtyMilli }
  | { kind: "price"; itemCode: string; priceCents: Cents };

/**
 * Parse a scanned EAN-13 that may embed weight or price.
 *
 * Returns `null` when the code is not scale-prefixed (a regular product
 * barcode: look it up in the catalog as-is). Throws when a scale-prefixed
 * code fails its check digit — that is a misread, not a lookup miss.
 */
export function parseScaleEan13(
  code: string,
  config: ScaleBarcodeConfig = DEFAULT_SCALE_CONFIG,
): ScaleBarcode | null {
  const { weightPrefixes, pricePrefixes } =
    ScaleBarcodeConfigSchema.parse(config);
  const overlap = weightPrefixes.filter((p) => pricePrefixes.includes(p));
  if (overlap.length > 0) {
    throw new Error(`prefixes configured as both weight and price: ${overlap.join(", ")}`);
  }

  if (!/^\d{13}$/.test(code)) return null;
  const prefix = code.slice(0, 2);
  const isWeight = weightPrefixes.includes(prefix);
  const isPrice = pricePrefixes.includes(prefix);
  if (!isWeight && !isPrice) return null;

  if (!isValidEan13(code)) {
    throw new Error(`scale barcode "${code}" has an invalid check digit`);
  }

  const itemCode = code.slice(2, 7);
  const value = Number(code.slice(7, 12));
  return isWeight
    ? { kind: "weight", itemCode, weightQtyMilli: qtyMilli(value) }
    : { kind: "price", itemCode, priceCents: cents(value) };
}
