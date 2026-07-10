import { z } from "zod";
import { qtyMilli, type QtyMilli } from "./money.js";

/**
 * Inventory as an append-only ledger (CLAUDE.md rule #2): stock is a
 * projection over movements, never a stored value, and the cloud reconciles
 * by summing movements — never by syncing absolute stock.
 *
 * Unlike the cash drawer, stock MAY go negative: a minimarket often sells
 * merchandise before the reception paperwork is recorded. The projection
 * reports it; blocking the sale is a POS policy decision, not a domain rule.
 */

export const StockMovementKindSchema = z.enum([
  /** Units sold (out). */
  "sale",
  /** Goods received from a purchase (in). */
  "reception",
  /** Manual correction upward, e.g. found stock (in). */
  "adjustment_in",
  /** Manual correction downward (out). */
  "adjustment_out",
  /** Damage, theft, expiry — merma (out). */
  "shrinkage",
  /** Received from another branch (in). */
  "transfer_in",
  /** Sent to another branch (out). */
  "transfer_out",
  /** Customer return back to shelf (in). */
  "customer_return",
]);
export type StockMovementKind = z.infer<typeof StockMovementKindSchema>;

const INFLOW: Readonly<Record<StockMovementKind, 1 | -1>> = {
  sale: -1,
  reception: 1,
  adjustment_in: 1,
  adjustment_out: -1,
  shrinkage: -1,
  transfer_in: 1,
  transfer_out: -1,
  customer_return: 1,
};

export const StockMovementSchema = z.object({
  /** Client-generated UUID — idempotency key for sync (CLAUDE.md rule #3). */
  id: z.string().min(1),
  productId: z.string().min(1),
  kind: StockMovementKindSchema,
  /** Always positive; the kind determines the direction. Milli-units. */
  qtyMilli: z
    .number()
    .int()
    .positive()
    .transform((n) => n as QtyMilli),
  note: z.string().optional(),
});
export type StockMovementInput = z.input<typeof StockMovementSchema>;
type StockMovement = z.output<typeof StockMovementSchema>;

/** Signed effect of a movement on the product's stock. */
export function stockDelta(movement: StockMovement): QtyMilli {
  return qtyMilli(INFLOW[movement.kind] * movement.qtyMilli);
}

const MovementListSchema = z.array(StockMovementSchema);

function parseMovements(input: readonly StockMovementInput[]): StockMovement[] {
  const movements = MovementListSchema.parse(input);
  const seen = new Set<string>();
  for (const m of movements) {
    if (seen.has(m.id)) {
      throw new Error(`duplicate stock movement id "${m.id}"`);
    }
    seen.add(m.id);
  }
  return movements;
}

/** Project current stock per product over the whole movement history. */
export function projectStock(
  input: readonly StockMovementInput[],
): Map<string, QtyMilli> {
  const stock = new Map<string, QtyMilli>();
  for (const m of parseMovements(input)) {
    stock.set(m.productId, qtyMilli((stock.get(m.productId) ?? 0) + stockDelta(m)));
  }
  return stock;
}

/** Stock of a single product (0 when it has no movements). */
export function projectProductStock(
  input: readonly StockMovementInput[],
  productId: string,
): QtyMilli {
  return projectStock(input).get(productId) ?? qtyMilli(0);
}
