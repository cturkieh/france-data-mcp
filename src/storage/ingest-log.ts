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
export const INGEST_SOURCES = ["finess", "ameli_ps", "rpps"] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

/**
 * Cadence attendue par source. Affichée par `data_freshness` pour que le
 * caller puisse interpréter un `last_success_at` vieux d'une semaine
 * (=normal pour Ameli, =alerte pour RPPS, =critique pour FINESS).
 */
export const INGEST_CADENCE: Record<IngestSource, string> = {
  finess: "bimestrielle (~tous les 2 mois côté DREES)",
  ameli_ps: "hebdomadaire (côté Annuaire Santé Ameli)",
  rpps: "mensuelle (côté Annuaire Santé ANS)",
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

  // Limit raisonnable : 100 rows / source max = 300 rows. Plus que largement
  // suffisant pour trouver le dernier success même après une série d'échecs.
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase
    .from("ingest_log")
    .select("source, started_at, finished_at, status, row_count")
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
    const lastSuccess = sourceRows.find((r) => r.status === "success") ?? null;
    // `finished_at` reflète la fin réelle ; `started_at` est le fallback
    // si la migration finale n'a pas écrit `finished_at` (cas dégénéré).
    const lastSuccessAt = lastSuccess ? (lastSuccess.finished_at ?? lastSuccess.started_at) : null;
    const stalenessDays = lastSuccessAt
      ? Math.floor((now - new Date(lastSuccessAt).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    out.push({
      source,
      last_success_at: lastSuccessAt,
      last_success_row_count: lastSuccess?.row_count ?? null,
      last_attempt_at: lastAttempt?.finished_at ?? lastAttempt?.started_at ?? null,
      last_attempt_status: lastAttempt?.status ?? null,
      staleness_days: stalenessDays,
      cadence_hint: INGEST_CADENCE[source],
    });
  }

  cache = { value: out, expiresAt: now + CACHE_TTL_MS };
  return out;
}
