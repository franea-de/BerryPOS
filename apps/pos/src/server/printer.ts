import { execFile } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Raw ESC/POS transport. Configure via BERRYPOS_PRINTER:
 * - "tcp://192.168.1.50" (network printer, port 9100 by default)
 * - "share://TICKET"     (Windows shared printer: copy /b to the share)
 * Unset -> no printer: callers fall back to the on-screen preview.
 */
export async function printRaw(bytes: Uint8Array): Promise<boolean> {
  const target = process.env.BERRYPOS_PRINTER;
  if (!target) return false;

  if (target.startsWith("tcp://")) {
    const [host, portText] = target.slice("tcp://".length).split(":");
    if (!host) throw new Error(`BERRYPOS_PRINTER inválido: ${target}`);
    const port = Number(portText ?? 9100) || 9100;
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port, timeout: 4000 }, () => {
        socket.end(Buffer.from(bytes), () => resolve());
      });
      socket.on("error", reject);
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error(`La impresora ${host}:${port} no responde`));
      });
    });
    return true;
  }

  if (target.startsWith("share://")) {
    const share = target.slice("share://".length);
    const file = join(tmpdir(), `berrypos-ticket-${Date.now()}.bin`);
    await writeFile(file, Buffer.from(bytes));
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "cmd",
          ["/c", "copy", "/b", file, `\\\\localhost\\${share}`],
          (error) => (error ? reject(error) : resolve()),
        );
      });
      return true;
    } finally {
      await unlink(file).catch(() => {});
    }
  }

  throw new Error(`BERRYPOS_PRINTER inválido: ${target}`);
}
