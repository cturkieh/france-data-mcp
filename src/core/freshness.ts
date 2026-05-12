/**
 * Helper d'injection opt-in du champ `data_freshness` dans les payloads des
 * tools FINESS / RPPS / Ameli.
 *
 * Pourquoi opt-in plutôt que par défaut : exposer la fraîcheur sur CHAQUE
 * réponse polluerait les payloads des callers LLM qui font de la pagination
 * ou des appels rapprochés. Un opt-in via `include_freshness: true` garde le
 * payload léger pour les usages courants tout en exposant la fraîcheur quand
 * c'est utile (audit, contrôle qualité, automatisation à horizon long).
 *
 * Coût : le helper est cache-friendly (`getDataFreshness` cache 5min), donc
 * activer `include_freshness: true` ajoute 0 RPC supplémentaire dans 99% des
 * cas — uniquement la sérialisation de 3-4 champs par source.
 */

import {
  type IngestFreshnessRow,
  type IngestSource,
  getDataFreshness,
} from "../storage/ingest-log.js";

/**
 * Renvoie la fraîcheur ingestion filtrée sur les sources demandées. Utile
 * pour n'exposer que les sources réellement consommées par un tool donné
 * (ex: un tool FINESS-only n'a pas besoin d'exposer la freshness RPPS).
 *
 * Retourne `null` si aucune des sources demandées n'a de row dans
 * `ingest_log` (cas dégradé, ne devrait pas arriver en prod après v0.5.0).
 */
export async function getFreshnessFor(
  sources: readonly IngestSource[],
): Promise<IngestFreshnessRow[] | null> {
  const all = await getDataFreshness();
  const wanted = new Set<IngestSource>(sources);
  const filtered = all.filter((row) => wanted.has(row.source));
  return filtered.length > 0 ? filtered : null;
}

/**
 * Wrappeur "no-op si désactivé" : retourne le `result` inchangé si
 * `include_freshness !== true`, sinon ajoute le champ `data_freshness` au
 * `query_metadata` du payload (ou à la racine si pas de `query_metadata`).
 *
 * Comportement explicite sur la valeur d'entrée : on accepte uniquement le
 * littéral `true` (= booleen JSON strict). Tout autre valeur (`"true"`,
 * `1`, `undefined`, …) garde le comportement par défaut "pas de freshness".
 * Évite les faux positifs sur les agents qui auraient un schema JSON loose.
 */
export async function withFreshness<T extends object>(
  result: T,
  includeFreshness: unknown,
  sources: readonly IngestSource[],
): Promise<T> {
  if (includeFreshness !== true) return result;
  // L'enrichissement freshness est OPTIONNEL : si `getDataFreshness` throw
  // (ingest_log indisponible, RLS broken, network), on ne doit PAS faire
  // échouer le tool entier — la donnée métier (FINESS / RPPS / Ameli) reste
  // valide. On dégrade gracefully en injectant `data_freshness_error` pour
  // que le caller LLM sache que l'opt-in a échoué.
  let freshness: IngestFreshnessRow[] | null = null;
  let freshnessError: string | null = null;
  try {
    freshness = await getFreshnessFor(sources);
  } catch (err) {
    freshnessError = err instanceof Error ? err.message : String(err);
    console.error(
      `[france-data-mcp] withFreshness: getDataFreshness failed (returning payload without data_freshness): ${freshnessError}`,
    );
  }
  if (!freshness && !freshnessError) return result;
  const existingMeta = (result as { query_metadata?: unknown }).query_metadata;
  const hasMetaObject =
    typeof existingMeta === "object" && existingMeta !== null && !Array.isArray(existingMeta);
  const freshnessFields: Record<string, unknown> = freshness
    ? { data_freshness: freshness }
    : { data_freshness_error: freshnessError };
  // `query_metadata` présent → enrichit (préserve `cadence_hint` et autres
  // champs existants). Absent → champs au top-level (LookupResult unitaire
  // type `etablissement_by_finess`).
  if (hasMetaObject) {
    return {
      ...result,
      query_metadata: {
        ...(existingMeta as Record<string, unknown>),
        ...freshnessFields,
      },
    };
  }
  return { ...result, ...freshnessFields };
}

/**
 * Schema JSON Schema pour le paramètre `include_freshness`. Centralisé pour
 * que tous les tools le déclarent à l'identique (même description, même
 * default), évitant la dérive sémantique.
 */
export const INCLUDE_FRESHNESS_SCHEMA = {
  type: "boolean",
  default: false,
  description:
    "Si true, ajoute un champ `data_freshness` au payload (dans `query_metadata` si présent, sinon à la racine) listant la dernière ingestion réussie par source (FINESS, Ameli, RPPS) avec `staleness_days`. Opt-in pour ne pas alourdir les payloads par défaut. Cache 5min côté serveur — coût négligeable.",
} as const;
