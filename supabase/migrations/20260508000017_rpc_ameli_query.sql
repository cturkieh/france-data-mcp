-- V0.4 phase 1 — Ameli RPCs (radius search + department/specialty listing).
-- Mirrors FINESS RPC contract: same param order conventions (lat, lon,
-- radius_meters, codes, limit), JSONB geom (ST_AsGeoJSON, never raw EWKB —
-- PostgREST hex-encodes geometry otherwise; lesson from FINESS V0.2),
-- explicit code_departement column on every row.

DROP FUNCTION IF EXISTS ameli_in_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], TEXT[], INT);
DROP FUNCTION IF EXISTS ameli_by_specialite_dept(TEXT, TEXT, TEXT, INT);

CREATE OR REPLACE FUNCTION ameli_in_radius(
  p_lat               DOUBLE PRECISION,
  p_lon               DOUBLE PRECISION,
  p_radius_meters     DOUBLE PRECISION,
  p_specialite_codes  TEXT[],
  p_type_ps_codes     TEXT[],
  p_limit             INT
) RETURNS TABLE (
  id                            BIGINT,
  nom                           TEXT,
  prenom                        TEXT,
  civilite                      TEXT,
  raison_sociale                TEXT,
  specialite_code               TEXT,
  specialite_libelle            TEXT,
  type_ps_code                  TEXT,
  type_ps_libelle               TEXT,
  adresse                       TEXT,
  code_postal                   CHAR(5),
  ville                         TEXT,
  code_departement              CHAR(3),
  code_insee                    CHAR(5),
  secteur_conventionnel_code    TEXT,
  secteur_conventionnel_libelle TEXT,
  nature_exercice_code          TEXT,
  nature_exercice_libelle       TEXT,
  option_tarifaire_code         TEXT,
  option_tarifaire_libelle      TEXT,
  telephone                     TEXT,
  geom                          JSONB,
  distance_meters               DOUBLE PRECISION
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
BEGIN
  RETURN QUERY
  SELECT
    a.id,
    a.nom, a.prenom, a.civilite, a.raison_sociale,
    a.specialite_code, a.specialite_libelle,
    a.type_ps_code, a.type_ps_libelle,
    a.adresse, a.code_postal, a.ville,
    a.code_departement, a.code_insee,
    a.secteur_conventionnel_code, a.secteur_conventionnel_libelle,
    a.nature_exercice_code, a.nature_exercice_libelle,
    a.option_tarifaire_code, a.option_tarifaire_libelle,
    a.telephone,
    ST_AsGeoJSON(a.geom)::jsonb AS geom,
    ST_Distance(a.geog, v_point) AS distance_meters
  FROM annuaire_ameli a
  WHERE a.geog IS NOT NULL
    AND ST_DWithin(a.geog, v_point, p_radius_meters)
    AND (cardinality(p_specialite_codes) = 0 OR a.specialite_code = ANY(p_specialite_codes))
    AND (cardinality(p_type_ps_codes)    = 0 OR a.type_ps_code    = ANY(p_type_ps_codes))
  ORDER BY a.geog <-> v_point
  LIMIT p_limit;
END;
$$;

-- Listing by department + optional specialty / type filter.
-- Returns up to p_limit rows. No geometry needed for the typical caller (a
-- counter or a directory view) — but we expose `geom` as JSONB for symmetry
-- with the radius RPC and so the caller can map results without a second call.
CREATE OR REPLACE FUNCTION ameli_by_specialite_dept(
  p_departement     TEXT,
  p_specialite_code TEXT,
  p_type_ps_code    TEXT,
  p_limit           INT
) RETURNS TABLE (
  id                            BIGINT,
  nom                           TEXT,
  prenom                        TEXT,
  civilite                      TEXT,
  raison_sociale                TEXT,
  specialite_code               TEXT,
  specialite_libelle            TEXT,
  type_ps_code                  TEXT,
  type_ps_libelle               TEXT,
  adresse                       TEXT,
  code_postal                   CHAR(5),
  ville                         TEXT,
  code_departement              CHAR(3),
  code_insee                    CHAR(5),
  secteur_conventionnel_code    TEXT,
  secteur_conventionnel_libelle TEXT,
  nature_exercice_code          TEXT,
  nature_exercice_libelle       TEXT,
  option_tarifaire_code         TEXT,
  option_tarifaire_libelle      TEXT,
  telephone                     TEXT,
  geom                          JSONB,
  distance_meters               DOUBLE PRECISION
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.id,
    a.nom, a.prenom, a.civilite, a.raison_sociale,
    a.specialite_code, a.specialite_libelle,
    a.type_ps_code, a.type_ps_libelle,
    a.adresse, a.code_postal, a.ville,
    a.code_departement, a.code_insee,
    a.secteur_conventionnel_code, a.secteur_conventionnel_libelle,
    a.nature_exercice_code, a.nature_exercice_libelle,
    a.option_tarifaire_code, a.option_tarifaire_libelle,
    a.telephone,
    ST_AsGeoJSON(a.geom)::jsonb AS geom,
    NULL::DOUBLE PRECISION       AS distance_meters
  FROM annuaire_ameli a
  WHERE a.code_departement = p_departement
    AND (p_specialite_code IS NULL OR a.specialite_code = p_specialite_code)
    AND (p_type_ps_code    IS NULL OR a.type_ps_code    = p_type_ps_code)
  ORDER BY a.code_insee NULLS LAST, a.nom, a.prenom
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION ameli_in_radius          TO anon;
GRANT EXECUTE ON FUNCTION ameli_by_specialite_dept TO anon;

NOTIFY pgrst, 'reload schema';
