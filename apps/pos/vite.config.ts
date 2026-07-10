import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed dev port and does its own reload orchestration.
  server: { port: 1420, strictPort: true },
  clearScreen: false,
  build: { outDir: "dist", target: "es2022" },
});
