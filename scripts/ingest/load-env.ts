import { existsSync } from "node:fs";
import { config } from "dotenv";

// Loads `.env.local` first (gitignored, local dev override matching Next.js /
// Vite conventions), then `.env` as a fallback without overriding. The default
// `import "dotenv/config"` ONLY reads `.env`, which caused the 2026-05-08
// incident: credentials in `.env.local` were silently ignored and the
// ingestion scripts saw `process.env.SUPABASE_URL = undefined`.
//
// In CI/GitHub Actions, neither file is present and `process.env` is populated
// by the runner from secrets. Both `config` calls become no-ops there.
if (existsSync(".env.local")) {
  config({ path: ".env.local" });
}
config({ override: false });
