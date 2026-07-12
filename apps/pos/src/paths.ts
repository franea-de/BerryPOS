import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate the @berrypos/pos package root by walking up from the running file.
 * Works whether the code runs from src/ (vite-node in dev) or from the
 * dist-server/ bundle the desktop app spawns.
 */
export function packageRoot(importMetaUrl: string): string {
  let dir = dirname(fileURLToPath(importMetaUrl));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`package root not found above ${importMetaUrl}`);
}
