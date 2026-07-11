import http from "node:http";
import { fileURLToPath } from "node:url";
import { openPosDb } from "../db/connect.js";
import type { DeviceContext } from "../db/context.js";
import { PosService } from "../service.js";

/**
 * Local register server: the ONLY process that touches the store SQLite.
 * The sale screen (browser dev or the Tauri webview) talks to it over
 * localhost JSON. Later the same server feeds the LAN KDS and runs the
 * cloud sync loop.
 */

const PORT = Number(process.env.BERRYPOS_PORT ?? 1421);
const DB_FILE =
  process.env.BERRYPOS_DB ??
  fileURLToPath(new URL("../../data/berrypos.sqlite", import.meta.url));

const CTX: DeviceContext = {
  tenantId: process.env.BERRYPOS_TENANT ?? "dev",
  storeId: process.env.BERRYPOS_STORE ?? "tienda-1",
  deviceId: process.env.BERRYPOS_DEVICE ?? "caja-1",
};

const db = openPosDb(DB_FILE);
const service = new PosService(db, CTX);

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

const server = http.createServer(async (req, res) => {
  // The UI runs on another local origin (vite 1420 / tauri://).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const route = `${req.method} ${req.url?.split("?")[0]}`;
  try {
    const result = await handle(route, req);
    if (result === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `unknown route ${route}` }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
    );
  }
});

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
