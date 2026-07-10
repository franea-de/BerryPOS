import { z } from "zod";
import { PromotionSchema, TaxDefinitionSchema } from "@berrypos/domain";

/**
 * Cloud → store master data (the downstream). Versioned by a monotonically
 * increasing `revision`; the store keeps the highest revision it has applied
 * and asks for anything newer. Master data is last-write-wins by revision —
 * the cloud is the source of truth here (ARCHITECTURE.md §3). Stock is NEVER
 * pushed downstream as a value: it is always reconciled from movements.
 */

export const CatalogProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  categoryId: z.string().min(1).optional(),
  /** Regular retail EAN/UPC codes; scale codes resolve via `scaleItemCode`. */
  barcodes: z.array(z.string().min(1)),
  /** 5-digit item code embedded by the scale, when the product is weighed. */
  scaleItemCode: z.string().regex(/^\d{5}$/).optional(),
  /** Sold by weight/volume: quantities move in fractional QtyMilli. */
  isWeighable: z.boolean(),
  unitPriceCents: z.number().int().min(0),
  taxCodes: z.array(z.string().min(1)),
  active: z.boolean(),
});
export type CatalogProduct = z.infer<typeof CatalogProductSchema>;

export const CategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const PosUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(["cashier", "supervisor", "admin"]),
  /** PIN hash — never the PIN itself. */
  pinHash: z.string().min(1),
  active: z.boolean(),
});

/** Full snapshot at a revision. v1 syncs snapshots; diffs come later. */
export const CatalogSnapshotSchema = z.object({
  revision: z.number().int().min(0),
  products: z.array(CatalogProductSchema),
  categories: z.array(CategorySchema),
  taxCatalog: z.array(TaxDefinitionSchema),
  promotions: z.array(PromotionSchema),
  users: z.array(PosUserSchema),
});
export type CatalogSnapshot = z.input<typeof CatalogSnapshotSchema>;

export const SyncPullRequestSchema = z.object({
  tenantId: z.string().min(1),
  storeId: z.string().min(1),
  /** Highest revision the store has applied. */
  sinceRevision: z.number().int().min(0),
});
export type SyncPullRequest = z.infer<typeof SyncPullRequestSchema>;

export const SyncPullResponseSchema = z.discriminatedUnion("status", [
  /** Store is already at the latest revision. */
  z.object({ status: z.literal("up_to_date"), revision: z.number().int().min(0) }),
  /** New master data: apply the snapshot atomically, then store `revision`. */
  z.object({ status: z.literal("snapshot"), snapshot: CatalogSnapshotSchema }),
]);
export type SyncPullResponse = z.input<typeof SyncPullResponseSchema>;
