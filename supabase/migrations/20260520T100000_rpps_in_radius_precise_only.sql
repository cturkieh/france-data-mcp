-- V0.12.0 — `rpps_in_radius` gagne un param `p_precise_only BOOLEAN DEFAULT FALSE`.
-- Quand true : la CTE `centroid` est entièrement court-circuitée (WHERE FALSE
-- via `NOT p_precise_only`), aucun PS au centroïde commune n'est inclus. La
-- CTE `precise` (geom_source IN finess_join|ban_address, index GiST PARTIEL
-- rpps_geog_precise_gist V0.11.0) reste l'unique source ⇒ tri global par
-- distance exacte, aucun bias commune-bound.
--
-- Quand false (= défaut, contrat V0.11.0 préservé byte-pour-byte) :
-- comportement hybride inchangé (precise UNION ALL centroid, tri global par
-- distance_meters, sentinelle P0002 matview vide).
--
-- ⚠️ Postgres INTERDIT `CREATE OR REPLACE FUNCTION` quand la signature change
-- (ajout d'un nouveau param, même avec DEFAULT) : ERROR 42P13 "cannot change
-- name of input parameter". DROP explicite obligatoire AVANT le CREATE.
-- Le DROP révoque les GRANT → re-GRANT après le CREATE (cf. V0.11.0 hybrid).

DROP FUNCTION IF EXISTS rpps_in_radius(
  double precision, double precision, double precision,
  text[], text[], text[], text[], integer
);

CREATE OR REPLACE FUNCTION rpps_in_radius(
  p_lat DOUBLE PRECISION, p_lon DOUBLE PRECISION, p_radius_meters DOUBLE PRECISION,
  p_profession_codes TEXT[], p_savoir_faire_codes TEXT[], p_mode_exercice_codes TEXT[],
  p_categorie_codes TEXT[], p_limit INT,
  p_precise_only BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
  id BIGINT, rpps_id TEXT, civilite TEXT, nom TEXT, prenom TEXT,
  profession_code TEXT, profession_libelle TEXT,
  savoir_faire_code TEXT, savoir_faire_libelle TEXT,
  mode_exercice_code TEXT, mode_exercice_libelle TEXT,
  categorie_code TEXT, categorie_libelle TEXT,
  num_finess TEXT, num_finess_ej TEXT, siret TEXT, raison_sociale TEXT,
  adresse TEXT, code_postal CHAR(5), ville TEXT,
  code_departement CHAR(3), code_insee CHAR(5), telephone TEXT,
  geom JSONB, distance_meters DOUBLE PRECISION,
  geo_precision TEXT
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
  v_centroid_total BIGINT;
BEGIN
  -- Sentinelle P0002 (matview vide) : sautée quand precise_only=true puisque
  -- la branche centroïde n'est pas exécutée. Sinon = invariant V0.11.0.
  IF NOT p_precise_only THEN
    SELECT COUNT(*) INTO v_centroid_total FROM rpps_commune_centroids;
    IF v_centroid_total = 0 THEN
      RAISE EXCEPTION 'rpps_commune_centroids matview is empty (cardinality 0). Refusing to return zero rows silently — run REFRESH MATERIALIZED VIEW rpps_commune_centroids.'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN QUERY
  WITH
  -- Branche précise : geom_source IN finess_join|ban_address, distance exacte,
  -- index GiST PARTIEL rpps_geog_precise_gist (V0.11.0, prédicat byte-identique
  -- au WHERE — garde-fou staging-parity).
  precise AS (
    SELECT r.id, r.rpps_id, r.civilite, r.nom, r.prenom,
           r.profession_code, r.profession_libelle,
           r.savoir_faire_code, r.savoir_faire_libelle,
           r.mode_exercice_code, r.mode_exercice_libelle,
           r.categorie_code, r.categorie_libelle,
           r.num_finess, r.num_finess_ej, r.siret, r.raison_sociale,
           r.adresse, r.code_postal, r.ville,
           r.code_departement, r.code_insee, r.telephone,
           ST_AsGeoJSON(r.geom)::jsonb AS geom,
           ST_Distance(r.geog, v_point) AS distance_meters,
           CASE r.geom_source
             WHEN 'ban_address' THEN 'adresse'
             WHEN 'finess_join' THEN 'etablissement_finess'
           END::text AS geo_precision
    FROM rpps r
    WHERE r.geom_source IN ('finess_join','ban_address')          -- match exact index partiel
      AND ST_DWithin(r.geog, v_point, p_radius_meters)
      AND (cardinality(p_profession_codes)    = 0 OR r.profession_code    = ANY(p_profession_codes))
      AND (cardinality(p_savoir_faire_codes)  = 0 OR r.savoir_faire_code  = ANY(p_savoir_faire_codes))
      AND (cardinality(p_mode_exercice_codes) = 0 OR r.mode_exercice_code = ANY(p_mode_exercice_codes))
      AND rpps_categorie_match(r.categorie_code, p_categorie_codes)
    ORDER BY distance_meters
    LIMIT p_limit
  ),
  -- Branche centroïde RÉSIDUELLE (geom_source='commune_centroid' uniquement).
  -- Court-circuit V0.12.0 via `NOT p_precise_only` : le scan matview reste
  -- effectué (Postgres n'élimine pas la CTE à la planification sur un param
  -- BOOL, custom plan ou non), mais le `NOT p_precise_only` court-circuite
  -- l'évaluation par-ligne avant le ST_DWithin coûteux → 0 ligne produite,
  -- LATERAL non exécuté en aval. Overhead mesuré ~1-3 ms sur ~36K rangées
  -- de la matview indexée — négligeable vs un IF/ELSE plpgsql qui ajouterait
  -- 2 branches RETURN QUERY redondantes pour gagner ~2 ms.
  communes AS (
    SELECT c.code_insee AS cc_insee, ST_Distance(c.geog, v_point) AS cdist
    FROM rpps_commune_centroids c
    WHERE NOT p_precise_only
      AND ST_DWithin(c.geog, v_point, p_radius_meters)
  ),
  centroid AS (
    SELECT x.id, x.rpps_id, x.civilite, x.nom, x.prenom,
           x.profession_code, x.profession_libelle,
           x.savoir_faire_code, x.savoir_faire_libelle,
           x.mode_exercice_code, x.mode_exercice_libelle,
           x.categorie_code, x.categorie_libelle,
           x.num_finess, x.num_finess_ej, x.siret, x.raison_sociale,
           x.adresse, x.code_postal, x.ville,
           x.code_departement, x.code_insee, x.telephone,
           x.geom, x.distance_meters, 'centroide_commune'::text AS geo_precision
    FROM communes cm
    CROSS JOIN LATERAL (
      SELECT r.id, r.rpps_id, r.civilite, r.nom, r.prenom,
             r.profession_code, r.profession_libelle,
             r.savoir_faire_code, r.savoir_faire_libelle,
             r.mode_exercice_code, r.mode_exercice_libelle,
             r.categorie_code, r.categorie_libelle,
             r.num_finess, r.num_finess_ej, r.siret, r.raison_sociale,
             r.adresse, r.code_postal, r.ville,
             r.code_departement, r.code_insee, r.telephone,
             ST_AsGeoJSON(r.geom)::jsonb AS geom,
             cm.cdist AS distance_meters
      FROM rpps r
      WHERE r.code_insee = cm.cc_insee
        AND r.geom_source = 'commune_centroid'                     -- disjonction V0.11.0
        AND (cardinality(p_profession_codes)    = 0 OR r.profession_code    = ANY(p_profession_codes))
        AND (cardinality(p_savoir_faire_codes)  = 0 OR r.savoir_faire_code  = ANY(p_savoir_faire_codes))
        AND (cardinality(p_mode_exercice_codes) = 0 OR r.mode_exercice_code = ANY(p_mode_exercice_codes))
        AND rpps_categorie_match(r.categorie_code, p_categorie_codes)
      ORDER BY r.id
      LIMIT p_limit
    ) x
  )
  SELECT * FROM precise
  UNION ALL
  SELECT * FROM centroid
  ORDER BY distance_meters, id
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION rpps_in_radius(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  TEXT[], TEXT[], TEXT[], TEXT[], INT, BOOLEAN
) TO anon;

COMMENT ON FUNCTION rpps_in_radius(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  TEXT[], TEXT[], TEXT[], TEXT[], INT, BOOLEAN
) IS
  'V0.12.0 — Hybride (precise UNION ALL centroid) avec param p_precise_only. true → centroid CTE court-circuitée, 100% précis, tri par distance exacte. false (défaut) = contrat V0.11.0 inchangé.';

NOTIFY pgrst, 'reload schema';
