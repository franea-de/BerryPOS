import { Module } from "@nestjs/common";
import { createDb, type ApiDb } from "./db/client.js";
import { SyncInbox } from "./sync/inbox.js";
import { DB, INBOX, SyncController } from "./sync/sync.controller.js";

/**
 * Modular monolith (CLAUDE.md): one Nest app, clean module borders.
 * Providers use explicit tokens/factories — no decorator metadata needed,
 * which keeps the esbuild-based toolchain (vitest, vite-node) happy.
 */
@Module({
  controllers: [SyncController],
  providers: [
    { provide: DB, useFactory: () => createDb().db },
    {
      provide: INBOX,
      useFactory: (db: ApiDb) => new SyncInbox(db),
      inject: [DB],
    },
  ],
})
export class AppModule {}
