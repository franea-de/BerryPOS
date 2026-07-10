import { eq } from "drizzle-orm";
import {
  computeSaleTotals,
  settlePayments,
  type CashRounding,
  type DiscountSpec,
  type PaymentInput,
  type SaleInput,
  type SaleLineInput,
  type SaleTotals,
  type Settlement,
} from "@berrypos/domain";
import { appendOutboxEvent, buildEnvelope, nowIso, type DeviceContext, type PosDb } from "./context.js";
import { getTaxCatalog } from "./catalog.js";
import {
  cashMovements,
  payments as paymentsTable,
  saleLines,
  sales,
  stockMovements,
} from "./schema.js";

export interface RecordSaleParams {
  /** Client-generated UUID — the idempotency key (CLAUDE.md rule #3). */
  saleId: string;
  cashSessionId: string;
  /** Lines already run through evaluatePromotions, plus their product. */
  lines: Array<{ line: SaleLineInput; productId: string }>;
  orderDiscount?: DiscountSpec;
  payments: PaymentInput[];
  cashRounding?: CashRounding;
  occurredAt?: string;
}

export interface RecordSaleResult {
  saleId: string;
  /** True when this saleId was already persisted: nothing was written. */
  alreadyRecorded: boolean;
  totals: SaleTotals;
  settlement: Settlement;
}

/**
 * Persist a finished sale in ONE local transaction: sale + lines + payments +
 * stock movements + cash movement + outbox event. Everything the sale caused
 * becomes durable together or not at all; re-running with the same saleId is
 * a no-op, which is what makes offline retries safe.
 */
export function recordSale(
  db: PosDb,
  ctx: DeviceContext,
  params: RecordSaleParams,
): RecordSaleResult {
  const occurredAt = params.occurredAt ?? nowIso();
  const saleInput: SaleInput = {
    lines: params.lines.map((l) => l.line),
    ...(params.orderDiscount ? { orderDiscount: params.orderDiscount } : {}),
    taxCatalog: getTaxCatalog(db),
  };

  const totals = computeSaleTotals(saleInput);
  const settlement = settlePayments({
    totalCents: totals.totalCents,
    payments: params.payments,
    ...(params.cashRounding ? { cashRounding: params.cashRounding } : {}),
  });
  if (settlement.status !== "paid") {
    throw new Error(
      `sale "${params.saleId}" is not fully paid: outstanding ${settlement.outstandingCents}`,
    );
  }

  return db.transaction((tx) => {
    const existing = tx
      .select({ id: sales.id })
      .from(sales)
      .where(eq(sales.id, params.saleId))
      .get();
    if (existing) {
      return { saleId: params.saleId, alreadyRecorded: true, totals, settlement };
    }

    tx.insert(sales)
      .values({
        id: params.saleId,
        cashSessionId: params.cashSessionId,
        createdAt: occurredAt,
        totalCents: totals.totalCents,
        dueCents: settlement.dueCents,
        changeCents: settlement.changeCents,
        cashRoundingCents: settlement.cashRoundingCents,
        input: { sale: saleInput, payments: params.payments },
      })
      .run();

    for (const [i, { line, productId }] of params.lines.entries()) {
      const lineTotals = totals.lines[i];
      if (!lineTotals) throw new Error("unreachable: line totals missing");
      tx.insert(saleLines)
        .values({
          id: line.id,
          saleId: params.saleId,
          productId,
          qtyMilli: line.qtyMilli,
          unitPriceCents: line.unitPriceCents,
          grossCents: lineTotals.grossCents,
          discountCents:
            lineTotals.lineDiscountCents + lineTotals.orderDiscountCents,
          totalCents: lineTotals.totalCents,
          taxCodes: line.taxCodes,
        })
        .run();

      tx.insert(stockMovements)
        .values({
          id: `${params.saleId}/${line.id}`,
          productId,
          kind: "sale",
          qtyMilli: line.qtyMilli,
          saleId: params.saleId,
          createdAt: occurredAt,
        })
        .run();
    }

    for (const [i, p] of params.payments.entries()) {
      tx.insert(paymentsTable)
        .values({
          id: `${params.saleId}/${i}`,
          saleId: params.saleId,
          method: p.method,
          amountCents: p.amountCents,
        })
        .run();
    }

    const cashApplied = settlement.appliedByMethod.find(
      (p) => p.method === "cash",
    );
    if (cashApplied && cashApplied.appliedCents > 0) {
      tx.insert(cashMovements)
        .values({
          id: `${params.saleId}/cash`,
          sessionId: params.cashSessionId,
          kind: "cash_sale",
          amountCents: cashApplied.appliedCents,
          saleId: params.saleId,
          createdAt: occurredAt,
        })
        .run();
    }

    appendOutboxEvent(tx, {
      ...buildEnvelope(tx, ctx, occurredAt),
      type: "sale_completed",
      saleId: params.saleId,
      cashSessionId: params.cashSessionId,
      sale: saleInput,
      payments: params.payments,
      reportedTotalCents: totals.totalCents,
    });

    return { saleId: params.saleId, alreadyRecorded: false, totals, settlement };
  });
}
