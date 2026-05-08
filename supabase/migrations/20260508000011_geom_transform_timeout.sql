-- Bump the statement timeout for the geom-transform RPC.
--
-- ST_Transform applied to 95K rows in a single UPDATE takes ~15-30s on the
-- Supabase free tier. The default statement_timeout (8s on anon role, varies
-- on service_role) cancels it. SET LOCAL inside the function scopes the
-- override to this transaction only — no global change to the cluster.
--
-- 5 minutes is generous; the UPDATE finishes well under that. Future Ameli
-- (1.5M rows) might need its own RPC with the same pattern.

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
