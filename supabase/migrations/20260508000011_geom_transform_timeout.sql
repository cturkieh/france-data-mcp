-- SUPERSEDED by migration 20260508000012_geom_transform_batched.sql
-- (same hot-fix batch, 2026-05-08). The function defined here,
-- `ingest_apply_finess_geom()`, is DROP'd in 0012 and replaced with the
-- batched `ingest_apply_finess_geom_batch(p_limit)`. This file is kept for
-- the chronological audit trail of what was attempted; it is effectively a
-- no-op once 0012 has been applied. Do NOT call `ingest_apply_finess_geom()`
-- from new code — it no longer exists.
--
-- Original intent (preserved for the postmortem):
-- Bump the statement timeout for the geom-transform RPC.
--
-- ST_Transform applied to 95K rows in a single UPDATE takes ~15-30s on the
-- Supabase free tier. The default statement_timeout (8s on anon role, varies
-- on service_role) cancels it. SET LOCAL inside the function scopes the
-- override to this transaction only, no global change to the cluster.
--
-- Why it was insufficient: SET LOCAL fixes Postgres-side cutoffs, but the
-- PostgREST proxy enforces its own 60s timeout, which still cancelled the
-- monolithic UPDATE. The fix was to batch client-side (see 0012).

CREATE OR REPLACE FUNCTION ingest_apply_finess_geom()
RETURNS TABLE (updated_rows INT, total_rows INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_updated INT;
  v_total   INT;
BEGIN
  -- Allow the bulk UPDATE on ~95K rows to run without hitting the default
  -- short statement timeout. Scoped to this function via SET LOCAL.
  PERFORM set_config('statement_timeout', '300s', true);

  WITH parsed AS (
    SELECT
      num_finess,
      replace(raw->>'coordxet', ',', '.') AS x_str,
      replace(raw->>'coordyet', ',', '.') AS y_str
    FROM finess_staging
    WHERE raw ? 'coordxet'
      AND raw ? 'coordyet'
      AND replace(raw->>'coordxet', ',', '.') ~ '^-?[0-9]+(\.[0-9]+)?$'
      AND replace(raw->>'coordyet', ',', '.') ~ '^-?[0-9]+(\.[0-9]+)?$'
  )
  UPDATE finess_staging f
  SET geom = ST_Transform(
    ST_SetSRID(ST_MakePoint(p.x_str::DOUBLE PRECISION, p.y_str::DOUBLE PRECISION), 2154),
    4326
  )
  FROM parsed p
  WHERE f.num_finess = p.num_finess;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  SELECT count(*) INTO v_total FROM finess_staging;

  RETURN QUERY SELECT v_updated, v_total;
END;
$$;
