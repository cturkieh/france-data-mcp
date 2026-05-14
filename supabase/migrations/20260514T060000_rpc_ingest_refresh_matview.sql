-- V0.9 — RPC `ingest_refresh_matview(p_matview TEXT) RETURNS VOID`.
--
-- Permet à `scripts/ingest/rpps.ts` de refresh une matview post-swap atomique
-- sans accorder de DDL public direct au service_role (qui en a été privé sur
-- public schema — cf. lessons learned V0.5+).
--
-- SECURITY DEFINER + whitelist hardcoded : seuls les noms de matviews connus
-- sont autorisés. Toute valeur hors whitelist → EXCEPTION (mitige injection SQL
-- côté caller TS, même si le caller est notre propre code).
--
-- Pourquoi REFRESH CONCURRENTLY :
--   - Les deux matviews servent des requêtes anon en prod en permanence
--     (densite_professionnels_sante, lister_specialites_medicales).
--   - Un REFRESH non-concurrent pose un AccessExclusiveLock bloquant les
--     lecteurs ~30 s sur rpps_count_stats — pas acceptable en steady state.
--   - CONCURRENTLY exige un UNIQUE INDEX (déjà présent sur les deux matviews,
--     cf. migrations V0.8.2 + V0.8.3).
--
-- statement_timeout généreux (10 min) : le REFRESH CONCURRENTLY recalcule
-- complètement la matview (scan rpps ~2.23M rows + GROUP BY + diff avec
-- l'ancien snapshot). Observé empiriquement ~60-120 s sur rpps_count_stats.
-- 10 min couvre une dégradation x5 sans masquer un vrai problème.

CREATE OR REPLACE FUNCTION ingest_refresh_matview(p_matview TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10min'
AS $$
BEGIN
  -- Whitelist explicite : refuse tout nom non listé pour limiter le blast
  -- radius en cas d'injection ou d'erreur de typage côté caller. Étendre
  -- cette liste à chaque nouvelle matview qui doit être refresh post-ingest.
  IF p_matview NOT IN ('rpps_savoir_faire_stats', 'rpps_count_stats') THEN
    RAISE EXCEPTION 'ingest_refresh_matview: matview % not in whitelist', p_matview
      USING ERRCODE = '22023';
  END IF;

  -- format(%I) escape l'identifiant (défense en profondeur), même si la
  -- whitelist garantit déjà une valeur sûre.
  EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY %I', p_matview);
END;
$$;

-- Exécution réservée au service_role (ingest CI). Pas de GRANT à anon.
REVOKE EXECUTE ON FUNCTION ingest_refresh_matview(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_refresh_matview(TEXT) TO service_role;

COMMENT ON FUNCTION ingest_refresh_matview IS
  'V0.9 — REFRESH MATERIALIZED VIEW CONCURRENTLY avec whitelist. Appelé par scripts/ingest/rpps.ts post-swap.';
