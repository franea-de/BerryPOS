import type { PromotionInput, TaxDefinitionInput } from "@berrypos/domain";
import type { CatalogSnapshot } from "@berrypos/sync-contracts";

/**
 * First-boot catalog for a fresh store DB (and the browser demo backend).
 * Applied as snapshot revision 0, so any real cloud snapshot (revision >= 1)
 * replaces it entirely.
 */

export const SEED_TAXES: TaxDefinitionInput[] = [
  { code: "IVA19", name: "IVA 19%", rateBp: 1900, includedInPrice: true },
];

export const SEED_PROMOTIONS: PromotionInput[] = [
  { id: "2x1-soda", name: "2x1 bebidas cola", type: "nxm", productIds: ["soda"], buyQty: 2, payQty: 1 },
  { id: "vol-rice", name: "Arroz desde 2 kg a $1.490", type: "volume_price", productIds: ["rice"], minQtyMilli: 2000, unitPriceCents: 1490 },
  { id: "snacks-10", name: "10% snacks", type: "category_percent", categoryIds: ["snacks"], valueBp: 1000 },
];

export const SEED_SNAPSHOT: CatalogSnapshot = {
  revision: 0,
  products: [
    { id: "soda", name: "Bebida cola 1.5L", categoryId: "bebidas", barcodes: ["7801234567897"], isWeighable: false, unitPriceCents: 1890, taxCodes: ["IVA19"], active: true },
    { id: "bread", name: "Pan de molde", categoryId: "abarrotes", barcodes: ["7802345678904"], isWeighable: false, unitPriceCents: 2290, taxCodes: ["IVA19"], active: true },
    { id: "milk", name: "Leche entera 1L", categoryId: "lacteos", barcodes: ["7803456789011"], isWeighable: false, unitPriceCents: 1190, taxCodes: ["IVA19"], active: true },
    { id: "rice", name: "Arroz granel (kg)", categoryId: "abarrotes", barcodes: [], scaleItemCode: "12345", isWeighable: true, unitPriceCents: 1690, taxCodes: ["IVA19"], active: true },
    { id: "tomato", name: "Tomate (kg)", categoryId: "verduras", barcodes: [], scaleItemCode: "20001", isWeighable: true, unitPriceCents: 2490, taxCodes: ["IVA19"], active: true },
    { id: "chips", name: "Papas fritas 200g", categoryId: "snacks", barcodes: ["7804567890128"], isWeighable: false, unitPriceCents: 2590, taxCodes: ["IVA19"], active: true },
  ],
  categories: [
    { id: "bebidas", name: "Bebidas" },
    { id: "abarrotes", name: "Abarrotes" },
    { id: "lacteos", name: "Lácteos" },
    { id: "verduras", name: "Verduras" },
    { id: "snacks", name: "Snacks" },
  ],
  taxCatalog: SEED_TAXES,
  promotions: SEED_PROMOTIONS,
  users: [],
};
