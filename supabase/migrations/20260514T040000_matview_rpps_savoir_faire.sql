-- V0.8.2 — Materialized view pré-agrégée pour `lister_savoir_faire_rpps`.
--
-- Diagnostic V0.8.1 (post smoke test prod) :
--   EXPLAIN ANALYZE de la query GROUP BY savoir_faire_code WHERE profession_code='10'
--   → Index Scan sur 495 270 rows (médecins France) → 21.78s. Index-only scan
--   pas possible (planner doit visiter heap pour MAX(savoir_faire_libelle)).
--   statement_timeout anon (3s) → 57014 cancel sur tous les appels.
--
-- Solution : pré-agréger via materialized view (~95 rows par profession_code,
-- ~250 rows total). Le RPC interroge la matview = lookup index ~50ms.
--
-- Trade-off : la matview est figée jusqu'à REFRESH explicite. À refresh
-- après chaque ingest RPPS (mensuel) — 1 ligne à ajouter dans
-- scripts/ingest/rpps.ts post-swap atomique. Pour l'instant, REFRESH manuel
-- via SQL Editor immédiatement après cette migration. Backlog V0.8.3 :
-- intégration au pipeline ingest.
--
-- Index UNIQUE sur (profession_code, savoir_faire_code) requis pour
-- REFRESH MATERIALIZED VIEW CONCURRENTLY (sans lock prolongé).

DROP INDEX IF EXISTS rpps_profession_savoir_faire_partial_idx;

DROP FUNCTION IF EXISTS lister_savoir_faire_rpps(TEXT);

CREATE MATERIALIZED VIEW IF NOT EXISTS rpps_savoir_faire_stats AS
SELECT
  r.profession_code,
  r.savoir_faire_code,
  MAX(r.savoir_faire_libelle) AS savoir_faire_libelle,
  COUNT(*)::BIGINT AS count_ps
FROM rpps r
WHERE r.savoir_faire_code IS NOT NULL
  AND r.profession_code IS NOT NULL
GROUP BY r.profession_code, r.savoir_faire_code;

CREATE UNIQUE INDEX IF NOT EXISTS rpps_savoir_faire_stats_pk
  ON rpps_savoir_faire_stats (profession_code, savoir_faire_code);

CREATE INDEX IF NOT EXISTS rpps_savoir_faire_stats_profession_idx
  ON rpps_savoir_faire_stats (profession_code);

GRANT SELECT ON rpps_savoir_faire_stats TO anon;

COMMENT ON MATERIALIZED VIEW rpps_savoir_faire_stats IS
  'V0.8.2 — pré-agrégation savoir_faire RPPS par profession (~250 rows). REFRESH après chaque ingest RPPS.';

-- RPC réécrite : interroge la matview au lieu de scan rpps. Tri par count_ps
-- DESC (mêmes contrats que V0.8.0).
CREATE OR REPLACE FUNCTION lister_savoir_faire_rpps(
  p_profession_code TEXT
) RETURNS TABLE (
  code        TEXT,
  libelle     TEXT,
  count_ps    BIGINT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    s.savoir_faire_code   AS code,
    s.savoir_faire_libelle AS libelle,
    s.count_ps
  FROM rpps_savoir_faire_stats s
  WHERE p_profession_code IS NULL OR s.profession_code = p_profession_code
  ORDER BY s.count_ps DESC, s.savoir_faire_code;
$$;

GRANT EXECUTE ON FUNCTION lister_savoir_faire_rpps TO anon;

COMMENT ON FUNCTION lister_savoir_faire_rpps IS
  'V0.8.2 — interroge la matview rpps_savoir_faire_stats (perf <100ms vs ~22s en V0.8.1).';

-- REFRESH initial pour peupler la matview. Sans CONCURRENTLY car premier peuplement
-- (la matview vient juste d'être créée, pas d'index UNIQUE encore utilisable).
REFRESH MATERIALIZED VIEW rpps_savoir_faire_stats;
