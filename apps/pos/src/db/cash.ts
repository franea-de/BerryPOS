import { eq, isNull, sql } from "drizzle-orm";
import {
  closeCashSession as computeZReport,
  computeExpectedCash,
  type CashMovementInput,
  type CashSessionZReport,
} from "@berrypos/domain";
import { appendOutboxEvent, buildEnvelope, nowIso, type DbLike, type DeviceContext, type PosDb } from "./context.js";
import { cashMovements, cashSessions } from "./schema.js";

export interface OpenSessionParams {
  /** Client-generated UUID — idempotency key. */
  sessionId: string;
  cashierId: string;
  openingFloatCents: number;
  occurredAt?: string;
}

export function openCashSession(
  db: PosDb,
  ctx: DeviceContext,
  params: OpenSessionParams,
): { alreadyOpen: boolean } {
  const occurredAt = params.occurredAt ?? nowIso();
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: cashSessions.id })
      .from(cashSessions)
      .where(eq(cashSessions.id, params.sessionId))
      .get();
    if (existing) return { alreadyOpen: true };

    tx.insert(cashSessions)
      .values({
        id: params.sessionId,
        cashierId: params.cashierId,
        openedAt: occurredAt,
      })
      .run();
    if (params.openingFloatCents > 0) {
      tx.insert(cashMovements)
        .values({
          id: `${params.sessionId}/open`,
          sessionId: params.sessionId,
          kind: "opening_float",
          amountCents: params.openingFloatCents,
          createdAt: occurredAt,
        })
        .run();
    }

    appendOutboxEvent(tx, {
      ...buildEnvelope(tx, ctx, occurredAt),
      type: "cash_session_opened",
      cashSessionId: params.sessionId,
      cashierId: params.cashierId,
      openingFloatCents: params.openingFloatCents,
    });
    return { alreadyOpen: false };
  });
}

export interface CashInOutParams {
  /** Client-generated UUID — idempotency key. */
  movementId: string;
  sessionId: string;
  kind: "pay_in" | "pay_out" | "refund";
  amountCents: number;
  note?: string;
  occurredAt?: string;
}

/** Manual drawer movement (retiro, ingreso, devolución en efectivo). */
export function recordCashMovement(
  db: PosDb,
  ctx: DeviceContext,
  params: CashInOutParams,
): { alreadyRecorded: boolean } {
  const occurredAt = params.occurredAt ?? nowIso();
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: cashMovements.id })
      .from(cashMovements)
      .where(eq(cashMovements.id, params.movementId))
      .get();
    if (existing) return { alreadyRecorded: true };

    assertSessionOpen(tx, params.sessionId);
    // Domain guard: the drawer can never go negative.
    const movements = [
      ...loadSessionMovements(tx, params.sessionId),
      {
        id: params.movementId,
        kind: params.kind,
        amountCents: params.amountCents,
        ...(params.note ? { note: params.note } : {}),
      },
    ];
    computeExpectedCash(movements);

    tx.insert(cashMovements)
      .values({
        id: params.movementId,
        sessionId: params.sessionId,
        kind: params.kind,
        amountCents: params.amountCents,
        note: params.note ?? null,
        createdAt: occurredAt,
      })
      .run();

    appendOutboxEvent(tx, {
      ...buildEnvelope(tx, ctx, occurredAt),
      type: "cash_movement_recorded",
      cashSessionId: params.sessionId,
      movement: {
        id: params.movementId,
        kind: params.kind,
        amountCents: params.amountCents,
        ...(params.note ? { note: params.note } : {}),
      },
    });
    return { alreadyRecorded: false };
  });
}

export interface CloseSessionParams {
  sessionId: string;
  /** Blind count entered by the cashier. */
  countedCents: number;
  occurredAt?: string;
}

/** Close the session: compute the Z report and freeze it on the session row. */
export function closeCashSession(
  db: PosDb,
  ctx: DeviceContext,
  params: CloseSessionParams,
): CashSessionZReport {
  const occurredAt = params.occurredAt ?? nowIso();
  return db.transaction((tx) => {
    const session = assertSessionOpen(tx, params.sessionId);
    const movements = loadSessionMovements(tx, params.sessionId);
    const z = computeZReport({ movements, countedCents: params.countedCents });

    tx.update(cashSessions)
      .set({
        closedAt: occurredAt,
        countedCents: z.countedCents,
        expectedCents: z.expectedCents,
        overShortCents: z.overShortCents,
      })
      .where(eq(cashSessions.id, params.sessionId))
      .run();

    appendOutboxEvent(tx, {
      ...buildEnvelope(tx, ctx, occurredAt),
      type: "cash_session_closed",
      cashSessionId: params.sessionId,
      cashierId: session.cashierId,
      close: { movements, countedCents: params.countedCents },
    });
    return z;
  });
}

/** Current expected cash of an open session (for the UI, not for the count). */
export function getExpectedCash(db: DbLike, sessionId: string): number {
  return computeExpectedCash(loadSessionMovements(db, sessionId));
}

export type CashSessionRow = typeof cashSessions.$inferSelect;

/** The drawer has at most one open session (shift) at a time. */
export function getOpenSession(db: DbLike): CashSessionRow | undefined {
  return db
    .select()
    .from(cashSessions)
    .where(isNull(cashSessions.closedAt))
    .get();
}

function assertSessionOpen(tx: DbLike, sessionId: string) {
  const session = tx
    .select()
    .from(cashSessions)
    .where(eq(cashSessions.id, sessionId))
    .get();
  if (!session) throw new Error(`cash session "${sessionId}" does not exist`);
  if (session.closedAt) {
    throw new Error(`cash session "${sessionId}" is already closed`);
  }
  return session;
}

function loadSessionMovements(
  tx: DbLike,
  sessionId: string,
): CashMovementInput[] {
  return tx
    .select()
    .from(cashMovements)
    .where(eq(cashMovements.sessionId, sessionId))
    // Ledger order is INSERTION order, never the wall clock: occurredAt can
    // go backwards (clock drift, replays) but appends cannot.
    .orderBy(sql`rowid`)
    .all()
    .map((m) => ({
      id: m.id,
      kind: m.kind as CashMovementInput["kind"],
      amountCents: m.amountCents,
      ...(m.note ? { note: m.note } : {}),
    }));
}
