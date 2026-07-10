import { eq } from "drizzle-orm";
import {
  projectProductStock,
  type StockMovementInput,
} from "@berrypos/domain";
import { appendOutboxEvent, buildEnvelope, nowIso, type DbLike, type DeviceContext, type PosDb } from "./context.js";
import { stockMovements } from "./schema.js";

export interface StockAdjustmentParams {
  /** Client-generated UUID — idempotency key. */
  movementId: string;
  productId: string;
  kind: Exclude<StockMovementInput["kind"], "sale">;
  qtyMilli: number;
  note?: string;
  occurredAt?: string;
}

/**
 * Record a non-sale stock movement (reception, adjustment, shrinkage,
 * transfer, customer return). Sale movements are written by recordSale.
 */
export function recordStockMovement(
  db: PosDb,
  ctx: DeviceContext,
  params: StockAdjustmentParams,
): { alreadyRecorded: boolean } {
  const occurredAt = params.occurredAt ?? nowIso();
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(eq(stockMovements.id, params.movementId))
      .get();
    if (existing) return { alreadyRecorded: true };

    tx.insert(stockMovements)
      .values({
        id: params.movementId,
        productId: params.productId,
        kind: params.kind,
        qtyMilli: params.qtyMilli,
        note: params.note ?? null,
        createdAt: occurredAt,
      })
      .run();

    appendOutboxEvent(tx, {
      ...buildEnvelope(tx, ctx, occurredAt),
      type: "stock_movement_recorded",
      movement: {
        id: params.movementId,
        productId: params.productId,
        kind: params.kind,
        qtyMilli: params.qtyMilli,
        ...(params.note ? { note: params.note } : {}),
      },
    });
    return { alreadyRecorded: false };
  });
}

/** Current stock of a product: the domain projection over its movements. */
export function getProductStock(db: DbLike, productId: string): number {
  const movements: StockMovementInput[] = db
    .select()
    .from(stockMovements)
    .where(eq(stockMovements.productId, productId))
    .all()
    .map((m) => ({
      id: m.id,
      productId: m.productId,
      kind: m.kind as StockMovementInput["kind"],
      qtyMilli: m.qtyMilli,
      ...(m.note ? { note: m.note } : {}),
    }));
  return projectProductStock(movements, productId);
}
