-- Same tenant isolation as inbox_events, applied to the sales projection.
ALTER TABLE "cloud_sales" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "cloud_sales"
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "cloud_sales" TO berrypos_app;
