import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { devices } from "../db/schema.js";
import type { ApiDb } from "../db/client.js";
import { SyncInbox } from "./inbox.js";

export const DB = Symbol("DB");
export const INBOX = Symbol("INBOX");

@Controller("sync")
export class SyncController {
  constructor(
    @Inject(DB) private readonly db: ApiDb,
    @Inject(INBOX) private readonly inbox: SyncInbox,
  ) {}

  @Get("health")
  health() {
    return { ok: true };
  }

  @Post("push")
  async push(
    @Headers("x-api-key") apiKey: string | undefined,
    @Body() body: unknown,
  ) {
    if (!apiKey) throw new UnauthorizedException("x-api-key requerido");
    const [device] = await this.db
      .select()
      .from(devices)
      .where(eq(devices.apiKey, apiKey));
    if (!device) throw new UnauthorizedException("api key inválida");

    try {
      return await this.inbox.push(
        {
          tenantId: device.tenantId,
          storeId: device.storeId,
          deviceId: device.id,
        },
        body,
      );
    } catch (e) {
      if (e instanceof ZodError) {
        throw new BadRequestException(`payload inválido: ${e.message}`);
      }
      throw e;
    }
  }

  @Post("pull")
  async pull(
    @Headers("x-api-key") apiKey: string | undefined,
    @Body() body: unknown,
  ) {
    if (!apiKey) throw new UnauthorizedException("x-api-key requerido");
    const [device] = await this.db
      .select()
      .from(devices)
      .where(eq(devices.apiKey, apiKey));
    if (!device) throw new UnauthorizedException("api key inválida");

    try {
      return await this.inbox.pull(
        {
          tenantId: device.tenantId,
        },
        body,
      );
    } catch (e) {
      if (e instanceof ZodError) {
        throw new BadRequestException(`payload inválido: ${e.message}`);
      }
      throw e;
    }
  }
}
