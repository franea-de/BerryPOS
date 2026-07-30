import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type ApiDb = NodePgDatabase<typeof schema>;

/** App connection: the non-owner role, so RLS policies apply. */
export function createDb(url?: string): { db: ApiDb; pool: pg.Pool } {
  const connectionString =
    url ??
    process.env.DATABASE_URL ??
    "postgres://berrypos_app:BerryPOS_Secure_1234_App!@127.0.0.1:5434/berrypos";
  const isSsl = connectionString.includes("sslmode=require") || connectionString.includes(".neon.tech");
  const pool = new pg.Pool({
    connectionString,
    ssl: isSsl ? { rejectUnauthorized: false } : undefined,
  });
  return { db: drizzle(pool, { schema }), pool };
}
