import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_ADMIN_URL ??
      process.env.DATABASE_URL ??
      "postgres://postgres:berrypos@127.0.0.1:5434/berrypos",
  },
});
