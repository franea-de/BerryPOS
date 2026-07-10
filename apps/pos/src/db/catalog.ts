import { eq } from "drizzle-orm";
import {
  parseScaleEan13,
  type PromotionInput,
  type ScaleBarcodeConfig,
  type TaxDefinitionInput,
} from "@berrypos/domain";
import {
  CatalogSnapshotSchema,
  type CatalogSnapshot,
} from "@berrypos/sync-contracts";
import type { DbLike, PosDb } from "./context.js";
import {
  categories,
  productBarcodes,
  products,
  promotions,
  syncState,
  taxes,
  users,
} from "./schema.js";

const REVISION_KEY = "catalog_revision";

export function getCatalogRevision(db: DbLike): number {
  const row = db
    .select()
    .from(syncState)
    .where(eq(syncState.key, REVISION_KEY))
    .get();
  return row ? Number(row.value) : -1;
}

/**
 * Apply a downstream snapshot atomically: master data is fully replaced and
 * the revision recorded in the same transaction (last-write-wins by revision,
 * ARCHITECTURE.md §3). Stale or repeated snapshots are ignored.
 */
export function applyCatalogSnapshot(
  db: PosDb,
  input: CatalogSnapshot,
): { applied: boolean; revision: number } {
  const snapshot = CatalogSnapshotSchema.parse(input);

  return db.transaction((tx) => {
    const current = getCatalogRevision(tx);
    if (snapshot.revision <= current) {
      return { applied: false, revision: current };
    }

    for (const table of [products, productBarcodes, categories, taxes, promotions, users]) {
      tx.delete(table).run();
    }

    for (const p of snapshot.products) {
      tx.insert(products)
        .values({
          id: p.id,
          name: p.name,
          categoryId: p.categoryId ?? null,
          scaleItemCode: p.scaleItemCode ?? null,
          isWeighable: p.isWeighable,
          unitPriceCents: p.unitPriceCents,
          taxCodes: p.taxCodes,
          active: p.active,
        })
        .run();
      for (const barcode of p.barcodes) {
        tx.insert(productBarcodes).values({ barcode, productId: p.id }).run();
      }
    }
    for (const c of snapshot.categories) {
      tx.insert(categories).values(c).run();
    }
    for (const t of snapshot.taxCatalog) {
      tx.insert(taxes).values(t).run();
    }
    for (const promo of snapshot.promotions) {
      tx.insert(promotions).values({ id: promo.id, data: promo }).run();
    }
    for (const u of snapshot.users) {
      tx.insert(users).values(u).run();
    }

    tx.insert(syncState)
      .values({ key: REVISION_KEY, value: String(snapshot.revision) })
      .onConflictDoUpdate({
        target: syncState.key,
        set: { value: String(snapshot.revision) },
      })
      .run();

    return { applied: true, revision: snapshot.revision };
  });
}

export function getTaxCatalog(db: DbLike): TaxDefinitionInput[] {
  return db.select().from(taxes).all();
}

export function getPromotions(db: DbLike): PromotionInput[] {
  return db
    .select()
    .from(promotions)
    .all()
    .map((row) => row.data as PromotionInput);
}

export type ProductRow = typeof products.$inferSelect;

export type ScanResult =
  | { kind: "product"; product: ProductRow }
  | { kind: "weighed"; product: ProductRow; qtyMilli: number }
  | { kind: "priced"; product: ProductRow; priceCents: number }
  | { kind: "not_found" };

/**
 * Resolve a scanned barcode: scale codes (weight/price embedded) resolve via
 * the product's scale item code; anything else via the barcode table.
 * Throws on a scale-prefixed code with a bad check digit (misread).
 */
export function findProductByScan(
  db: DbLike,
  code: string,
  scaleConfig?: ScaleBarcodeConfig,
): ScanResult {
  const scale = parseScaleEan13(code, scaleConfig);
  if (scale) {
    const product = db
      .select()
      .from(products)
      .where(eq(products.scaleItemCode, scale.itemCode))
      .get();
    if (!product || !product.active) return { kind: "not_found" };
    return scale.kind === "weight"
      ? { kind: "weighed", product, qtyMilli: scale.weightQtyMilli }
      : { kind: "priced", product, priceCents: scale.priceCents };
  }

  const link = db
    .select()
    .from(productBarcodes)
    .where(eq(productBarcodes.barcode, code))
    .get();
  if (!link) return { kind: "not_found" };
  const product = db
    .select()
    .from(products)
    .where(eq(products.id, link.productId))
    .get();
  if (!product || !product.active) return { kind: "not_found" };
  return { kind: "product", product };
}
