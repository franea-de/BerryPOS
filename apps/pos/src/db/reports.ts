import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { PaymentMethod } from "@berrypos/domain";
import type { DbLike } from "./context.js";
import { cashSessions, payments, sales } from "./schema.js";

/**
 * Read-only projections for shift close and the admin summary. Everything is
 * derived from the persisted facts — nothing here writes.
 */

export interface SessionSalesSummary {
  salesCount: number;
  totalCents: number;
  /** Amount APPLIED per method (cash = tendered − change). */
  byMethod: Array<{ method: PaymentMethod; amountCents: number }>;
}

export function getSessionSalesSummary(
  db: DbLike,
  sessionId: string,
): SessionSalesSummary {
  const sessionSales = db
    .select()
    .from(sales)
    .where(eq(sales.cashSessionId, sessionId))
    .all();
  if (sessionSales.length === 0) {
    return { salesCount: 0, totalCents: 0, byMethod: [] };
  }

  const rows = db
    .select()
    .from(payments)
    .where(
      inArray(
        payments.saleId,
        sessionSales.map((s) => s.id),
      ),
    )
    .all();

  const changeBySale = new Map(sessionSales.map((s) => [s.id, s.changeCents]));
  const byMethod = new Map<PaymentMethod, number>();
  for (const p of rows) {
    const method = p.method as PaymentMethod;
    // Change always comes out of the cash tender.
    const applied =
      method === "cash"
        ? p.amountCents - (changeBySale.get(p.saleId) ?? 0)
        : p.amountCents;
    byMethod.set(method, (byMethod.get(method) ?? 0) + applied);
  }

  return {
    salesCount: sessionSales.length,
    totalCents: sessionSales.reduce((a, s) => a + s.totalCents, 0),
    byMethod: [...byMethod.entries()].map(([method, amountCents]) => ({
      method,
      amountCents,
    })),
  };
}

export interface CashierDaySummary {
  cashierId: string;
  salesCount: number;
  totalCents: number;
  /** Sum of over/short across the cashier's CLOSED sessions of the day. */
  overShortCents: number;
  sessionsCount: number;
  openSessions: number;
}

/** Per-cashier activity for sessions opened in [dayStartIso, dayEndIso). */
export function getDailyCashierSummary(
  db: DbLike,
  dayStartIso: string,
  dayEndIso: string,
): CashierDaySummary[] {
  const sessions = db
    .select()
    .from(cashSessions)
    .where(
      and(
        gte(cashSessions.openedAt, dayStartIso),
        lt(cashSessions.openedAt, dayEndIso),
      ),
    )
    .all();

  const byCashier = new Map<string, CashierDaySummary>();
  for (const session of sessions) {
    const summary = getSessionSalesSummary(db, session.id);
    const row = byCashier.get(session.cashierId) ?? {
      cashierId: session.cashierId,
      salesCount: 0,
      totalCents: 0,
      overShortCents: 0,
      sessionsCount: 0,
      openSessions: 0,
    };
    row.salesCount += summary.salesCount;
    row.totalCents += summary.totalCents;
    row.overShortCents += session.overShortCents ?? 0;
    row.sessionsCount += 1;
    if (!session.closedAt) row.openSessions += 1;
    byCashier.set(session.cashierId, row);
  }
  return [...byCashier.values()].sort((a, b) => b.totalCents - a.totalCents);
}
