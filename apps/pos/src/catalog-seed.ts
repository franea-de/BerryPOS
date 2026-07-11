import type {
  CashRounding,
  PromotionInput,
  TaxDefinitionInput,
} from "@berrypos/domain";
import type { CatalogSnapshot } from "@berrypos/sync-contracts";

/**
 * First-boot catalog for a fresh store DB (and the browser demo backend),
 * configured for PERU: IGV 18% included in prices, soles (2 decimals),
 * EAN prefix 775. Applied as a snapshot, so any cloud snapshot with a
 * higher revision replaces it while locally registered products survive.
 */

export const SEED_TAXES: TaxDefinitionInput[] = [
  { code: "IGV18", name: "IGV 18%", rateBp: 1800, includedInPrice: true },
];

/** Peru: cash rounds to the nearest 10 céntimos; cards pay the exact total. */
export const SEED_CASH_ROUNDING: CashRounding = { unitCents: 10, mode: "nearest" };

export const SEED_PROMOTIONS: PromotionInput[] = [
  { id: "2x1-soda", name: "2x1 gaseosas", type: "nxm", productIds: ["soda"], buyQty: 2, payQty: 1 },
  { id: "vol-rice", name: "Arroz desde 2 kg a S/ 4.20", type: "volume_price", productIds: ["rice"], minQtyMilli: 2000, unitPriceCents: 420 },
  { id: "snacks-10", name: "10% snacks", type: "category_percent", categoryIds: ["snacks"], valueBp: 1000 },
];

export const SEED_SNAPSHOT: CatalogSnapshot = {
  revision: 2,
  products: [
    { id: "soda", name: "Inca Kola 1.5L", categoryId: "bebidas", barcodes: ["7751234567892"], isWeighable: false, unitPriceCents: 850, taxCodes: ["IGV18"], active: true },
    { id: "bread", name: "Pan de molde", categoryId: "abarrotes", barcodes: ["7752345678903"], isWeighable: false, unitPriceCents: 690, taxCodes: ["IGV18"], active: true },
    { id: "milk", name: "Leche evaporada 400g", categoryId: "lacteos", barcodes: ["7753456789014"], isWeighable: false, unitPriceCents: 480, taxCodes: ["IGV18"], active: true },
    { id: "rice", name: "Arroz a granel (kg)", categoryId: "abarrotes", barcodes: [], scaleItemCode: "12345", isWeighable: true, unitPriceCents: 450, taxCodes: ["IGV18"], active: true },
    { id: "tomato", name: "Tomate (kg)", categoryId: "verduras", barcodes: [], scaleItemCode: "20001", isWeighable: true, unitPriceCents: 380, taxCodes: ["IGV18"], active: true },
    { id: "chips", name: "Papas fritas 200g", categoryId: "snacks", barcodes: ["7754567890125"], isWeighable: false, unitPriceCents: 750, taxCodes: ["IGV18"], active: true },
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
  users: [
    // Default PINs: admin 9999, cajero 1111 (change via cloud panel later).
    {
      id: "admin",
      name: "Administrador",
      role: "admin",
      pinHash: "888df25ae35772424a560c7152a1de794440e0ea5cfee62828333a456a506e05",
      active: true,
    },
    {
      id: "cajero-1",
      name: "Cajero 1",
      role: "cashier",
      pinHash: "0ffe1abd1a08215353c233d6e009613e95eec4253832a761af28ff37ac5a150c",
      active: true,
    },
  ],
};
