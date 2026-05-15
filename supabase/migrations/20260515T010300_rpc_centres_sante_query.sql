-- V0.10 — RPCs CDS query (lecture côté MCP).
--   * `centres_sante_in_radius` : recherche radius PostGIS + filtres optionnels
--     (specialite_code via array contains, accepte_carte_vitale, type_etab_code).
--   * `centres_sante_by_finess` : lookup par PK etab_finess (LookupResult pattern).
--
-- Pattern aligné sur ameli_in_radius / finess_in_radius :
--   - geog dédiée (générée STORED) pour ST_DWithin index lookup
--   - ST_AsGeoJSON(geom)::jsonb obligatoire (sinon hex EWKB côté PostgREST)
--   - LANGUAGE plpgsql STABLE (cacheable PostgREST short retry window)
--
-- Filtre spécialité : utilise l'opérateur array overlap `&&` (any-of) pour
-- matcher "ce CDS exerce AU MOINS UNE des spécialités demandées" — sémantique
-- alignée avec un usage utilisateur typique ("trouve-moi les CDS qui font de
-- la médecine générale OU de la cardiologie"). `&&` est indexable par le GIN
-- array_ops. Pour "TOUTES les spécialités", le caller utiliserait `@>` ;
-- non exposé en V0.10 (rare en pratique).

CREATE OR REPLACE FUNCTION centres_sante_in_radius(
  p_lat                 DOUBLE PRECISION,
  p_lon                 DOUBLE PRECISION,
  p_radius_meters       DOUBLE PRECISION,
  p_specialite_codes    TEXT[],
  p_accepte_carte_vitale BOOLEAN,
  p_type_etab_codes     TEXT[],
  p_limit               INT
) RETURNS TABLE (
  etab_finess               CHAR(9),
  etab_raison_sociale       TEXT,
  accepte_carte_vitale      BOOLEAN,
  accepte_apcv              BOOLEAN,
  specialites_codes         TEXT[],
  specialites_libelles      TEXT[],
  type_etab_code            TEXT,
  type_etab_libelle         TEXT,
  telephone                 TEXT,
  voie                      TEXT,
  complement_voie           TEXT,
  lieu_dit                  TEXT,
  code_postal               CHAR(5),
  ville                     TEXT,
  code_departement          CHAR(3),
  code_insee                CHAR(5),
  geom                      JSONB,
  distance_meters           DOUBLE PRECISION
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
BEGIN
  RETURN QUERY
  SELECT
    c.etab_finess,
    c.etab_raison_sociale,
    c.accepte_carte_vitale,
    c.accepte_apcv,
    c.specialites_codes,
    c.specialites_libelles,
    c.type_etab_code,
    c.type_etab_libelle,
    c.telephone,
    c.voie, c.complement_voie, c.lieu_dit,
    c.code_postal, c.ville, c.code_departement, c.code_insee,
    ST_AsGeoJSON(c.geom)::jsonb AS geom,
    ST_Distance(c.geog, v_point) AS distance_meters
  FROM centres_sante c
  WHERE c.geog IS NOT NULL
    AND ST_DWithin(c.geog, v_point, p_radius_meters)
    -- Filtre specialité : `&&` array overlap (any-of, GIN-indexable).
    -- cardinality 0 → pas de filtre.
    AND (cardinality(p_specialite_codes) = 0 OR c.specialites_codes && p_specialite_codes)
    -- Filtre carte vitale : NULL → pas de filtre, TRUE/FALSE → match exact.
    AND (p_accepte_carte_vitale IS NULL OR c.accepte_carte_vitale = p_accepte_carte_vitale)
    -- Filtre type établissement : 124 (CDS standard) ou 125 (CDS dentaire).
    AND (cardinality(p_type_etab_codes) = 0 OR c.type_etab_code = ANY(p_type_etab_codes))
  ORDER BY c.geog <-> v_point
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION centres_sante_in_radius(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  TEXT[], BOOLEAN, TEXT[], INT
) TO anon, authenticated, service_role;

-- Lookup par PK etab_finess. LIMIT 1 défensif (PK = unique par contrat,
-- mais defense-in-depth si un swap glitch retourne 2 rows).
CREATE OR REPLACE FUNCTION centres_sante_by_finess(
  p_etab_finess CHAR(9)
) RETURNS TABLE (
  etab_finess               CHAR(9),
  etab_raison_sociale       TEXT,
  accepte_carte_vitale      BOOLEAN,
  accepte_apcv              BOOLEAN,
  specialites_codes         TEXT[],
  specialites_libelles      TEXT[],
  type_etab_code            TEXT,
  type_etab_libelle         TEXT,
  telephone                 TEXT,
  voie                      TEXT,
  complement_voie           TEXT,
  lieu_dit                  TEXT,
  code_postal               CHAR(5),
  ville                     TEXT,
  code_departement          CHAR(3),
  code_insee                CHAR(5),
  geom                      JSONB
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.etab_finess,
    c.etab_raison_sociale,
    c.accepte_carte_vitale,
    c.accepte_apcv,
    c.specialites_codes,
    c.specialites_libelles,
    c.type_etab_code,
    c.type_etab_libelle,
    c.telephone,
    c.voie, c.complement_voie, c.lieu_dit,
    c.code_postal, c.ville, c.code_departement, c.code_insee,
    ST_AsGeoJSON(c.geom)::jsonb AS geom
  FROM centres_sante c
  WHERE c.etab_finess = p_etab_finess
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION centres_sante_by_finess(CHAR(9)) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
