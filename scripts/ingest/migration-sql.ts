import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Helpers partagés des garde-fous structurels SANS DB (lecture des
// migrations SQL). Consommé par `rpps-matview-rebuild.test.ts`
// (reconstruction matview post-swap + parité DDL). Objectif : UN seul
// parser de migrations pour les guards — un durcissement regex profite à
// tous, vs un clone vulnérable silencieusement (= la classe de bug que ces
// garde-fous combattent).
//
// ⚠️ DETTE PRÉ-EXISTANTE : `staging-parity.test.ts` garde encore un clone
// LOCAL de `allMigrationsSql`/`latestFunctionBody`/`ingestDir` (à migrer
// vers ce module — backlog). TANT QUE cette migration n'est pas faite,
// tout durcissement du parser doit être appliqué AUX DEUX endroits.

const migrationsDir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

/** Dossier `scripts/ingest/` (pour scanner les `*.ts` appelant un RPC). */
export const ingestDir = fileURLToPath(new URL(".", import.meta.url));

/** Toutes les migrations SQL concaténées dans l'ordre d'application (tri nom), lowercased. */
export function allMigrationsSql(): string {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((n) => readFileSync(`${migrationsDir}/${n}`, "utf8"))
    .join("\n")
    .toLowerCase();
}

/**
 * Corps `$$...$$` de la DERNIÈRE définition d'une fonction (ordre = tri nom
 * de fichier = ordre d'application Supabase). Limite : fonctions `$$` sans
 * tag `$tag$` imbriqué (vrai pour `ingest_create_*_staging`,
 * `ingest_refresh_matview`, `ingest_rebuild_rpps_matviews`).
 */
export function latestFunctionBody(fnName: string): string {
  const re = new RegExp(
    `create (?:or replace )?function\\s+${fnName}\\b[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
    "g",
  );
  let body = "";
  for (const m of allMigrationsSql().matchAll(re)) body = m[1] ?? "";
  return body;
}
