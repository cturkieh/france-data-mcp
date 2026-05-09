import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Path absolu basé sur la position du fichier (scripts/ingest/load-env.ts → repo root).
// Le cwd-relatif `.env.local` était silencieusement no-op si lancé depuis un autre dossier.
const envLocalPath = fileURLToPath(new URL("../../.env.local", import.meta.url));
const envPath = fileURLToPath(new URL("../../.env", import.meta.url));

if (existsSync(envLocalPath)) {
  config({ path: envLocalPath });
}
config({ path: envPath, override: false });
