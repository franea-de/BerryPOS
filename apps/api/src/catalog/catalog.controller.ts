import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { DB } from "../sync/sync.controller.js";
import type { ApiDb } from "../db/client.js";
import {
  tenants,
  cloudProducts,
  cloudProductBarcodes,
  cloudCategories,
  cloudPosUsers,
  cloudCatalogRevisions,
  cloudTaxes,
} from "../db/schema.js";

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

@Controller("catalog")
export class CatalogController {
  constructor(@Inject(DB) private readonly db: ApiDb) {}

  @Get("products")
  async getProducts(@Headers("x-admin-token") token: string | undefined) {
    const tenantId = await this.authorize(token);
    const products = await this.db
      .select()
      .from(cloudProducts)
      .where(eq(cloudProducts.tenantId, tenantId));

    const barcodes = await this.db
      .select()
      .from(cloudProductBarcodes)
      .where(eq(cloudProductBarcodes.tenantId, tenantId));

    const barcodesMap = new Map<string, string[]>();
    for (const b of barcodes) {
      const list = barcodesMap.get(b.productId) ?? [];
      list.push(b.barcode);
      barcodesMap.set(b.productId, list);
    }

    return products.map((p) => ({
      ...p,
      barcodes: barcodesMap.get(p.id) ?? [],
    }));
  }

  @Post("products")
  async saveProduct(
    @Headers("x-admin-token") token: string | undefined,
    @Body() body: any,
  ) {
    const tenantId = await this.authorize(token);
    const { id, name, categoryId, scaleItemCode, isWeighable, unitPriceCents, taxCodes, active, barcodes } = body;

    if (!id || !name || typeof isWeighable !== "boolean" || typeof unitPriceCents !== "number" || typeof active !== "boolean" || !Array.isArray(taxCodes) || !Array.isArray(barcodes)) {
      throw new BadRequestException("Campos de producto inválidos");
    }

    await this.db.transaction(async (tx) => {
      // 1. Insert or update product
      await tx
        .insert(cloudProducts)
        .values({
          tenantId,
          id,
          name,
          categoryId: categoryId || null,
          scaleItemCode: scaleItemCode || null,
          isWeighable,
          unitPriceCents,
          taxCodes,
          active,
        })
        .onConflictDoUpdate({
          target: [cloudProducts.tenantId, cloudProducts.id],
          set: {
            name,
            categoryId: categoryId || null,
            scaleItemCode: scaleItemCode || null,
            isWeighable,
            unitPriceCents,
            taxCodes,
            active,
          },
        });

      // 2. Refresh barcodes for this product
      await tx
        .delete(cloudProductBarcodes)
        .where(
          sql`tenant_id = ${tenantId} and product_id = ${id}`
        );

      for (const barcode of barcodes) {
        if (!barcode) continue;
        await tx
          .insert(cloudProductBarcodes)
          .values({
            tenantId,
            barcode,
            productId: id,
          })
          .onConflictDoUpdate({
            target: [cloudProductBarcodes.tenantId, cloudProductBarcodes.barcode],
            set: { productId: id },
          });
      }

      // 3. Increment revision
      await this.incrementRevision(tx, tenantId);
    });

    return { success: true };
  }

  @Get("categories")
  async getCategories(@Headers("x-admin-token") token: string | undefined) {
    const tenantId = await this.authorize(token);
    return this.db
      .select()
      .from(cloudCategories)
      .where(eq(cloudCategories.tenantId, tenantId));
  }

  @Post("categories")
  async saveCategory(
    @Headers("x-admin-token") token: string | undefined,
    @Body() body: any,
  ) {
    const tenantId = await this.authorize(token);
    const { id, name } = body;
    if (!id || !name) {
      throw new BadRequestException("Campos de categoría inválidos");
    }

    await this.db.transaction(async (tx) => {
      await tx
        .insert(cloudCategories)
        .values({ tenantId, id, name })
        .onConflictDoUpdate({
          target: [cloudCategories.tenantId, cloudCategories.id],
          set: { name },
        });

      await this.incrementRevision(tx, tenantId);
    });

    return { success: true };
  }

  @Get("users")
  async getUsers(@Headers("x-admin-token") token: string | undefined) {
    const tenantId = await this.authorize(token);
    return this.db
      .select({
        id: cloudPosUsers.id,
        name: cloudPosUsers.name,
        role: cloudPosUsers.role,
        active: cloudPosUsers.active,
      })
      .from(cloudPosUsers)
      .where(eq(cloudPosUsers.tenantId, tenantId));
  }

  @Post("users")
  async saveUser(
    @Headers("x-admin-token") token: string | undefined,
    @Body() body: any,
  ) {
    const tenantId = await this.authorize(token);
    const { id, name, role, active, pin } = body;
    if (!id || !name || !role || typeof active !== "boolean") {
      throw new BadRequestException("Campos de usuario inválidos");
    }

    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(cloudPosUsers)
        .where(
          sql`tenant_id = ${tenantId} and id = ${id}`
        );

      let pinHash = existing[0]?.pinHash;
      if (pin) {
        if (!/^\d{4}$/.test(pin)) {
          throw new BadRequestException("El PIN debe ser de 4 dígitos numéricos");
        }
        pinHash = sha256(pin);
      }

      if (!pinHash) {
        throw new BadRequestException("Se requiere PIN para nuevos usuarios");
      }

      await tx
        .insert(cloudPosUsers)
        .values({
          tenantId,
          id,
          name,
          role,
          pinHash,
          active,
        })
        .onConflictDoUpdate({
          target: [cloudPosUsers.tenantId, cloudPosUsers.id],
          set: {
            name,
            role,
            pinHash,
            active,
          },
        });

      await this.incrementRevision(tx, tenantId);
    });

    return { success: true };
  }

  @Get("taxes")
  async getTaxes(@Headers("x-admin-token") token: string | undefined) {
    const tenantId = await this.authorize(token);
    return this.db
      .select()
      .from(cloudTaxes)
      .where(eq(cloudTaxes.tenantId, tenantId));
  }

  private async authorize(token: string | undefined): Promise<string> {
    if (!token) throw new UnauthorizedException("x-admin-token requerido");
    const [tenant] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.adminToken, token));
    if (!tenant) throw new UnauthorizedException("token inválido");
    return tenant.id;
  }

  private async incrementRevision(tx: any, tenantId: string) {
    const [row] = await tx
      .select()
      .from(cloudCatalogRevisions)
      .where(eq(cloudCatalogRevisions.tenantId, tenantId));

    const nextRev = (row ? row.revision : 0) + 1;
    await tx
      .insert(cloudCatalogRevisions)
      .values({ tenantId, revision: nextRev })
      .onConflictDoUpdate({
        target: cloudCatalogRevisions.tenantId,
        set: { revision: nextRev },
      });
  }
}
