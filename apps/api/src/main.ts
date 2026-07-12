import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
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
  await ensureDevTenant(app.get<ApiDb>(DB));
  // Rebuild the reporting projection from the inbox (idempotent).
  await app.get<CloudReports>(REPORTS).backfill();
  await app.listen(PORT, "127.0.0.1");
  console.log(`BerryPOS API: http://127.0.0.1:${PORT}`);
}

void bootstrap();
