import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { AppModule } from "./app.module.js";
import { REPORTS } from "./reports/reports.controller.js";
import { DB } from "./sync/sync.controller.js";
import { ensureDevTenant } from "./seed.js";
import type { ApiDb } from "./db/client.js";
import type { CloudReports } from "./reports/reports.js";

const PORT = Number(process.env.PORT ?? 4000);

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  // The admin panel is a separate local origin.
  app.enableCors({ origin: true });

  // Run database migrations programmatically on startup using the app's db pool
  const db = app.get<ApiDb>(DB);
  console.log("Running database migrations programmatically...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied successfully!");

  await ensureDevTenant(db);
  // Rebuild the reporting projection from the inbox (idempotent).
  await app.get<CloudReports>(REPORTS).backfill();
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen(PORT, host);
  console.log(`BerryPOS API: http://${host}:${PORT}`);
}

void bootstrap();
