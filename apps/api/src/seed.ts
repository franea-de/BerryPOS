import { and, eq, isNull } from "drizzle-orm";
import {
  devices,
  stores,
  tenants,
  cloudCatalogRevisions,
  cloudCategories,
  cloudTaxes,
  cloudPromotions,
  cloudPosUsers,
  cloudProducts,
  cloudProductBarcodes,
} from "./db/schema.js";
import type { ApiDb } from "./db/client.js";

/** Dev convenience: a tenant/store/device so the register can sync locally. */
export async function ensureDevTenant(db: ApiDb): Promise<void> {
  // Older dev tenants predate the admin token: top it up.
  await db
    .update(tenants)
    .set({ adminToken: process.env.BERRYPOS_DEV_ADMIN_TOKEN ?? "dev-admin" })
    .where(and(eq(tenants.id, "dev"), isNull(tenants.adminToken)));

  const existing = await db.select().from(devices);
  if (existing.length > 0) return;

  await db
    .insert(tenants)
    .values({
      id: "dev",
      name: "Tenant de desarrollo",
      adminToken: process.env.BERRYPOS_DEV_ADMIN_TOKEN ?? "dev-admin",
    })
    .onConflictDoNothing();
  await db
    .insert(stores)
    .values({ tenantId: "dev", id: "tienda-1", name: "Tienda 1" })
    .onConflictDoNothing();
  await db
    .insert(devices)
    .values({
      tenantId: "dev",
      storeId: "tienda-1",
      id: "caja-1",
      name: "Caja 1",
      apiKey: process.env.BERRYPOS_DEV_API_KEY ?? "dev-key",
    })
    .onConflictDoNothing();
  console.log("seeded dev tenant/store/device (api key: dev-key)");

  // Seed default catalog in the cloud (revision 3)
  const existingProducts = await db.select().from(cloudProducts).where(eq(cloudProducts.tenantId, "dev"));
  if (existingProducts.length > 0) return;

  await db
    .insert(cloudCatalogRevisions)
    .values({ tenantId: "dev", revision: 3 })
    .onConflictDoNothing();

  await db
    .insert(cloudCategories)
    .values([
      { tenantId: "dev", id: "bebidas", name: "Bebidas" },
      { tenantId: "dev", id: "abarrotes", name: "Abarrotes" },
      { tenantId: "dev", id: "lacteos", name: "Lácteos" },
      { tenantId: "dev", id: "verduras", name: "Verduras" },
      { tenantId: "dev", id: "snacks", name: "Snacks" },
    ])
    .onConflictDoNothing();

  await db
    .insert(cloudTaxes)
    .values([
      { tenantId: "dev", code: "IGV18", name: "IGV 18%", rateBp: 1800, includedInPrice: true },
    ])
    .onConflictDoNothing();

  await db
    .insert(cloudPromotions)
    .values([
      { tenantId: "dev", id: "2x1-soda", data: { id: "2x1-soda", name: "2x1 gaseosas", type: "nxm", productIds: ["soda"], buyQty: 2, payQty: 1 } },
      { tenantId: "dev", id: "vol-rice", data: { id: "vol-rice", name: "Arroz desde 2 kg a S/ 4.20", type: "volume_price", productIds: ["rice"], minQtyMilli: 2000, unitPriceCents: 420 } },
      { tenantId: "dev", id: "snacks-10", data: { id: "snacks-10", name: "10% snacks", type: "category_percent", categoryIds: ["snacks"], valueBp: 1000 } },
    ])
    .onConflictDoNothing();

  await db
    .insert(cloudPosUsers)
    .values([
      {
        tenantId: "dev",
        id: "admin",
        name: "Administrador",
        role: "admin",
        pinHash: "888df25ae35772424a560c7152a1de794440e0ea5cfee62828333a456a506e05",
        active: true,
      },
      {
        tenantId: "dev",
        id: "cajero-1",
        name: "Cajero 1",
        role: "cashier",
        pinHash: "0ffe1abd1a08215353c233d6e009613e95eec4253832a761af28ff37ac5a150c",
        active: true,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(cloudProducts)
    .values([
      { tenantId: "dev", id: "soda", name: "Inca Kola 1.5L", categoryId: "bebidas", isWeighable: false, unitPriceCents: 850, taxCodes: ["IGV18"], active: true },
      { tenantId: "dev", id: "bread", name: "Pan de molde", categoryId: "abarrotes", isWeighable: false, unitPriceCents: 690, taxCodes: ["IGV18"], active: true },
      { tenantId: "dev", id: "milk", name: "Leche evaporada 400g", categoryId: "lacteos", isWeighable: false, unitPriceCents: 480, taxCodes: ["IGV18"], active: true },
      { tenantId: "dev", id: "rice", name: "Arroz a granel (kg)", categoryId: "abarrotes", scaleItemCode: "12345", isWeighable: true, unitPriceCents: 450, taxCodes: ["IGV18"], active: true },
      { tenantId: "dev", id: "tomato", name: "Tomate (kg)", categoryId: "verduras", scaleItemCode: "20001", isWeighable: true, unitPriceCents: 380, taxCodes: ["IGV18"], active: true },
      { tenantId: "dev", id: "chips", name: "Papas fritas 200g", categoryId: "snacks", isWeighable: false, unitPriceCents: 750, taxCodes: ["IGV18"], active: true },
      { tenantId: "dev", id: "coke", name: "Coca Cola 500ml (Nube)", categoryId: "bebidas", isWeighable: false, unitPriceCents: 350, taxCodes: ["IGV18"], active: true },
    ])
    .onConflictDoNothing();

  await db
    .insert(cloudProductBarcodes)
    .values([
      { tenantId: "dev", barcode: "7751234567892", productId: "soda" },
      { tenantId: "dev", barcode: "7752345678903", productId: "bread" },
      { tenantId: "dev", barcode: "7753456789014", productId: "milk" },
      { tenantId: "dev", barcode: "7754567890125", productId: "chips" },
      { tenantId: "dev", barcode: "7750102030405", productId: "coke" },
    ])
    .onConflictDoNothing();

  console.log("seeded dev cloud catalog (revision 3)");
}
