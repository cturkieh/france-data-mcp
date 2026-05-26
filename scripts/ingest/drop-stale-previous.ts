/**
 * V0.9.3 — Script CLI pour drop les tables `<source>_previous` stagnantes.
 *
 * Usage : `tsx scripts/ingest/drop-stale-previous.ts [--max-age-days=N]`
 *
 * À lancer manuellement (ou via GitHub Action de maintenance hebdo). Vérifie
 * pour chaque source l'âge de `<source>_previous` et drop si > seuil (default
 * 7j). Idempotent : safe à relancer sans effet de bord cumulatif.
 *
 * Pas appelé par les scripts d'ingestion eux-mêmes : `ingest_atomic_swap`
 * overwrite previous au swap suivant de toute façon. Ce cleanup sert
 * UNIQUEMENT quand l'ingestion stagne (cron en panne, source upstream
 * cassée, checksums identiques répétés).
 */

import "./load-env.js";
import {
  DROP_STALE_PREVIOUS_DEFAULT_DAYS,
  DROP_STALE_PREVIOUS_MAX_DAYS,
  type DropStalePreviousOutcome,
  IngestError,
  dropStalePrevious,
} from "./shared.js";

/**
 * Mapping `prodTable` (nom physique de la table en base) ↔ `source` (clé
 * `ingest_log.source` utilisée par les cron scripts). Les deux sont
 * indépendants en pratique :
 *  - `prodTable` est le nom SQL réel (ex. `annuaire_ameli`), construit par
 *    les migrations + l'atomic swap qui produit `<prodTable>_previous`.
 *  - `source` est l'identifiant logique loggué dans `ingest_log` par chaque
 *    cron (ex. `ameli_ps`, `cds`) — historiquement plus court / mnémonique.
 *
 * NE PAS confondre. Ce script doit cibler la table physique pour le DROP et
 * le `source` pour lire `MAX(started_at)` côté `ingest_log`.
 *
 * Vérifié prod 2026-05-26 :
 *   - `annuaire_ameli_previous` existe ; `ameli_ps_previous` n'a jamais existé.
 *   - `centres_sante_previous` existe ; `ingest_log.source='cds'`.
 *   - `finess_previous` / `rpps_previous` existent ; source = même que prodTable.
 */
const SOURCES: Array<{ prodTable: string; source: string }> = [
  { prodTable: "finess", source: "finess" },
  { prodTable: "annuaire_ameli", source: "ameli_ps" },
  { prodTable: "rpps", source: "rpps" },
  { prodTable: "centres_sante", source: "cds" },
];

function parseMaxAgeDaysFromArgv(): number {
  const arg = process.argv.find((a) => a.startsWith("--max-age-days="));
  if (!arg) return DROP_STALE_PREVIOUS_DEFAULT_DAYS;
  const raw = arg.slice("--max-age-days=".length);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > DROP_STALE_PREVIOUS_MAX_DAYS) {
    throw new Error(
      `--max-age-days invalide: "${raw}" (attendu [1, ${DROP_STALE_PREVIOUS_MAX_DAYS}])`,
    );
  }
  return parsed;
}

function formatOutcome(outcome: DropStalePreviousOutcome): string {
  // ASCII-only tags : les parseurs GitHub Actions Annotations / Vercel log drain /
  // Axiom search sont robustes aux Unicode mais des emojis cassent grep + alignement.
  switch (outcome.kind) {
    case "dropped":
      return `[DROP] ${outcome.table} (age=${outcome.ageDays}d)`;
    case "kept":
      return `[KEEP] ${outcome.table} (age=${outcome.ageDays}d, sous seuil)`;
    case "absent":
      return `[ABSENT] ${outcome.table} (rien a drop)`;
    case "no_history":
      return `[NO_HISTORY] ${outcome.table} (aucun ingest_log success — investiguer manuellement)`;
    default: {
      // Exhaustiveness check : si DropStalePreviousOutcome est étendu sans
      // mise à jour du switch, le compilateur TS échoue ici. Defense-in-depth
      // runtime au cas où le contrat SQL drifte au-delà des 4 kind connus.
      const _exhaustive: never = outcome;
      throw new IngestError(
        "swap",
        `formatOutcome: kind inconnu (drift contrat) — ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const maxAgeDays = parseMaxAgeDaysFromArgv();
  console.log(`[france-data-mcp] drop-stale-previous (max_age_days=${maxAgeDays})`);
  let failureCount = 0;
  for (const { prodTable, source } of SOURCES) {
    try {
      const outcome = await dropStalePrevious({ prodTable, source, maxAgeDays });
      console.log(`  ${formatOutcome(outcome)}`);
    } catch (err) {
      failureCount += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [FAIL] ${prodTable}_previous: ${msg}`);
    }
  }
  if (failureCount > 0) {
    console.error(
      `[france-data-mcp] drop-stale-previous terminé avec ${failureCount} échec(s) sur ${SOURCES.length} sources`,
    );
    process.exit(1);
  }
}

await main();
