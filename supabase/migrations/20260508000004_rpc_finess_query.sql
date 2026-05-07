-- RPC 1/2: spatial search for FINESS within radius, with optional code-list filter.
-- Pass p_codes = '{}' (empty array) to disable the filter (return all categories).
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
  code_insee        CHAR(5),
  ville             TEXT,
  telephone         VARCHAR(20),
  email             TEXT,
  geom              GEOMETRY,
  distance_meters   DOUBLE PRECISION
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
BEGIN
  RETURN QUERY
  SELECT
    f.num_finess, f.raison_sociale, f.categorie_code, f.categorie_libelle,
    f.voie, f.code_postal, f.code_insee, f.ville, f.telephone, f.email, f.geom,
    ST_Distance(f.geom::geography, v_point) AS distance_meters
  FROM finess f
  WHERE f.geom IS NOT NULL
    AND ST_DWithin(f.geom::geography, v_point, p_radius_meters)
    AND (cardinality(p_codes) = 0 OR f.categorie_code = ANY(p_codes))
  ORDER BY distance_meters ASC
  LIMIT p_limit;
END;
$$;

-- RPC 2/2: filter FINESS by code list + optional department / commune (no spatial).
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
  code_insee        CHAR(5),
  ville             TEXT,
  telephone         VARCHAR(20),
  email             TEXT,
  geom              GEOMETRY,
  distance_meters   DOUBLE PRECISION
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    f.num_finess, f.raison_sociale, f.categorie_code, f.categorie_libelle,
    f.voie, f.code_postal, f.code_insee, f.ville, f.telephone, f.email, f.geom,
    NULL::DOUBLE PRECISION AS distance_meters
  FROM finess f
  WHERE f.categorie_code = ANY(p_codes)
    AND (p_departement IS NULL OR left(f.code_insee, 2) = p_departement)
    AND (p_code_insee IS NULL OR f.code_insee = p_code_insee)
  ORDER BY f.code_insee, f.num_finess
  LIMIT p_limit;
END;
$$;

-- Grant execute to anon so the read-only client can call them.
GRANT EXECUTE ON FUNCTION finess_in_radius   TO anon;
GRANT EXECUTE ON FUNCTION finess_by_categorie TO anon;
