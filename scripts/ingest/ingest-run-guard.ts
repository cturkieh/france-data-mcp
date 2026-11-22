/**
 * Garde du nettoyage des copies de secours : aucune suppression tant qu'un run
 * d'ingestion récent ne s'est pas terminé proprement.
 *
 * Pourquoi lire GitHub et pas seulement `ingest_log` : un run n'écrit
 * `ingest_log` qu'à la fin. Entre la bascule et cette écriture (plusieurs
 * minutes pour RPPS : matviews, listes de recherche), puis pour toujours si le
 * run est TUÉ dans cet intervalle (run RPPS du 2026-09-05 : bascule à 59:59,
 * tué 5 s après), `ingest_log` ne sait rien de la bascule. Les gardes d'âge de
 * `dropStalePrevious` liraient le run précédent et supprimeraient la seule
 * copie saine, celle qu'il faudrait pour revenir en arrière.
 *
 * Règle : si UN run d'un workflow `ingest-*.yml` a démarré depuis moins de N
 * jours sans être `completed` + `success`, on ne nettoie rien. Tout run de la
 * fenêtre compte, pas le seul dernier : un succès qui suit un run tué peut être
 * un court-circuit `same_checksum`, qui n'a rien rebasculé.
 *
 * Ce que la garde donne : N jours pour revenir en arrière après un run
 * anormal. Passé ce délai la RPC supprime la copie, sauf si une matview ou une
 * vue y est encore liée : depuis `20261122T210000` elle supprime sans
 * `CASCADE` et échoue alors en 2BP01, sans rien détruire.
 *
 * Limites assumées : une ingestion lancée hors GitHub Actions (poste local)
 * est invisible ici, cf. skill `ingestion-crons` ; seuls les
 * `RUNS_PER_WORKFLOW` runs les plus récents de chaque workflow sont lus.
 */

import fs from "node:fs";
import { IngestError, utcDaysSince } from "./shared.js";

const INGEST_WORKFLOW_PATTERN = /^ingest-.+\.ya?ml$/;
const GITHUB_API_TIMEOUT_MS = 15_000;
/**
 * Runs lus par workflow, du plus récent au plus ancien. Le plus fréquent est
 * hebdomadaire : 20 couvrent des mois, relances manuelles comprises.
 */
const RUNS_PER_WORKFLOW = 20;

export interface WorkflowRunSummary {
  workflowFile: string;
  /** `queued`, `in_progress`, `completed`, etc. */
  status: string;
  /** `success`, `failure`, `cancelled`, `timed_out`… ; `null` tant que le run n'est pas terminé. */
  conclusion: string | null;
  /**
   * Dernier démarrage du run : `run_started_at`, que GitHub remet à jour à
   * chaque « Re-run », et non `created_at`, qui garde la date de la première
   * tentative. Une relance à J+5 d'un run créé à J doit compter comme récente.
   */
  lastStartedAt: string;
  htmlUrl: string;
}

/** Fichiers `ingest-*.yml` du dépôt : tous les workflows qui basculent une table. */
export function listIngestWorkflowFiles(workflowsDir: string | URL): string[] {
  const files = fs
    .readdirSync(workflowsDir)
    .filter((f) => INGEST_WORKFLOW_PATTERN.test(f))
    .sort();
  if (files.length === 0) {
    // Une garde qui n'a rien à vérifier est une garde cassée, pas un feu vert.
    throw new IngestError(
      "swap",
      `aucun workflow ingest-*.yml trouvé dans ${String(workflowsDir)}`,
    );
  }
  return files;
}

/**
 * Runs qui interdisent le nettoyage : démarrés depuis moins de `windowDays`
 * jours calendaires UTC (comme les gardes d'âge) et pas terminés en succès.
 * Tout ce qui n'est pas `completed` + `success` bloque, liste ouverte à
 * dessein : un statut que GitHub ajouterait demain bloque par défaut.
 */
export function findBlockingRuns(
  runs: WorkflowRunSummary[],
  now: Date,
  windowDays: number,
): WorkflowRunSummary[] {
  return runs.filter(
    (run) =>
      utcDaysSince(run.lastStartedAt, now) < windowDays &&
      !(run.status === "completed" && run.conclusion === "success"),
  );
}

function parseRuns(workflowFile: string, body: unknown): WorkflowRunSummary[] {
  const runs = (body as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(runs)) {
    throw new IngestError("swap", `GitHub runs(${workflowFile}) : réponse sans workflow_runs`);
  }
  // Liste vide = workflow jamais lancé : rien à craindre de lui.
  return runs.map((run) => {
    if (run === null || typeof run !== "object") {
      throw new IngestError("swap", `GitHub runs(${workflowFile}) : run illisible (${typeof run})`);
    }
    return parseRun(workflowFile, run as Record<string, unknown>);
  });
}

function parseRun(workflowFile: string, run: Record<string, unknown>): WorkflowRunSummary {
  const {
    status,
    conclusion,
    created_at: createdAt,
    run_started_at: runStartedAt,
    html_url: htmlUrl,
  } = run;
  if (typeof status !== "string" || typeof createdAt !== "string") {
    throw new IngestError(
      "swap",
      `GitHub runs(${workflowFile}) : status ou created_at illisible (${JSON.stringify({ status, createdAt })})`,
    );
  }
  // Le plus récent des deux (ISO UTC de même format : l'ordre des chaînes est
  // celui des dates). `run_started_at` absent ou plus ancien → `created_at`.
  const lastStartedAt =
    typeof runStartedAt === "string" && runStartedAt > createdAt ? runStartedAt : createdAt;
  return {
    workflowFile,
    status,
    conclusion: typeof conclusion === "string" ? conclusion : null,
    lastStartedAt,
    htmlUrl: typeof htmlUrl === "string" ? htmlUrl : "",
  };
}

/**
 * Runs récents de chaque workflow, lus sur l'API GitHub. Toute erreur (réseau,
 * HTTP, forme de réponse, un seul run illisible) est un throw : dans le doute
 * on ne nettoie pas, et le job sort en rouge.
 */
export async function fetchRecentIngestRuns(opts: {
  repo: string;
  token: string;
  workflowFiles: string[];
  fetchImpl?: typeof fetch;
}): Promise<WorkflowRunSummary[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const recent: WorkflowRunSummary[] = [];
  for (const file of opts.workflowFiles) {
    const url = `https://api.github.com/repos/${opts.repo}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=${RUNS_PER_WORKFLOW}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "france-data-mcp-cleanup",
        },
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[france-data-mcp] ingest-run-guard: GitHub runs(${file}) injoignable: ${reason}`,
      );
      throw new IngestError("swap", `GitHub runs(${file}) injoignable : ${reason}`, err);
    }
    if (!res.ok) {
      throw new IngestError("swap", `GitHub runs(${file}) : HTTP ${res.status} ${res.statusText}`);
    }
    recent.push(...parseRuns(file, await res.json()));
  }
  return recent;
}
