import { eq, inArray, notInArray } from "drizzle-orm";
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
import {
  appendOutboxEvent,
  buildEnvelope,
  nowIso,
  type DeviceContext,
  type DbLike,
  type PosDb,
} from "./context.js";
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
 * Apply a downstream snapshot atomically: cloud-owned master data is fully
 * replaced and the revision recorded in the same transaction (last-write-wins
 * by revision, ARCHITECTURE.md §3). Stale or repeated snapshots are ignored.
 *
 * Products registered at this device (`source: "local"`) survive the
 * replacement until a snapshot carries the same id — then the cloud copy
 * supersedes them.
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

    const snapshotIds = snapshot.products.map((p) => p.id);
    tx.delete(products).where(eq(products.source, "cloud")).run();
    if (snapshotIds.length > 0) {
      tx.delete(products).where(inArray(products.id, snapshotIds)).run();
    }
    const localSurvivors = tx.select({ id: products.id }).from(products).all();
    if (localSurvivors.length > 0) {
      tx.delete(productBarcodes)
        .where(
          notInArray(
            productBarcodes.productId,
            localSurvivors.map((p) => p.id),
          ),
        )
        .run();
    } else {
      tx.delete(productBarcodes).run();
    }
    for (const table of [categories, taxes, promotions, users]) {
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
          source: "cloud" as const,
        })
        .run();
      for (const barcode of p.barcodes) {
        // The cloud owns barcode assignments: on collision with a local
        // product's code, the snapshot wins.
        tx.insert(productBarcodes)
          .values({ barcode, productId: p.id })
          .onConflictDoUpdate({
            target: productBarcodes.barcode,
            set: { productId: p.id },
          })
          .run();
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

export interface NewProductInput {
  /** Client-generated UUID — idempotency key. */
  id: string;
  name: string;
  /** The scanned factory barcode, or a generated internal one. */
  barcode: string;
  unitPriceCents: number;
  isWeighable: boolean;
  categoryId?: string;
  taxCodes: string[];
  occurredAt?: string;
}

/**
 * Register a product at the register (alta rápida): stored locally with
 * `source: "local"` and pushed to the cloud as a product_created event so
 * the tenant catalog adopts it.
 */
export function createProduct(
  db: PosDb,
  ctx: DeviceContext,
  params: NewProductInput,
): { alreadyExists: boolean; product: ProductRow } {
  const occurredAt = params.occurredAt ?? nowIso();
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(products)
      .where(eq(products.id, params.id))
      .get();
    if (existing) return { alreadyExists: true, product: existing };

    const taken = tx
      .select()
      .from(productBarcodes)
      .where(eq(productBarcodes.barcode, params.barcode))
      .get();
    if (taken) {
      throw new Error(
        `barcode "${params.barcode}" is already assigned to product "${taken.productId}"`,
      );
    }

    const row = {
      id: params.id,
      name: params.name,
      categoryId: params.categoryId ?? null,
      scaleItemCode: null,
      isWeighable: params.isWeighable,
      unitPriceCents: params.unitPriceCents,
      taxCodes: params.taxCodes,
      active: true,
      source: "local" as const,
    };
    tx.insert(products).values(row).run();
    tx.insert(productBarcodes)
      .values({ barcode: params.barcode, productId: params.id })
      .run();

    appendOutboxEvent(tx, {
      ...buildEnvelope(tx, ctx, occurredAt),
      type: "product_created",
      product: {
        id: params.id,
        name: params.name,
        ...(params.categoryId ? { categoryId: params.categoryId } : {}),
        barcodes: [params.barcode],
        isWeighable: params.isWeighable,
        unitPriceCents: params.unitPriceCents,
        taxCodes: params.taxCodes,
        active: true,
      },
    });
    return { alreadyExists: false, product: row };
  });
}

/** Assign an additional barcode to an existing product. */
export function addProductBarcode(
  db: PosDb,
  ctx: DeviceContext,
  params: { productId: string; barcode: string; occurredAt?: string },
): { alreadyAssigned: boolean } {
  const occurredAt = params.occurredAt ?? nowIso();
  return db.transaction((tx) => {
    const taken = tx
      .select()
      .from(productBarcodes)
      .where(eq(productBarcodes.barcode, params.barcode))
      .get();
    if (taken) {
      if (taken.productId === params.productId) return { alreadyAssigned: true };
      throw new Error(
        `barcode "${params.barcode}" is already assigned to product "${taken.productId}"`,
      );
    }
    const product = tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, params.productId))
      .get();
    if (!product) {
      throw new Error(`product "${params.productId}" does not exist`);
    }

    tx.insert(productBarcodes)
      .values({ barcode: params.barcode, productId: params.productId })
      .run();
    appendOutboxEvent(tx, {
      ...buildEnvelope(tx, ctx, occurredAt),
      type: "product_barcode_added",
      productId: params.productId,
      barcode: params.barcode,
    });
    return { alreadyAssigned: false };
  });
}

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
