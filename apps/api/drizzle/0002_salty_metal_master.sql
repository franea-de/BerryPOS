CREATE TABLE "cloud_sales" (
	"sale_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"store_id" text NOT NULL,
	"device_id" text NOT NULL,
	"total_cents" integer NOT NULL,
	"occurred_at" text NOT NULL,
	"payment_methods" jsonb NOT NULL,
	"voided" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "admin_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenants_admin_token" ON "tenants" USING btree ("admin_token");