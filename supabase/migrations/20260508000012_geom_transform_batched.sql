-- Replace the monolithic ingest_apply_finess_geom RPC with a batched version.
--
-- The previous version did the whole UPDATE in one statement, which exceeded
-- PostgREST's 60-second cutoff on Supabase. SET LOCAL statement_timeout helps
-- with Postgres-side cutoffs but not with PostgREST proxy timeouts.
--
-- New shape: ingest_apply_finess_geom_batch(p_limit) updates up to `p_limit`
-- rows that don't have a geom yet, returns how many it touched. Caller loops
-- until the function returns 0.

DROP FUNCTION IF EXISTS ingest_apply_finess_geom();

CREATE OR REPLACE FUNCTION ingest_apply_finess_geom_batch(p_limit INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_updated INT;
BEGIN
  WITH batch AS (
    SELECT
      num_finess,
      replace(raw->>'coordxet', ',', '.') AS x_str,
      replace(raw->>'coordyet', ',', '.') AS y_str
    FROM finess_staging
    WHERE geom IS NULL
      AND raw ? 'coordxet'
      AND raw ? 'coordyet'
      AND replace(raw->>'coordxet', ',', '.') ~ '^-?[0-9]+(\.[0-9]+)?$'
      AND replace(raw->>'coordyet', ',', '.') ~ '^-?[0-9]+(\.[0-9]+)?$'
    LIMIT p_limit
  )
  UPDATE finess_staging f
  SET geom = ST_Transform(
    ST_SetSRID(ST_MakePoint(b.x_str::DOUBLE PRECISION, b.y_str::DOUBLE PRECISION), 2154),
    4326
  )
  FROM batch b
  WHERE f.num_finess = b.num_finess;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_apply_finess_geom_batch FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_apply_finess_geom_batch TO service_role;
