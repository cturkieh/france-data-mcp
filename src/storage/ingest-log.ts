/**
 * Helpers pour exposer la fraîcheur des dumps ingérés.
 *
 * Pourquoi : un agent LLM ne peut pas juger de la fiabilité d'un résultat
 * FINESS / RPPS / Ameli sans savoir QUAND la dernière ingestion s'est
 * terminée avec succès. Le tool `data_freshness` consomme ces helpers pour
 * répondre publiquement.
 *
 * Cache : 5 minutes in-memory pour ne pas marteler `ingest_log` à chaque
 * appel MCP. Le TTL est volontairement court — un sync de prod (qui peut
 * basculer le `last_success` en plein milieu d'une heure de trafic) doit
 * être visible rapidement.
 */

import { getUntypedAnonClient } from "./supabase.js";

/**
 * Sources reconnues côté ingestion (alignées sur les `source` écrits dans
 * `ingest_log` par les scripts dans `scripts/ingest/*`). Les sources live
 * (DINUM, INSEE, ANS FHIR) ne passent pas par ingest_log car non DB-backed.
 */
export const INGEST_SOURCES = ["finess", "ameli_ps", "rpps", "cds", "iris"] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

/**
 * Cadence attendue par source. Affichée par `data_freshness` pour que le
 * caller puisse interpréter un `last_success_at` vieux d'une semaine
 * (=normal pour Ameli, =alerte pour RPPS, =critique pour FINESS).
 */
export interface IngestCadence {
  /** Prose exposée dans `cadence_hint`. */
  hint: string;
  /**
   * Âge maximal attendu de la donnée servie, en jours — exposé dans
   * `expected_max_age_days` pour que le caller COMPARE (`data_age_days >
   * expected_max_age_days`) au lieu de suivre une consigne en prose, et pour
   * que la vigie « source tarie » (`scripts/ingest/notify-ingest-anomaly.ts`,
   * après chaque cron) lise la MÊME constante — deux seuils divergeraient en
   * silence, `data_freshness` disant « fraîche » pendant que l'alerte dort.
   * Calibré source par source (pas de formule) : deux cadences pour l'hebdo
   * (Ameli/CDS → 14) et le bimensuel (FINESS → 30), une cadence et demie pour
   * le mensuel (RPPS → 45), un millésime plus un mois pour l'annuel (IRIS → 400).
   */
  maxAgeDays: number;
}

/** Libellé court d'une source pour les sujets d'alerte ops (email, issue). */
export const INGEST_SOURCE_LABEL: Record<IngestSource, string> = {
  finess: "FINESS",
  ameli_ps: "Ameli",
  rpps: "RPPS",
  cds: "CDS",
  iris: "IRIS",
};

export const INGEST_CADENCE: Record<IngestSource, IngestCadence> = {
  finess: {
    hint: "quotidienne côté ANS (flux JSON nouvelle génération) ; cron le 1er et le 15 du mois",
    maxAgeDays: 30,
  },
  ameli_ps: { hint: "hebdomadaire (côté Annuaire Santé Ameli)", maxAgeDays: 14 },
  rpps: { hint: "mensuelle (côté Annuaire Santé ANS)", maxAgeDays: 45 },
  cds: { hint: "hebdomadaire (Centres de Santé — Annuaire Ameli CNAM)", maxAgeDays: 14 },
  iris: {
    hint: "annuelle (contours IGN CONTOURS-IRIS + démographie RP/FILOSOFI INSEE, géo 01/01/2024)",
    maxAgeDays: 400,
  },
};

export interface IngestFreshnessRow {
  source: IngestSource;
  last_success_at: string | null;
  last_success_row_count: number | null;
  last_attempt_at: string | null;
  last_attempt_status: string | null;
  /**
   * `staleness_days` calculé côté serveur depuis `last_success_at`. `null` si
   * aucun succès n'a jamais été enregistré (premier déploiement).
   */
  staleness_days: number | null;
  /**
   * Dernier run ayant RÉELLEMENT changé la donnée (`success` ou `partial`
   * SANS `skip_reason`) — distinct de `last_success_at`, qui compte aussi les
   * court-circuits « fichier amont identique ». Post-mortem FINESS 2026-09-05 :
   * source DREES tarie depuis mai, sept skips `same_checksum` en `success`
   * → `staleness_days = 4` pour une donnée vieille de 113 jours. `null` si
   * aucune ingestion réelle n'a jamais abouti.
   */
  last_data_change_at: string | null;
  /** Âge de la donnée servie, en jours, depuis `last_data_change_at`. */
  data_age_days: number | null;
  /** Âge maximal attendu (cf. `IngestCadence.maxAgeDays`) : `data_age_days` au-delà = alerte. */
  expected_max_age_days: number;
  cadence_hint: string;
}

// ── Règle « ingestion réelle » — SOURCE UNIQUE ────────────────────────────
// Consommée ici (`data_freshness`), par la vigie post-cron
// (`scripts/ingest/notify-ingest-anomaly.ts`) et par la référence de volume
// (`getLastRealIngestRowCount`, `scripts/ingest/shared.ts`). Post-mortem FINESS
// 2026-09-05 : une règle dupliquée qui dérive = un témoin qui ment.

/** Statuts écrits par les scripts d'ingestion (colonne `VARCHAR(20)` sans CHECK : le type vit ici). */
export const INGEST_STATUSES = ["success", "partial", "failed"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

/** Statuts sous lesquels la table prod a été swappée (la donnée servie a changé). */
export const REAL_INGEST_STATUSES = [
  "success",
  "partial",
] as const satisfies readonly IngestStatus[];

/** Forme minimale d'une ligne `ingest_log` pour la règle de fraîcheur. */
export interface FreshnessRowLike {
  started_at: string;
  finished_at?: string | null;
  status?: string | null;
  /** `same_checksum` = run sans ingestion réelle. Postgres renvoie NULL, jamais un champ absent. */
  skip_reason?: string | null;
}

/** `partial` = swap réussi, couche secondaire en échec : la donnée servie a bien changé. */
export const isServedRun = (r: FreshnessRowLike): boolean =>
  (REAL_INGEST_STATUSES as readonly string[]).includes(r.status ?? "");

/** Toute comparaison de statut passe par un prédicat — `status === "faild"` compilerait. */
export const isFailedRun = (r: FreshnessRowLike): boolean =>
  r.status === ("failed" satisfies IngestStatus);

/** Fin réelle du run ; `started_at` en repli si `finished_at` n'a pas été écrit (cas dégénéré). */
export const runEndedAt = (r: FreshnessRowLike): string => r.finished_at ?? r.started_at;

/** Copie triée PLUS RÉCENTE D'ABORD (par `started_at`) — les consommateurs ne présument jamais l'ordre reçu. */
export function sortNewestFirst<T extends FreshnessRowLike>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0,
  );
}

/**
 * Dernier run ayant RÉELLEMENT changé la donnée (servi ET sans court-circuit)
 * et le nombre de runs court-circuités depuis (ce que la vigie affiche). Trie
 * en interne : un appelant qui passe des lignes croissantes obtiendrait sinon
 * la PLUS ANCIENNE ingestion — `data_age_days` faux dans la sortie MCP et une
 * alerte fantôme, l'invariant « plus récent d'abord » ne vivant qu'en JSDoc.
 */
export function lastDataChange<T extends FreshnessRowLike>(
  rows: readonly T[],
): { row: T | null; skipsSince: number } {
  const sorted = sortNewestFirst(rows);
  const idx = sorted.findIndex((r) => isServedRun(r) && r.skip_reason == null);
  const before = idx >= 0 ? sorted.slice(0, idx) : sorted;
  return {
    row: idx >= 0 ? (sorted[idx] ?? null) : null,
    skipsSince: before.filter((r) => r.skip_reason != null).length,
  };
}

/**
 * Jours entiers écoulés depuis `iso` ; `null` si absent OU illisible (un
 * `Math.floor(NaN)` serait sérialisé `null` par JSON — indistinguable de
 * « jamais ingéré » — ou comparé faux par la vigie ; on rend le cas explicite).
 */
export function ageInDays(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.floor((now - t) / (1000 * 60 * 60 * 24)) : null;
}

interface CacheEntry {
  value: IngestFreshnessRow[];
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: CacheEntry | null = null;

/** Test-only : vide le cache entre deux tests pour éviter les fuites. */
export function __resetIngestLogCacheForTesting(): void {
  cache = null;
}

interface RawIngestRow extends FreshnessRowLike {
  source: string;
  finished_at: string | null;
  status: string;
  row_count: number | null;
  /** Renseigné (`same_checksum`) quand le run n'a PAS touché la donnée. */
  skip_reason: string | null;
}

/**
 * Renvoie une row par source connue, avec le dernier `success` et la dernière
 * tentative (succès ou échec). Toujours retourne TOUTES les sources, même
 * celles sans aucune row en base — `last_success_at: null` + `cadence_hint`
 * pour que le caller comprenne qu'il manque l'ingestion plutôt que de croire
 * à une réponse vide.
 */
export async function getDataFreshness(): Promise<IngestFreshnessRow[]> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.value;
  }

  // Limit raisonnable : 100 rows / source max (= 100 × INGEST_SOURCES.length).
  // Plus que largement suffisant pour trouver le dernier success même après
  // une série d'échecs.
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase
    .from("ingest_log")
    .select("source, started_at, finished_at, status, row_count, skip_reason")
    .in("source", [...INGEST_SOURCES])
    .order("started_at", { ascending: false })
    .limit(100 * INGEST_SOURCES.length);

  if (error) {
    // On ne masque pas l'erreur en silent failure : un caller appelant
    // `data_freshness` PRÉFÈRE une exception explicite à un état "tout à
    // jour" trompeur. Le tool MCP relaiera via JSON-RPC -32603.
    throw new Error(`data_freshness: erreur lecture ingest_log: ${error.message}`);
  }

  const rows = (data ?? []) as RawIngestRow[];
  const now = Date.now();
  const out: IngestFreshnessRow[] = [];
  for (const source of INGEST_SOURCES) {
    const sourceRows = sortNewestFirst(rows.filter((r) => r.source === source));
    const lastAttempt = sourceRows[0] ?? null;
    // Règle partagée (`isServedRun`, `lastDataChange`, `ageInDays`) :
    // `last_success` compte les court-circuits, `last_data_change` non — c'est
    // toute la différence entre « le cron tourne » et « la donnée bouge ».
    const lastSuccess = sourceRows.find(isServedRun) ?? null;
    const lastSuccessAt = lastSuccess ? runEndedAt(lastSuccess) : null;
    const lastChange = lastDataChange(sourceRows).row;
    const lastChangeAt = lastChange ? runEndedAt(lastChange) : null;
    out.push({
      source,
      last_success_at: lastSuccessAt,
      last_success_row_count: lastSuccess?.row_count ?? null,
      last_attempt_at: lastAttempt ? runEndedAt(lastAttempt) : null,
      last_attempt_status: lastAttempt?.status ?? null,
      staleness_days: ageInDays(lastSuccessAt, now),
      last_data_change_at: lastChangeAt,
      data_age_days: ageInDays(lastChangeAt, now),
      expected_max_age_days: INGEST_CADENCE[source].maxAgeDays,
      cadence_hint: INGEST_CADENCE[source].hint,
    });
  }

  cache = { value: out, expiresAt: now + CACHE_TTL_MS };
  return out;
}
