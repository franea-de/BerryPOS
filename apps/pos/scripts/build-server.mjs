import { build } from "esbuild";

// Bundle the register server into a single ESM file the desktop shell can
// spawn with plain `node`. better-sqlite3 stays external (native addon,
// resolved from node_modules at runtime).
await build({
  entryPoints: ["src/server/main.ts"],
  outfile: "dist-server/main.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-sqlite3"],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
console.log("server bundled -> dist-server/main.mjs");
