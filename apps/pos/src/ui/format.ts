import { ean13CheckDigit } from "@berrypos/domain";

export function money(amountCents: number): string {
  return `S/ ${(amountCents / 100).toLocaleString("es-PE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function qty(qtyMilli: number, weighable: boolean): string {
  return weighable
    ? `${(qtyMilli / 1000).toLocaleString("es-PE", { maximumFractionDigits: 3 })} kg`
    : `${Math.round(qtyMilli / 1000)}`;
}

/** Build a valid weight-embedded EAN-13 for the demo quick buttons. */
export function demoScaleCode(itemCode: string, grams: number): string {
  const body = `20${itemCode}${String(grams).padStart(5, "0")}`;
  return body + ean13CheckDigit(body);
}
