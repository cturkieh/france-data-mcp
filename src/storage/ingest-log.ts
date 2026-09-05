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
   * que la future vigie « source tarie » lise la même constante. Calibré
   * cadence × 2 + marge : FINESS cron bimensuel → 30 ; Ameli/CDS hebdo → 14 ;
   * RPPS mensuel → 45 ; IRIS annuel (millésime INSEE) → 400.
   */
  maxAgeDays: number;
}

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

interface RawIngestRow {
  source: string;
  started_at: string;
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
    const sourceRows = rows.filter((r) => r.source === source);
    const lastAttempt = sourceRows[0] ?? null;
    // `partial` = swap réussi, couche secondaire (matview, canary) en échec :
    // la donnée servie a bien changé. Aligné sur `lastChange` ci-dessous —
    // sinon `data_age_days < staleness_days` sur une source dont le dernier
    // run réel est `partial`, l'inverse de ce que les deux noms promettent.
    const isServed = (r: RawIngestRow) => r.status === "success" || r.status === "partial";
    const lastSuccess = sourceRows.find(isServed) ?? null;
    // `finished_at` reflète la fin réelle ; `started_at` est le fallback
    // si la migration finale n'a pas écrit `finished_at` (cas dégénéré).
    const lastSuccessAt = lastSuccess ? (lastSuccess.finished_at ?? lastSuccess.started_at) : null;
    const daysSince = (iso: string | null): number | null =>
      iso ? Math.floor((now - new Date(iso).getTime()) / (1000 * 60 * 60 * 24)) : null;
    // Dernier run servi SANS court-circuit. La colonne `skip_reason` existe
    // depuis `20260509T140000` : Postgres renvoie NULL (jamais un champ
    // absent) ; `== null` couvre aussi un mock de test sans la clé.
    const lastChange = sourceRows.find((r) => isServed(r) && r.skip_reason == null) ?? null;
    const lastChangeAt = lastChange ? (lastChange.finished_at ?? lastChange.started_at) : null;
    out.push({
      source,
      last_success_at: lastSuccessAt,
      last_success_row_count: lastSuccess?.row_count ?? null,
      last_attempt_at: lastAttempt?.finished_at ?? lastAttempt?.started_at ?? null,
      last_attempt_status: lastAttempt?.status ?? null,
      staleness_days: daysSince(lastSuccessAt),
      last_data_change_at: lastChangeAt,
      data_age_days: daysSince(lastChangeAt),
      expected_max_age_days: INGEST_CADENCE[source].maxAgeDays,
      cadence_hint: INGEST_CADENCE[source].hint,
    });
  }

  cache = { value: out, expiresAt: now + CACHE_TTL_MS };
  return out;
}
