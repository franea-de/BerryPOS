import { eq, sql } from "drizzle-orm";
import { computeSaleTotals } from "@berrypos/domain";
import {
  SyncPushRequestSchema,
  SyncPullRequestSchema,
  type SyncPushResponse,
  type SyncPullResponse,
} from "@berrypos/sync-contracts";
import {
  cloudSales,
  inboxEvents,
  cloudCategories,
  cloudProducts,
  cloudProductBarcodes,
  cloudTaxes,
  cloudPromotions,
  cloudPosUsers,
  cloudCatalogRevisions,
} from "../db/schema.js";
import type { ApiDb } from "../db/client.js";

export interface DeviceIdentity {
  tenantId: string;
  storeId: string;
  deviceId: string;
}

/**
 * The cloud half of the sync protocol (ARCHITECTURE.md §3): an idempotent
 * inbox. Every event is validated against the shared contract, verified
 * (the cloud must reproduce the totals the POS reported — a mismatch is a
 * rejection, never a silent discrepancy) and inserted exactly once: the
 * client-generated event id is the primary key, so a retry after a lost
 * ack simply reports "duplicate" and the register clears its outbox.
 */
export class SyncInbox {
  constructor(private readonly db: ApiDb) {}

  async push(identity: DeviceIdentity, body: unknown): Promise<SyncPushResponse> {
    const { events } = SyncPushRequestSchema.parse(body);

    const accepted: string[] = [];
    const duplicates: string[] = [];
    const rejected: Array<{ eventId: string; reason: string }> = [];

    await this.db.transaction(async (tx) => {
      // Scope the whole transaction to the authenticated tenant (RLS).
      await tx.execute(
        sql`select set_config('app.tenant_id', ${identity.tenantId}, true)`,
      );

      for (const event of events) {
        // The envelope must match the credentials that pushed it.
        if (
          event.tenantId !== identity.tenantId ||
          event.storeId !== identity.storeId ||
          event.deviceId !== identity.deviceId
        ) {
          rejected.push({
            eventId: event.eventId,
            reason: "envelope does not match the device credentials",
          });
          continue;
        }

        if (event.type === "sale_completed") {
          const totals = computeSaleTotals(event.sale);
          if (totals.totalCents !== event.reportedTotalCents) {
            rejected.push({
              eventId: event.eventId,
              reason: `reported total mismatch: cloud computed ${totals.totalCents}, POS reported ${event.reportedTotalCents}`,
            });
            continue;
          }
        }

        const inserted = await tx
          .insert(inboxEvents)
          .values({
            eventId: event.eventId,
            tenantId: event.tenantId,
            storeId: event.storeId,
            deviceId: event.deviceId,
            deviceSeq: event.seq,
            type: event.type,
            payload: event,
            occurredAt: event.occurredAt,
          })
          .onConflictDoNothing({ target: inboxEvents.eventId })
          .returning({ eventId: inboxEvents.eventId });

        if (inserted.length > 0) {
          accepted.push(event.eventId);
          // Keep the reporting projection in the same transaction: the
          // panel is always consistent with what the inbox accepted.
          if (event.type === "sale_completed") {
            await tx
              .insert(cloudSales)
              .values({
                saleId: event.saleId,
                tenantId: event.tenantId,
                storeId: event.storeId,
                deviceId: event.deviceId,
                totalCents: event.reportedTotalCents,
                occurredAt: event.occurredAt,
                paymentMethods: [
                  ...new Set(event.payments.map((p) => p.method)),
                ],
              })
              .onConflictDoNothing();
          } else if (event.type === "sale_voided") {
            await tx
              .update(cloudSales)
              .set({ voided: true })
              .where(eq(cloudSales.saleId, event.saleId));
          } else if (event.type === "product_created") {
            await tx
              .insert(cloudProducts)
              .values({
                tenantId: event.tenantId,
                id: event.product.id,
                name: event.product.name,
                categoryId: event.product.categoryId ?? null,
                scaleItemCode: event.product.scaleItemCode ?? null,
                isWeighable: event.product.isWeighable,
                unitPriceCents: event.product.unitPriceCents,
                taxCodes: event.product.taxCodes,
                active: event.product.active,
              })
              .onConflictDoUpdate({
                target: [cloudProducts.tenantId, cloudProducts.id],
                set: {
                  name: event.product.name,
                  categoryId: event.product.categoryId ?? null,
                  scaleItemCode: event.product.scaleItemCode ?? null,
                  isWeighable: event.product.isWeighable,
                  unitPriceCents: event.product.unitPriceCents,
                  taxCodes: event.product.taxCodes,
                  active: event.product.active,
                },
              });
            for (const barcode of event.product.barcodes) {
              await tx
                .insert(cloudProductBarcodes)
                .values({
                  tenantId: event.tenantId,
                  barcode,
                  productId: event.product.id,
                })
                .onConflictDoNothing();
            }
            await tx
              .insert(cloudCatalogRevisions)
              .values({ tenantId: event.tenantId, revision: 1 })
              .onConflictDoUpdate({
                target: cloudCatalogRevisions.tenantId,
                set: { revision: sql`${cloudCatalogRevisions.revision} + 1` },
              });
          } else if (event.type === "product_barcode_added") {
            await tx
              .insert(cloudProductBarcodes)
              .values({
                tenantId: event.tenantId,
                barcode: event.barcode,
                productId: event.productId,
              })
              .onConflictDoNothing();
            await tx
              .insert(cloudCatalogRevisions)
              .values({ tenantId: event.tenantId, revision: 1 })
              .onConflictDoUpdate({
                target: cloudCatalogRevisions.tenantId,
                set: { revision: sql`${cloudCatalogRevisions.revision} + 1` },
              });
          }
        } else {
          duplicates.push(event.eventId);
        }
      }
    });

    return { accepted, duplicates, rejected };
  }

  async pull(identity: { tenantId: string }, body: unknown): Promise<SyncPullResponse> {
    const req = SyncPullRequestSchema.parse(body);

    if (req.tenantId !== identity.tenantId) {
      throw new Error("tenantId in request does not match device identity");
    }

    const [revRow] = await this.db
      .select()
      .from(cloudCatalogRevisions)
      .where(eq(cloudCatalogRevisions.tenantId, req.tenantId));
    const currentRevision = revRow ? revRow.revision : 0;

    if (req.sinceRevision >= currentRevision) {
      return { status: "up_to_date" as const, revision: currentRevision };
    }

    // Compile a full CatalogSnapshot
    const [productsList, barcodesList, categoriesList, taxesList, promotionsList, usersList] =
      await Promise.all([
        this.db.select().from(cloudProducts).where(eq(cloudProducts.tenantId, req.tenantId)),
        this.db.select().from(cloudProductBarcodes).where(eq(cloudProductBarcodes.tenantId, req.tenantId)),
        this.db.select().from(cloudCategories).where(eq(cloudCategories.tenantId, req.tenantId)),
        this.db.select().from(cloudTaxes).where(eq(cloudTaxes.tenantId, req.tenantId)),
        this.db.select().from(cloudPromotions).where(eq(cloudPromotions.tenantId, req.tenantId)),
        this.db.select().from(cloudPosUsers).where(eq(cloudPosUsers.tenantId, req.tenantId)),
      ]);

    const barcodesMap = new Map<string, string[]>();
    for (const b of barcodesList) {
      const list = barcodesMap.get(b.productId) ?? [];
      list.push(b.barcode);
      barcodesMap.set(b.productId, list);
    }

    const products = productsList.map((p) => ({
      id: p.id,
      name: p.name,
      categoryId: p.categoryId ?? undefined,
      barcodes: barcodesMap.get(p.id) ?? [],
      scaleItemCode: p.scaleItemCode ?? undefined,
      isWeighable: p.isWeighable,
      unitPriceCents: p.unitPriceCents,
      taxCodes: p.taxCodes,
      active: p.active,
    }));

    const categories = categoriesList.map((c) => ({
      id: c.id,
      name: c.name,
    }));

    const taxCatalog = taxesList.map((t) => ({
      code: t.code,
      name: t.name,
      rateBp: t.rateBp,
      includedInPrice: t.includedInPrice,
    }));

    const promotions = promotionsList.map((p) => p.data as any);

    const users = usersList.map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role as "cashier" | "supervisor" | "admin",
      pinHash: u.pinHash,
      active: u.active,
    }));

    return {
      status: "snapshot" as const,
      snapshot: {
        revision: currentRevision,
        products,
        categories,
        taxCatalog,
        promotions,
        users,
      },
    };
  }
}
