/**
 * Receipt ticket builder: plain text (preview + tests) and ESC/POS bytes
 * (any 80mm thermal printer). Pure module — no I/O, no node deps.
 *
 * Until the business becomes an electronic issuer (CPE/SUNAT), the ticket
 * prints as an internal sale note, not a tax receipt.
 */

export interface TicketLine {
  name: string;
  qtyMilli: number;
  isWeighable: boolean;
  unitPriceCents: number;
  totalCents: number;
  discountCents: number;
}

export interface TicketData {
  storeName: string;
  storeLine2?: string;
  deviceId: string;
  cashierName: string;
  saleId: string;
  dateIso: string;
  lines: TicketLine[];
  grossCents: number;
  discountCents: number;
  totalCents: number;
  taxBreakdown: Array<{ code: string; taxCents: number }>;
  payments: Array<{ method: string; amountCents: number }>;
  changeCents: number;
  cashRoundingCents: number;
  voided: boolean;
}

const METHOD_LABEL: Record<string, string> = {
  cash: "EFECTIVO",
  card: "TARJETA",
  wallet: "YAPE/PLIN",
  transfer: "TRANSFERENCIA",
  credit: "FIADO",
};

/** Thermal fonts have no accents guaranteed: strip diacritics, keep ñ→n too. */
function ascii(text: string): string {
  return text
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .replace(/[^\x20-\x7e]/g, "?");
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

function qty(line: TicketLine): string {
  return line.isWeighable
    ? `${(line.qtyMilli / 1000).toFixed(3)} kg`
    : `${Math.round(line.qtyMilli / 1000)} x`;
}

function row(left: string, right: string, width: number): string {
  const space = width - left.length - right.length;
  if (space < 1) return `${left.slice(0, width - right.length - 1)} ${right}`;
  return left + " ".repeat(space) + right;
}

function center(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return " ".repeat(pad) + text;
}

export function renderTicketText(data: TicketData, width = 42): string {
  const divider = "-".repeat(width);
  const out: string[] = [];

  out.push(center(ascii(data.storeName.toUpperCase()), width));
  if (data.storeLine2) out.push(center(ascii(data.storeLine2), width));
  out.push(divider);

  const date = new Date(data.dateIso);
  // 24h time: the localized "a. m." carries non-ASCII spaces that thermal
  // fonts render as garbage.
  out.push(
    row(
      date.toLocaleDateString("es-PE") + " " +
        date.toLocaleTimeString("es-PE", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      `Caja: ${ascii(data.deviceId)}`,
      width,
    ),
  );
  out.push(`Cajero: ${ascii(data.cashierName)}`);
  out.push(`Ticket: ${data.saleId.slice(0, 8)}`);
  if (data.voided) out.push(center("*** VENTA ANULADA ***", width));
  out.push(divider);

  for (const line of data.lines) {
    out.push(ascii(`${qty(line)} ${line.name}`).slice(0, width));
    if (line.discountCents > 0) {
      out.push(row(`   descuento`, `-${money(line.discountCents)}`, width));
    }
    out.push(row(`   ${money(line.unitPriceCents)} c/u`, money(line.totalCents), width));
  }
  out.push(divider);

  if (data.discountCents > 0) {
    out.push(row("SUBTOTAL", money(data.grossCents), width));
    out.push(row("DESCUENTOS", `-${money(data.discountCents)}`, width));
  }
  out.push(row("TOTAL", `S/ ${money(data.totalCents)}`, width));
  for (const tax of data.taxBreakdown) {
    if (tax.taxCents > 0) {
      out.push(row(`  ${ascii(tax.code)} incluido`, money(tax.taxCents), width));
    }
  }
  out.push(divider);

  for (const p of data.payments) {
    out.push(row(METHOD_LABEL[p.method] ?? p.method.toUpperCase(), money(p.amountCents), width));
  }
  if (data.cashRoundingCents !== 0) {
    out.push(
      row(
        "Redondeo efectivo",
        `${data.cashRoundingCents > 0 ? "+" : "-"}${money(Math.abs(data.cashRoundingCents))}`,
        width,
      ),
    );
  }
  if (data.changeCents > 0) {
    out.push(row("VUELTO", money(data.changeCents), width));
  }
  out.push(divider);
  out.push(center("Gracias por su compra!", width));
  out.push(center("Documento interno de venta", width));
  out.push(center("(no es comprobante SUNAT)", width));
  return out.join("\n");
}

const ESC = 0x1b;
const GS = 0x1d;

/** Wrap the text ticket in ESC/POS: init, bold header, feed and cut. */
export function renderTicketEscPos(data: TicketData, width = 42): Uint8Array {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  const push = (...values: number[]) => bytes.push(...values);
  const text = (value: string) => bytes.push(...encoder.encode(value));

  push(ESC, 0x40); // initialize
  push(ESC, 0x61, 0x01); // center
  push(ESC, 0x45, 0x01); // bold on
  text(ascii(data.storeName.toUpperCase()) + "\n");
  push(ESC, 0x45, 0x00); // bold off
  if (data.storeLine2) text(ascii(data.storeLine2) + "\n");
  push(ESC, 0x61, 0x00); // left

  // Body reuses the text layout minus the header we just printed.
  const body = renderTicketText(data, width)
    .split("\n")
    .slice(data.storeLine2 ? 2 : 1)
    .join("\n");
  text(body + "\n");

  push(ESC, 0x64, 0x04); // feed 4 lines
  push(GS, 0x56, 0x42, 0x00); // partial cut
  return Uint8Array.from(bytes);
}
