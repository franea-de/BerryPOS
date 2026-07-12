-- Non-owner application role: RLS policies apply to it (owners bypass RLS).
DO $$ BEGIN
  CREATE ROLE berrypos_app LOGIN PASSWORD 'berrypos';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO berrypos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO berrypos_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO berrypos_app;
--> statement-breakpoint
-- Tenant isolation on event data: a request sees ONLY its tenant's rows.
-- app.tenant_id is set per transaction by the inbox (set_config local).
ALTER TABLE "inbox_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "inbox_events"
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
