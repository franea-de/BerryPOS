import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { packageRoot } from "../paths.js";
import * as schema from "./schema.js";
import type { PosDb } from "./context.js";

/** A PosDb plus the underlying connection, so callers can close it. */
export type PosDbHandle = PosDb & { $client: Database.Database };

/**
 * Open (or create) the store database and bring it to the latest migration.
 * WAL keeps the register responsive while the sync loop reads the outbox.
 */
export function openPosDb(file: string): PosDbHandle {
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, {
    migrationsFolder: join(packageRoot(import.meta.url), "drizzle"),
  });
  return db;
}
