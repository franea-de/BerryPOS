import type { SyncPushResponse } from "@berrypos/sync-contracts";
import { applyPushResponse, buildPushRequest } from "../db/outbox.js";
import type { PosDb } from "../db/context.js";

/**
 * Store → cloud push loop. Fire-and-forget by design: the register never
 * waits for the cloud (ARCHITECTURE.md §1). Every tick drains the outbox in
 * batches; accepted/duplicate events clear, rejected ones stay and surface
 * in the status. Offline? The tick fails quietly and retries next time.
 */

export interface SyncStatus {
  enabled: boolean;
  cloudUrl: string | null;
  lastPushAt: string | null;
  lastError: string | null;
  lastRejected: Array<{ eventId: string; reason: string }>;
}

export type PushTransport = (request: unknown) => Promise<SyncPushResponse>;

export function httpTransport(cloudUrl: string, apiKey: string): PushTransport {
  return async (request) => {
    const res = await fetch(`${cloudUrl}/sync/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? `cloud respondió HTTP ${res.status}`);
    }
    return (await res.json()) as SyncPushResponse;
  };
}

/** Drain the outbox once. Returns how many events were cleared. */
export async function pushOnce(
  db: PosDb,
  send: PushTransport,
  status?: SyncStatus,
): Promise<number> {
  let cleared = 0;
  for (;;) {
    const request = buildPushRequest(db);
    if (!request) break;
    const response = await send(request);
    const applied = applyPushResponse(db, response);
    cleared += applied.cleared;
    if (status) status.lastRejected = applied.rejected;
    // Rejected events stay pending: without progress, stop to avoid looping.
    if (applied.cleared === 0) break;
  }
  if (status) {
    status.lastPushAt = new Date().toISOString();
    status.lastError = null;
  }
  return cleared;
}

export function startSyncLoop(
  db: PosDb,
  opts: { cloudUrl: string; apiKey: string; intervalMs?: number },
): SyncStatus {
  const status: SyncStatus = {
    enabled: true,
    cloudUrl: opts.cloudUrl,
    lastPushAt: null,
    lastError: null,
    lastRejected: [],
  };
  const send = httpTransport(opts.cloudUrl, opts.apiKey);
  let running = false;

  const tick = async () => {
    if (running) return; // never overlap pushes
    running = true;
    try {
      const cleared = await pushOnce(db, send, status);
      if (cleared > 0) console.log(`sync: ${cleared} eventos confirmados por la nube`);
    } catch (e) {
      status.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
    }
  };

  void tick();
  setInterval(() => void tick(), opts.intervalMs ?? 15_000).unref();
  return status;
}
