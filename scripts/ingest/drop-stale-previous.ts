/**
 * Script CLI de nettoyage des copies de secours `<source>_previous`.
 *
 * Usage : `tsx scripts/ingest/drop-stale-previous.ts [--max-age-days=N] [--dry-run] [--no-ingest-guard]`
 *
 * Lancé chaque jour par `cleanup-stale-previous.yml`. Chaque bascule garde
 * l'ancienne table en `<source>_previous` pour pouvoir revenir en arrière ;
 * ce script la supprime `DROP_STALE_PREVIOUS_DEFAULT_DAYS` jours après le
 * dernier run de la source. Idempotent.
 *
 * Pourquoi ne pas attendre la bascule suivante, qui écrase la copie de toute
 * façon : le disque Supabase est facturé à sa taille réservée, grossit de 50 %
 * dès 90 % de remplissage et ne rétrécit pas seul. Une copie qui traîne
 * jusqu'au rechargement suivant gonfle donc le pic (trois exemplaires d'Ameli
 * chaque lundi, copie RPPS encore là au lundi suivant).
 *
 * Trois gardes, toutes dans le sens « dans le doute on ne supprime pas » :
 *  1. `ingest-run-guard.ts` (ici, avant toute table) : rien n'est nettoyé si un
 *     run d'un workflow d'ingestion est récent et pas terminé en succès (en
 *     cours, tué, en échec). Exige `GITHUB_TOKEN` et `GITHUB_REPOSITORY`.
 *  2. `dropStalePrevious` : pas de suppression si un run de la source figure
 *     dans `ingest_log` depuis moins de N jours, quel que soit son statut.
 *  3. la RPC `ingest_drop_stale_previous` : dernier `success` vieux de N jours.
 *
 * `--dry-run` : n'appelle PAS la RPC, n'écrit rien. Affiche pour chaque table
 * ce qui serait décidé.
 * `--no-ingest-guard` : saute la garde 1. Réservé à un opérateur qui a vérifié
 * à la main qu'aucune ingestion ne tourne et qu'aucune n'a été tuée récemment.
 */

import "./load-env.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchRecentIngestRuns,
  findBlockingRuns,
  listIngestWorkflowFiles,
} from "./ingest-run-guard.js";
import {
  DROP_STALE_PREVIOUS_DEFAULT_DAYS,
  DROP_STALE_PREVIOUS_MAX_DAYS,
  type DropStalePreviousOutcome,
  IngestError,
  type IngestSource,
  dropStalePrevious,
  runIfMain,
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
 *
 * Ajout IRIS 2026-06-06 : l'ingestion IRIS produit QUATRE tables prod
 * (`iris`, `iris_population`, `iris_familles`, `iris_revenu`) — chacune swappée
 * → chacune a son propre `<prodTable>_previous` — mais toutes loguées sous une
 * SEULE `ingest_log.source='iris'`. Elles étaient absentes de ce mapping : leurs
 * `_previous` (~320 MB) n'étaient donc JAMAIS nettoyés (gap fermé après un DROP
 * manuel prouvé prod). IRIS = source INSEE statique sans cron récurrent → le
 * seuil d'âge déclenche le DROP au prochain run de maintenance. Les 4
 * partagent `source: "iris"` à dessein.
 */
const SOURCES: Array<{ prodTable: string; source: IngestSource }> = [
  { prodTable: "finess", source: "finess" },
  { prodTable: "annuaire_ameli", source: "ameli_ps" },
  { prodTable: "rpps", source: "rpps" },
  { prodTable: "centres_sante", source: "cds" },
  { prodTable: "iris", source: "iris" },
  { prodTable: "iris_population", source: "iris" },
  { prodTable: "iris_familles", source: "iris" },
  { prodTable: "iris_revenu", source: "iris" },
  { prodTable: "sitadel_logements", source: "sitadel" },
  { prodTable: "dvf_mutations", source: "dvf" },
];

function parseMaxAgeDays(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith("--max-age-days="));
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

function formatOutcome(outcome: DropStalePreviousOutcome, maxAgeDays: number): string {
  // ASCII-only tags : les parseurs GitHub Actions Annotations / Vercel log drain /
  // Axiom search sont robustes aux Unicode mais des emojis cassent grep + alignement.
  switch (outcome.kind) {
    case "dropped":
      return `[DROP] ${outcome.table} supprimee (dernier succes il y a ${outcome.ageDays}j, seuil ${maxAgeDays}j)`;
    case "kept":
      return `[KEEP] ${outcome.table} gardee : dernier succes il y a ${outcome.ageDays}j, supprimable a partir de ${maxAgeDays}j`;
    case "recent_run":
      return `[KEEP] ${outcome.table} gardee : dernier run il y a ${outcome.ageDays}j, supprimable a partir de ${maxAgeDays}j`;
    case "dry_run": {
      const lastRun =
        outcome.lastRunAgeDays === null ? "aucun run" : `il y a ${outcome.lastRunAgeDays}j`;
      if (outcome.lastSuccessAgeDays === null) {
        return `[DRY-RUN] ${outcome.table} serait gardee : aucun succes dans ingest_log (dernier run ${lastRun})`;
      }
      return outcome.lastSuccessAgeDays < maxAgeDays
        ? `[DRY-RUN] ${outcome.table} serait gardee : dernier succes il y a ${outcome.lastSuccessAgeDays}j, supprimable a partir de ${maxAgeDays}j`
        : `[DRY-RUN] ${outcome.table} serait supprimee si elle existe (dernier run ${lastRun}, dernier succes il y a ${outcome.lastSuccessAgeDays}j, seuil ${maxAgeDays}j)`;
    }
    case "absent":
      return `[ABSENT] ${outcome.table} (rien a supprimer)`;
    case "no_history":
      return `[NO_HISTORY] ${outcome.table} gardee : aucun succes dans ingest_log, a regarder a la main`;
    default: {
      // Exhaustiveness check : si DropStalePreviousOutcome est étendu sans
      // mise à jour du switch, le compilateur TS échoue ici. Defense-in-depth
      // runtime au cas où le contrat SQL drifte au-delà des kinds connus.
      const _exhaustive: never = outcome;
      throw new IngestError(
        "swap",
        `formatOutcome: kind inconnu (drift contrat) — ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/**
 * Pile complète pour une erreur imprévue (dérive de contrat, TypeError) ; une
 * `IngestError` porte déjà son contexte dans le message.
 */
function describeError(err: unknown): string {
  if (err instanceof IngestError) return err.message;
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

/** Tout ce que `runCleanup` lit du monde extérieur, injectable pour les tests. */
export interface CleanupDeps {
  /** Arguments de la ligne de commande, sans `node` ni le chemin du script. */
  argv: string[];
  env: Record<string, string | undefined>;
  now: Date;
  fetchImpl?: typeof fetch;
  client?: Pick<SupabaseClient, "from" | "rpc">;
}

export interface CleanupResult {
  /** `true` : la garde 1 a bloqué, aucune table n'a été soumise à la suppression. */
  blockedByIngestRuns: boolean;
  /** Tables dont le traitement a levé une erreur. */
  failureCount: number;
}

/**
 * Garde 1 : `true` = le nettoyage peut avoir lieu. Lève si GitHub ne peut pas
 * être interrogé (jeton absent, API en erreur) : sans réponse, pas de nettoyage.
 *
 * La fenêtre ne descend jamais sous `DROP_STALE_PREVIOUS_DEFAULT_DAYS`, même
 * avec `--max-age-days=1` : raccourcir la durée de vie des copies ne doit pas
 * raccourcir le temps laissé pour réparer après un run tué.
 */
async function ingestRunsAllowCleanup(maxAgeDays: number, deps: CleanupDeps): Promise<boolean> {
  const token = deps.env.GITHUB_TOKEN;
  const repo = deps.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    throw new IngestError(
      "swap",
      "GITHUB_TOKEN et GITHUB_REPOSITORY requis pour verifier qu'aucune ingestion ne tourne ou n'a ete tuee recemment (ou --no-ingest-guard apres verification manuelle)",
    );
  }
  const windowDays = Math.max(maxAgeDays, DROP_STALE_PREVIOUS_DEFAULT_DAYS);
  const workflowFiles = listIngestWorkflowFiles(
    new URL("../../.github/workflows/", import.meta.url),
  );
  const recent = await fetchRecentIngestRuns({
    repo,
    token,
    workflowFiles,
    fetchImpl: deps.fetchImpl,
  });
  const blocking = findBlockingRuns(recent, deps.now, windowDays);
  console.log(
    `[france-data-mcp] garde ingestion : ${recent.length} run(s) lu(s) sur ${workflowFiles.length} workflow(s), ${blocking.length} bloquant(s) sur les ${windowDays} derniers jours`,
  );
  for (const run of blocking) {
    // `::warning::` : annotation visible sur la page du run GitHub, job vert.
    console.log(
      `::warning::Nettoyage reporte : un run de ${run.workflowFile} (demarre le ${run.lastStartedAt}) est ${run.status}/${run.conclusion ?? "sans conclusion"}. Sa copie de secours peut encore servir. ${run.htmlUrl}`,
    );
  }
  return blocking.length === 0;
}

/**
 * Le nettoyage, sans `process.exit` ni lecture directe de `process.*` : c'est
 * l'enchaînement des gardes qui décide si une table part, il est testé ici
 * (`drop-stale-previous.test.ts`).
 */
export async function runCleanup(deps: CleanupDeps): Promise<CleanupResult> {
  const maxAgeDays = parseMaxAgeDays(deps.argv);
  const dryRun = deps.argv.includes("--dry-run");
  console.log(
    `[france-data-mcp] drop-stale-previous (max_age_days=${maxAgeDays}${dryRun ? ", DRY-RUN : aucune suppression" : ""})`,
  );
  let blockedByIngestRuns = false;
  if (deps.argv.includes("--no-ingest-guard")) {
    console.warn(
      "[france-data-mcp] --no-ingest-guard : garde sur les runs d'ingestion SAUTEE (verification manuelle supposee faite)",
    );
  } else if (!(await ingestRunsAllowCleanup(maxAgeDays, deps))) {
    blockedByIngestRuns = true;
    console.log(
      `[france-data-mcp] drop-stale-previous : aucune copie ${dryRun ? "ne serait " : ""}supprimee a ce run`,
    );
    if (!dryRun) return { blockedByIngestRuns, failureCount: 0 };
    console.log(
      "[france-data-mcp] detail par table ci-dessous a titre indicatif : il ignore la garde ingestion, qui bloque tout",
    );
  }
  let failureCount = 0;
  for (const { prodTable, source } of SOURCES) {
    try {
      const outcome = await dropStalePrevious(
        { prodTable, source, maxAgeDays },
        { dryRun, now: deps.now, client: deps.client },
      );
      console.log(`  ${formatOutcome(outcome, maxAgeDays)}`);
    } catch (err) {
      failureCount += 1;
      console.error(`[france-data-mcp]   [FAIL] ${prodTable}_previous: ${describeError(err)}`);
    }
  }
  return { blockedByIngestRuns, failureCount };
}

async function main(): Promise<void> {
  try {
    const { failureCount } = await runCleanup({
      argv: process.argv.slice(2),
      env: process.env,
      now: new Date(),
    });
    if (failureCount > 0) {
      console.error(
        `[france-data-mcp] drop-stale-previous terminé avec ${failureCount} échec(s) sur ${SOURCES.length} sources`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(
      `[france-data-mcp] drop-stale-previous interrompu, rien de plus n'a ete supprime : ${describeError(err)}`,
    );
    process.exit(1);
  }
}

await runIfMain(import.meta.url, main);
