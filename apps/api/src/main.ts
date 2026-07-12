import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { DB } from "./sync/sync.controller.js";
import { ensureDevTenant } from "./seed.js";
import type { ApiDb } from "./db/client.js";

const PORT = Number(process.env.PORT ?? 4000);

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  await ensureDevTenant(app.get<ApiDb>(DB));
  await app.listen(PORT, "127.0.0.1");
  console.log(`BerryPOS API: http://127.0.0.1:${PORT}`);
}

void bootstrap();
