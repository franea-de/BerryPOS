import { Module } from "@nestjs/common";
import { createDb, type ApiDb } from "./db/client.js";
import { CloudReports } from "./reports/reports.js";
import { REPORTS, ReportsController } from "./reports/reports.controller.js";
import { SyncInbox } from "./sync/inbox.js";
import { DB, INBOX, SyncController } from "./sync/sync.controller.js";
import { CatalogController } from "./catalog/catalog.controller.js";
import { AiController } from "./ai/ai.controller.js";

/**
 * Modular monolith (CLAUDE.md): one Nest app, clean module borders.
 * Providers use explicit tokens/factories — no decorator metadata needed,
 * which keeps the esbuild-based toolchain (vitest, vite-node) happy.
 */
@Module({
  controllers: [SyncController, ReportsController, CatalogController, AiController],
  providers: [
    { provide: DB, useFactory: () => createDb().db },
    {
      provide: INBOX,
      useFactory: (db: ApiDb) => new SyncInbox(db),
      inject: [DB],
    },
    {
      provide: REPORTS,
      useFactory: (db: ApiDb) => new CloudReports(db),
      inject: [DB],
    },
  ],
})
export class AppModule {}
