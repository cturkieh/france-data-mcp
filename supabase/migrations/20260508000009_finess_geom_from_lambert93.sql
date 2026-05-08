-- Reproject Lambert 93 (EPSG:2154) coords from the FINESS CSV into WGS84
-- (EPSG:4326) and populate the `geom` column on `finess_staging`.
--
-- Why: the data.gouv FINESS extract publishes coords as `coordxet`/`coordyet`
-- in Lambert 93 (the official French projection), NOT as `longitude`/`latitude`
-- in WGS84. The TS ingestion script writes those fields into the `raw` JSONB
-- column. This RPC reads them back, casts (after FR-comma normalization),
-- transforms to 4326, and writes to `geom`.
--
-- Called by scripts/ingest/finess.ts immediately after the COPY phase, before
-- the validate + atomic swap. SECURITY DEFINER because the staging table is
-- owned by postgres and service_role can't UPDATE it directly.

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
  -- Only update rows where coordxet AND coordyet look like valid numeric strings
  -- (allowing both "." and "," as decimal separator). The regex tolerates
  -- a leading sign and an optional fractional part.
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

REVOKE EXECUTE ON FUNCTION ingest_apply_finess_geom FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_apply_finess_geom TO service_role;
