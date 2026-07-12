import { desc, eq, gte } from "drizzle-orm";
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

export interface VoidSaleParams {
  saleId: string;
  /** User id of whoever authorized the void. */
  voidedBy: string;
  /** Open session that refunds the cash (required when cash was applied). */
  currentSessionId: string | null;
  reason?: string;
  occurredAt?: string;
}

/**
 * Void a charged sale (anulación). Ledger-style: the sale row is marked and
 * every effect gets a compensating movement — stock returns to the shelf,
 * cash leaves the CURRENT drawer as a refund. Nothing is ever deleted.
 */
export function voidSale(
  db: PosDb,
  ctx: DeviceContext,
  params: VoidSaleParams,
): { alreadyVoided: boolean } {
  const occurredAt = params.occurredAt ?? nowIso();
  return db.transaction((tx) => {
    const sale = tx
      .select()
      .from(sales)
      .where(eq(sales.id, params.saleId))
      .get();
    if (!sale) throw new Error(`sale "${params.saleId}" does not exist`);
    if (sale.voidedAt) return { alreadyVoided: true };

    tx.update(sales)
      .set({ voidedAt: occurredAt, voidedBy: params.voidedBy })
      .where(eq(sales.id, params.saleId))
      .run();

    const lines = tx
      .select()
      .from(saleLines)
      .where(eq(saleLines.saleId, params.saleId))
      .all();
    for (const line of lines) {
      tx.insert(stockMovements)
        .values({
          id: `${params.saleId}/void/${line.id}`,
          productId: line.productId,
          kind: "customer_return",
          qtyMilli: line.qtyMilli,
          saleId: params.saleId,
          note: "anulación de venta",
          createdAt: occurredAt,
        })
        .run();
    }

    // Cash applied = tendered cash − change; that money leaves the drawer now.
    const cashTendered = tx
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.saleId, params.saleId))
      .all()
      .filter((p) => p.method === "cash")
      .reduce((a, p) => a + p.amountCents, 0);
    const cashApplied = cashTendered - sale.changeCents;
    if (cashApplied > 0) {
      if (!params.currentSessionId) {
        throw new Error(
          "Para anular una venta en efectivo debe haber un turno abierto (el dinero sale de la caja)",
        );
      }
      tx.insert(cashMovements)
        .values({
          id: `${params.saleId}/void/cash`,
          sessionId: params.currentSessionId,
          kind: "refund",
          amountCents: cashApplied,
          saleId: params.saleId,
          note: "anulación de venta",
          createdAt: occurredAt,
        })
        .run();
    }

    appendOutboxEvent(tx, {
      ...buildEnvelope(tx, ctx, occurredAt),
      type: "sale_voided",
      saleId: params.saleId,
      voidedBy: params.voidedBy,
      ...(params.reason ? { reason: params.reason } : {}),
    });

    return { alreadyVoided: false };
  });
}

/** Raw rows a receipt ticket needs; the service assembles the names. */
export function getSaleForTicket(db: PosDb, saleId: string) {
  const sale = db.select().from(sales).where(eq(sales.id, saleId)).get();
  if (!sale) throw new Error(`sale "${saleId}" does not exist`);
  return {
    sale,
    lines: db.select().from(saleLines).where(eq(saleLines.saleId, saleId)).all(),
    payments: db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.saleId, saleId))
      .all(),
  };
}

export interface RecentSale {
  id: string;
  createdAt: string;
  totalCents: number;
  methods: string[];
  voidedAt: string | null;
}

/** Latest sales (for the void screen), newest first. */
export function listRecentSales(
  db: PosDb,
  opts: { sinceIso: string; limit?: number },
): RecentSale[] {
  const rows = db
    .select()
    .from(sales)
    .where(gte(sales.createdAt, opts.sinceIso))
    .orderBy(desc(sales.createdAt))
    .limit(opts.limit ?? 20)
    .all();
  return rows.map((sale) => ({
    id: sale.id,
    createdAt: sale.createdAt,
    totalCents: sale.totalCents,
    methods: [
      ...new Set(
        db
          .select()
          .from(paymentsTable)
          .where(eq(paymentsTable.saleId, sale.id))
          .all()
          .map((p) => p.method),
      ),
    ],
    voidedAt: sale.voidedAt,
  }));
}
