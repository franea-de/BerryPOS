CREATE TABLE "cloud_catalog_revisions" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_categories" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "cloud_categories_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "cloud_pos_users" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"pin_hash" text NOT NULL,
	"active" boolean NOT NULL,
	CONSTRAINT "cloud_pos_users_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "cloud_product_barcodes" (
	"tenant_id" text NOT NULL,
	"barcode" text NOT NULL,
	"product_id" text NOT NULL,
	CONSTRAINT "cloud_product_barcodes_tenant_id_barcode_pk" PRIMARY KEY("tenant_id","barcode")
);
--> statement-breakpoint
CREATE TABLE "cloud_products" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"category_id" text,
	"scale_item_code" text,
	"is_weighable" boolean NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"tax_codes" jsonb NOT NULL,
	"active" boolean NOT NULL,
	CONSTRAINT "cloud_products_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "cloud_promotions" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "cloud_promotions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "cloud_taxes" (
	"tenant_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"included_in_price" boolean NOT NULL,
	CONSTRAINT "cloud_taxes_tenant_id_code_pk" PRIMARY KEY("tenant_id","code")
);
--> statement-breakpoint
CREATE INDEX "idx_cloud_products_scale_code" ON "cloud_products" USING btree ("scale_item_code");