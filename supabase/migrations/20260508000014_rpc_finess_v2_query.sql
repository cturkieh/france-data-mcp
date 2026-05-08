-- FINESS RPCs v2 — three changes coming out of the post-v0.2.0 audit:
--
-- 1. `finess_in_radius` switches to `geog` (geography STORED) so the GIST
--    index actually gets used. Previous shape did `ST_DWithin(geom::geography,
--    point, m)` which forces a full-table scan because the implicit cast
--    cannot use the GIST-on-`geom` index. Audit caught a 30-km no-filter
--    timeout (>8s) — the new shape is sub-100ms on the same query.
--
-- 2. `finess_by_categorie` filters on `code_departement` (real column, NOT
--    NULL) instead of `left(code_insee, 2)`. The old filter was matching
--    rows where `code_insee` was inserted as a 3-char commune-only code
--    (CHAR-padded to "105  "), so `left("105  ", 2) = "10"` and dept="08"
--    matched 221 rows nationwide instead of zero (audit B4.1).
--
-- 3. New `finess_by_num_finess(p_num_finess)` exposes the missing detail
--    lookup tool the audit (B3) flagged — caller couldn't fetch a single
--    establishment by its FINESS number.
--
-- All three RPCs return the same row shape and now include `code_departement`
-- explicitly so the caller can validate dept consistency on each row.

-- Drop signatures first so the RETURNS TABLE column list can change cleanly
-- without `cannot change return type of existing function` errors.
DROP FUNCTION IF EXISTS finess_in_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], INT);
DROP FUNCTION IF EXISTS finess_by_categorie(TEXT[], TEXT, TEXT, INT);

CREATE OR REPLACE FUNCTION finess_in_radius(
  p_lat            DOUBLE PRECISION,
  p_lon            DOUBLE PRECISION,
  p_radius_meters  DOUBLE PRECISION,
  p_codes          TEXT[],
  p_limit          INT
) RETURNS TABLE (
  num_finess        CHAR(9),
  raison_sociale    TEXT,
  categorie_code    VARCHAR(4),
  categorie_libelle TEXT,
  voie              TEXT,
  code_postal       CHAR(5),
  code_departement  CHAR(3),
  code_insee        CHAR(5),
  ville             TEXT,
  telephone         VARCHAR(20),
  email             TEXT,
  geom              JSONB,
  distance_meters   DOUBLE PRECISION
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
BEGIN
  RETURN QUERY
  SELECT
    f.num_finess, f.raison_sociale, f.categorie_code, f.categorie_libelle,
    f.voie, f.code_postal, f.code_departement, f.code_insee, f.ville,
    f.telephone, f.email,
    ST_AsGeoJSON(f.geom)::jsonb AS geom,
    ST_Distance(f.geog, v_point) AS distance_meters
  FROM finess f
  WHERE f.geog IS NOT NULL
    AND ST_DWithin(f.geog, v_point, p_radius_meters)
    AND (cardinality(p_codes) = 0 OR f.categorie_code = ANY(p_codes))
  ORDER BY f.geog <-> v_point
  LIMIT p_limit;
END;
$$;

-- by_categorie: filter on code_departement (real column) instead of
-- left(code_insee, 2) which was broken in v0.2.0 (audit B4.1, B4.2).
-- Optional code_insee filter still does an exact 5-char match.
CREATE OR REPLACE FUNCTION finess_by_categorie(
  p_codes       TEXT[],
  p_departement TEXT,
  p_code_insee  TEXT,
  p_limit       INT
) RETURNS TABLE (
  num_finess        CHAR(9),
  raison_sociale    TEXT,
  categorie_code    VARCHAR(4),
  categorie_libelle TEXT,
  voie              TEXT,
  code_postal       CHAR(5),
  code_departement  CHAR(3),
  code_insee        CHAR(5),
  ville             TEXT,
  telephone         VARCHAR(20),
  email             TEXT,
  geom              JSONB,
  distance_meters   DOUBLE PRECISION
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    f.num_finess, f.raison_sociale, f.categorie_code, f.categorie_libelle,
    f.voie, f.code_postal, f.code_departement, f.code_insee, f.ville,
    f.telephone, f.email,
    ST_AsGeoJSON(f.geom)::jsonb AS geom,
    NULL::DOUBLE PRECISION AS distance_meters
  FROM finess f
  WHERE f.categorie_code = ANY(p_codes)
    AND (p_departement IS NULL OR f.code_departement = p_departement)
    AND (p_code_insee IS NULL OR f.code_insee = p_code_insee)
  ORDER BY f.code_insee, f.num_finess
  LIMIT p_limit;
END;
$$;

-- New: detail lookup by FINESS number (audit B3 — missing tool).
-- Returns at most one row; caller treats empty result as "not found".
CREATE OR REPLACE FUNCTION finess_by_num_finess(
  p_num_finess TEXT
) RETURNS TABLE (
  num_finess        CHAR(9),
  raison_sociale    TEXT,
  categorie_code    VARCHAR(4),
  categorie_libelle TEXT,
  voie              TEXT,
  code_postal       CHAR(5),
  code_departement  CHAR(3),
  code_insee        CHAR(5),
  ville             TEXT,
  telephone         VARCHAR(20),
  email             TEXT,
  geom              JSONB,
  distance_meters   DOUBLE PRECISION
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    f.num_finess, f.raison_sociale, f.categorie_code, f.categorie_libelle,
    f.voie, f.code_postal, f.code_departement, f.code_insee, f.ville,
    f.telephone, f.email,
    ST_AsGeoJSON(f.geom)::jsonb AS geom,
    NULL::DOUBLE PRECISION AS distance_meters
  FROM finess f
  WHERE f.num_finess = p_num_finess
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION finess_in_radius     TO anon;
GRANT EXECUTE ON FUNCTION finess_by_categorie  TO anon;
GRANT EXECUTE ON FUNCTION finess_by_num_finess TO anon;

NOTIFY pgrst, 'reload schema';
