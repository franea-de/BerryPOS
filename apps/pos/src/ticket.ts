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
  storeAddress?: string | undefined;
  storeCity?: string | undefined;
  storeRuc?: string | undefined;
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
  documentType: "boleta" | "factura";
  documentNumber: string;
  customerRuc?: string | undefined;
  customerName?: string | undefined;
  paymentReference?: string | undefined;
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
  if (data.storeAddress) out.push(center(ascii(data.storeAddress), width));
  if (data.storeCity) out.push(center(ascii(data.storeCity), width));
  if (data.storeRuc) out.push(center(`R.U.C. Nro ${data.storeRuc}`, width));
  out.push(divider);

  const docTitle = data.documentType === "factura" ? "FACTURA ELECTRONICA" : "BOLETA DE VENTA ELECTRONICA";
  out.push(center(docTitle, width));
  out.push(center(`Nro: ${data.documentNumber}`, width));
  out.push(divider);

  if (data.documentType === "factura" && data.customerRuc) {
    out.push(`Cliente: ${ascii(data.customerName ?? "-")}`);
    out.push(`R.U.C. : ${data.customerRuc}`);
    out.push(divider);
  }

  const date = new Date(data.dateIso);
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
  out.push(`Transac: ${data.saleId.slice(0, 8).toUpperCase()}`);
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
  if (data.paymentReference) {
    out.push(row("Ref/Op:", ascii(data.paymentReference), width));
  }
  out.push(divider);

  // Hash & QR text
  const hash = data.saleId.slice(0, 8).toUpperCase() + "-" + data.saleId.slice(-8).toUpperCase();
  out.push(center(`Representacion impresa de CPE`, width));
  out.push(center(`Firma Hash: ${hash}`, width));

  const rucReceptor = data.documentType === "factura" ? data.customerRuc : "";
  const numCorrelativo = data.documentNumber.split("-")[1] ?? "00000000";
  const qrData = `${data.storeRuc}|${data.documentType === "factura" ? "01" : "03"}|B001|${numCorrelativo}|${money(data.totalCents - (data.taxBreakdown[0]?.taxCents ?? 0))}|${money(data.totalCents)}|${date.toLocaleDateString("es-PE")}|${data.documentType === "factura" ? "6" : "1"}|${rucReceptor}|`;
  out.push(center("Codigo QR SUNAT:", width));
  out.push(center(qrData.slice(0, width), width));
  if (qrData.length > width) {
    out.push(center(qrData.slice(width), width));
  }

  out.push(divider);
  out.push(center("Gracias por su compra!", width));
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
  push(ESC, 0x61, 0x00); // left

  // Body reuses the text layout minus the header we just printed (storeName).
  const body = renderTicketText(data, width)
    .split("\n")
    .slice(1)
    .join("\n");
  text(body + "\n");

  push(ESC, 0x64, 0x04); // feed 4 lines
  push(GS, 0x56, 0x42, 0x00); // partial cut
  return Uint8Array.from(bytes);
}
