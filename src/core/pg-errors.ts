// Codes d'erreur Postgres (SQLSTATE) et classifieurs associés, partagés par la
// lib (`src/sante/`) et les scripts d'ingestion (`scripts/ingest/`). Vit dans
// `core/` car générique (aucune notion santé) — `sante/db-helpers.ts`
// ré-exporte `PG_STATEMENT_TIMEOUT` pour ses consommateurs historiques.

/**
 * SQLSTATE Postgres `57014` = `query_canceled` (statement timeout). Surface
 * tel quel par PostgREST dans `error.code`. Constante nommée pour éviter le
 * littéral magique dispersé (boundary lib + ingestion + tests).
 */
export const PG_STATEMENT_TIMEOUT = "57014";
/** SQLSTATE `55P03` = `lock_not_available` (NOWAIT / lock_timeout). */
export const PG_LOCK_NOT_AVAILABLE = "55P03";
/** SQLSTATE `40P01` = `deadlock_detected`. */
export const PG_DEADLOCK_DETECTED = "40P01";
/** SQLSTATE `53300` = `too_many_connections`. */
export const PG_TOO_MANY_CONNECTIONS = "53300";

/**
 * Codes SQLSTATE TRANSITOIRES d'un rebuild de matview transactionnel
 * (`ingest_rebuild_{rpps,ameli}_matviews`) : le rollback intégral préserve
 * l'ANCIENNE matview (peuplée, juste périmée) ⇒ dégradation bénigne
 * (`partial`), retry au prochain cron. Tout autre code = structurel (matview
 * cassée) → fail-loud. Source unique pour `rpps.ts` et `ameli.ts` (jadis 2
 * Sets littéraux jumeaux, dérive silencieuse possible).
 */
export const PG_TRANSIENT_REBUILD_CODES: ReadonlySet<string> = new Set([
  PG_LOCK_NOT_AVAILABLE,
  PG_DEADLOCK_DETECTED,
  PG_STATEMENT_TIMEOUT,
  PG_TOO_MANY_CONNECTIONS,
]);

/**
 * Forme minimale d'une erreur SQL remontée par PostgREST / supabase-js
 * (`PostgrestError` et `Error` y sont assignables). Type STRUCTUREL volontaire
 * (pas `unknown`) : passer le résultat entier `{ data, error }` au lieu de
 * `result.error`, ou une string, est une ERREUR DE COMPILATION — un mésusage
 * qui rendrait `false` en silence désarmerait la relance sans bruit.
 */
export type PgErrorLike = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

/**
 * `true` si `error` est un statement timeout Postgres. Contrat typé d'abord
 * (`code === "57014"`, `String()` défensif si un transport sérialise le code
 * en nombre), puis regex sur `message`/`details`/`hint` en filet — PostgREST
 * peut aplatir l'erreur dans `message` sans `code` (cf.
 * `isTransientSupabaseError`, même scan de surface). `null`/`undefined` →
 * `false` (un résultat sans erreur n'est pas un timeout).
 */
export function isStatementTimeoutError(error: PgErrorLike | null | undefined): boolean {
  if (!error) return false;
  if (String(error.code) === PG_STATEMENT_TIMEOUT) return true;
  return [error.message, error.details, error.hint].some(
    (p) => typeof p === "string" && /statement timeout/i.test(p),
  );
}
