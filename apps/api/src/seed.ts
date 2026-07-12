import { and, eq, isNull } from "drizzle-orm";
import { devices, stores, tenants } from "./db/schema.js";
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
}
