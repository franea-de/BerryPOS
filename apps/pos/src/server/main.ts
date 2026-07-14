import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { extname, join, normalize } from "node:path";
import { openPosDb } from "../db/connect.js";
import type { DeviceContext } from "../db/context.js";
import { getPendingEvents } from "../db/outbox.js";
import { packageRoot } from "../paths.js";
import { PosService } from "../service.js";
import { renderTicketEscPos } from "../ticket.js";
import { printRaw } from "./printer.js";
import { startSyncLoop, type SyncStatus } from "./sync-loop.js";
import { ensureTlsCert } from "./tls.js";

/**
 * Local register server: the ONLY process that touches the store SQLite.
 * It also serves the built sale screen, so one process is the whole POS:
 * the desktop shell (or any browser on this machine) just opens
 * http://127.0.0.1:1421. Later the same server feeds the LAN KDS and runs
 * the cloud sync loop.
 */

const ROOT = packageRoot(import.meta.url);
const PORT = Number(process.env.BERRYPOS_PORT ?? 1421);
const DB_FILE = process.env.BERRYPOS_DB ?? join(ROOT, "data", "berrypos.sqlite");
const UI_DIR = join(ROOT, "dist");

const CTX: DeviceContext = {
  tenantId: process.env.BERRYPOS_TENANT ?? "dev",
  storeId: process.env.BERRYPOS_STORE ?? "tienda-1",
  deviceId: process.env.BERRYPOS_DEVICE ?? "caja-1",
};

const db = openPosDb(DB_FILE);
const service = new PosService(
  db,
  CTX,
  process.env.BERRYPOS_STORE_NAME ?? "BerryPOS",
);

// Cloud sync is opt-in: the register works forever without it.
const CLOUD_URL = process.env.BERRYPOS_CLOUD_URL;
const syncStatus: SyncStatus = CLOUD_URL
  ? startSyncLoop(db, {
      cloudUrl: CLOUD_URL,
      apiKey: process.env.BERRYPOS_API_KEY ?? "dev-key",
    })
  : {
      enabled: false,
      cloudUrl: null,
      lastPushAt: null,
      lastError: null,
      lastRejected: [],
    };

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Serve the built UI; unknown paths fall back to index.html (SPA). */
async function serveStatic(
  pathname: string,
  res: http.ServerResponse,
): Promise<boolean> {
  if (!existsSync(UI_DIR)) return false;
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  let file = normalize(join(UI_DIR, relative));
  if (!file.startsWith(UI_DIR)) return false; // no path traversal
  if (!existsSync(file)) file = join(UI_DIR, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sessions for NON-localhost clients (the mobile page on the store LAN):
 * a PIN login issues a token, and every other request from the network must
 * carry it. Requests from this machine (desktop app) stay token-free.
 */
const sessionTokens = new Set<string>();

function isLoopback(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

const requestHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => {
  // The UI may also run on another local origin (vite 1420 / tauri://).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Token");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const pathname = req.url?.split("?")[0] ?? "/";
  const route = `${req.method} ${pathname}`;

  // LAN guard: anything that writes requires a session token from /login.
  if (!isLoopback(req) && req.method === "POST" && pathname !== "/login") {
    const token = req.headers["x-session-token"];
    if (typeof token !== "string" || !sessionTokens.has(token)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Inicia sesión con tu PIN primero" }));
      return;
    }
  }

  try {
    let result = await handle(route, req);
    if (result === undefined) {
      if (req.method === "GET" && (await serveStatic(pathname, res))) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `unknown route ${route}` }));
      return;
    }
    if (route === "POST /login") {
      // Attach a LAN session token to successful logins.
      const sessionToken = crypto.randomUUID();
      sessionTokens.add(sessionToken);
      result = { ...(result as object), sessionToken };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
    );
  }
};

const server = http.createServer(requestHandler);

async function handle(
  route: string,
  req: http.IncomingMessage,
): Promise<unknown> {
  switch (route) {
    case "GET /bootstrap":
      return service.bootstrap();
    case "POST /login": {
      const body = (await readBody(req)) as { userId?: string; pin?: string };
      if (typeof body.userId !== "string" || typeof body.pin !== "string") {
        throw new Error("userId and pin are required");
      }
      return service.login(body.userId, body.pin);
    }
    case "POST /session/open": {
      const body = (await readBody(req)) as Parameters<
        PosService["openShift"]
      >[0];
      return service.openShift(body);
    }
    case "POST /session/movement": {
      const body = (await readBody(req)) as Parameters<
        PosService["cashMovement"]
      >[0];
      return service.cashMovement(body);
    }
    case "POST /session/close": {
      const body = (await readBody(req)) as Parameters<
        PosService["closeShift"]
      >[0];
      return service.closeShift(body);
    }
    case "GET /summary/today":
      return service.dailySummary();
    case "GET /sync/status":
      return { ...syncStatus, pending: getPendingEvents(db).length };
    case "GET /sales/recent":
      return service.recentSales();
    case "POST /sales/void": {
      const body = (await readBody(req)) as Parameters<
        PosService["voidSale"]
      >[0];
      return service.voidSale(body);
    }
    case "POST /scan": {
      const body = (await readBody(req)) as { code?: string };
      if (typeof body.code !== "string") throw new Error("code is required");
      return service.scan(body.code);
    }
    case "POST /products": {
      const body = (await readBody(req)) as Parameters<
        PosService["registerProduct"]
      >[0];
      return service.registerProduct(body);
    }
    case "POST /receive": {
      const body = (await readBody(req)) as Parameters<
        PosService["receiveStock"]
      >[0];
      return service.receiveStock(body);
    }
    case "POST /print/receipt": {
      const body = (await readBody(req)) as { saleId?: string };
      if (typeof body.saleId !== "string") throw new Error("saleId is required");
      const ticket = service.receiptTicket(body.saleId);
      let printed = false;
      let printError: string | undefined;
      try {
        printed = await printRaw(renderTicketEscPos(ticket.data));
      } catch (e) {
        printError = e instanceof Error ? e.message : String(e);
      }
      return { printed, preview: ticket.text, ...(printError ? { printError } : {}) };
    }
    case "POST /checkout": {
      const body = (await readBody(req)) as {
        cart: Parameters<PosService["checkout"]>[0];
        payments: Parameters<PosService["checkout"]>[1];
      };
      return service.checkout(body.cart, body.payments);
    }
    default:
      return undefined;
  }
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`BerryPOS server: http://127.0.0.1:${PORT} (db: ${DB_FILE})`);
});

// HTTPS on the LAN for the mobile page (phone cameras need a secure context).
const TLS_PORT = Number(process.env.BERRYPOS_TLS_PORT ?? 1422);
const tls = await ensureTlsCert(join(ROOT, "data", "tls"));
https.createServer(tls, requestHandler).listen(TLS_PORT, "0.0.0.0", () => {
  const urls = Object.values(os.networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((i) => i.family === "IPv4" && !i.internal)
    .map((i) => `https://${i.address}:${TLS_PORT}/movil`);
  console.log(`BerryPOS móvil (LAN): ${urls.join(" | ") || "sin red detectada"}`);
});
