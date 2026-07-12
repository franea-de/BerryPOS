import {
  Controller,
  Get,
  Headers,
  Inject,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { tenants } from "../db/schema.js";
import type { ApiDb } from "../db/client.js";
import { CloudReports } from "./reports.js";
import { DB } from "../sync/sync.controller.js";

export const REPORTS = Symbol("REPORTS");

@Controller("reports")
export class ReportsController {
  constructor(
    @Inject(DB) private readonly db: ApiDb,
    @Inject(REPORTS) private readonly reports: CloudReports,
  ) {}

  @Get("summary")
  async summary(@Headers("x-admin-token") token: string | undefined) {
    const tenant = await this.authorize(token);
    return this.reports.summary(tenant);
  }

  @Get("daily")
  async daily(
    @Headers("x-admin-token") token: string | undefined,
    @Query("days") days: string | undefined,
  ) {
    const tenant = await this.authorize(token);
    return this.reports.daily(tenant, Math.min(Number(days) || 14, 90));
  }

  @Get("recent")
  async recent(@Headers("x-admin-token") token: string | undefined) {
    const tenant = await this.authorize(token);
    return this.reports.recent(tenant);
  }

  private async authorize(token: string | undefined): Promise<string> {
    if (!token) throw new UnauthorizedException("x-admin-token requerido");
    const [tenant] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.adminToken, token));
    if (!tenant) throw new UnauthorizedException("token inválido");
    return tenant.id;
  }
}
