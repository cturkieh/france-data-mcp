-- V0.12.0 — `rpps_search_by_name` retourne `geo_precision` (+1 colonne).
-- Mapping IDENTIQUE à `rpps_in_radius` V0.11.0+ :
--   ban_address      → 'adresse'
--   finess_join      → 'etablissement_finess'
--   commune_centroid → 'centroide_commune'
--   autre / NULL     → NULL (mapping TS omet alors le champ public)
--
-- Pourquoi propager : `rpps_search_by_name` retourne déjà `geom` (coords du
-- premier site du PS). Sans `geo_precision`, le mapping TS `toResult`
-- hardcodait `centroide_commune` même pour les PS finess_join/ban_address —
-- la précision conquise (~68,5%) était jetée à la sortie.
--
-- ⚠️ Signature RETURNS TABLE change (+1 colonne) → DROP+CREATE obligatoire
-- (42P13). Le DROP révoque les GRANT → re-GRANT après. Recopie VERBATIM de
-- 20260516T030000 + ajout colonne (règle « SUPERSET STRICT »).

DROP FUNCTION IF EXISTS rpps_search_by_name(TEXT, TEXT, TEXT, TEXT[], INT);

CREATE OR REPLACE FUNCTION rpps_search_by_name(
  p_nom              TEXT,
  p_prenom           TEXT,
  p_departement      TEXT,
  p_categorie_codes  TEXT[],
  p_limit            INT
) RETURNS TABLE (
  id                       BIGINT,
  rpps_id                  TEXT,
  civilite                 TEXT,
  nom                      TEXT,
  prenom                   TEXT,
  profession_code          TEXT,
  profession_libelle       TEXT,
  savoir_faire_code        TEXT,
  savoir_faire_libelle     TEXT,
  mode_exercice_code       TEXT,
  mode_exercice_libelle    TEXT,
  categorie_code           TEXT,
  categorie_libelle        TEXT,
  num_finess               TEXT,
  num_finess_ej            TEXT,
  siret                    TEXT,
  raison_sociale           TEXT,
  adresse                  TEXT,
  code_postal              CHAR(5),
  ville                    TEXT,
  code_departement         CHAR(3),
  code_insee               CHAR(5),
  telephone                TEXT,
  geom                     JSONB,
  geo_precision            TEXT,
  match_score              REAL
)
LANGUAGE plpgsql STABLE
SET statement_timeout = '10s'
AS $$
DECLARE
  v_nom    TEXT    := lower(trim(p_nom));
  v_prenom TEXT    := lower(trim(coalesce(p_prenom, '')));
  v_categorie_codes TEXT[] := COALESCE(NULLIF(p_categorie_codes, ARRAY[]::TEXT[]), ARRAY['C']);
  v_candidate_cap CONSTANT INT := 2000;
BEGIN
  IF v_nom IS NULL OR v_nom = '' THEN
    RAISE EXCEPTION 'p_nom is required (non empty)' USING ERRCODE = '22023';
  END IF;
  IF p_departement IS NOT NULL AND p_departement !~ '^(\d{2,3}|2A|2B)$' THEN
    RAISE EXCEPTION 'p_departement must match ^(\d{2,3}|2A|2B)$ (got: %)', p_departement
      USING ERRCODE = '22023';
  END IF;

  IF v_prenom <> '' THEN
    RETURN QUERY
      WITH cand AS (
        SELECT r.*
        FROM rpps r
        WHERE lower(r.nom) % v_nom
          AND lower(r.prenom) % v_prenom
          AND (p_departement IS NULL OR r.code_departement = p_departement::CHAR(3))
          AND (r.categorie_code = ANY(v_categorie_codes) OR r.categorie_code IS NULL)
        LIMIT v_candidate_cap
      )
      SELECT
        c.id, c.rpps_id, c.civilite, c.nom, c.prenom,
        c.profession_code, c.profession_libelle,
        c.savoir_faire_code, c.savoir_faire_libelle,
        c.mode_exercice_code, c.mode_exercice_libelle,
        c.categorie_code, c.categorie_libelle,
        c.num_finess, c.num_finess_ej, c.siret, c.raison_sociale,
        c.adresse, c.code_postal, c.ville,
        c.code_departement, c.code_insee, c.telephone,
        ST_AsGeoJSON(c.geom)::jsonb AS geom,
        CASE c.geom_source
          WHEN 'ban_address'      THEN 'adresse'
          WHEN 'finess_join'      THEN 'etablissement_finess'
          WHEN 'commune_centroid' THEN 'centroide_commune'
        END::text AS geo_precision,
        ((extensions.similarity(lower(c.nom), v_nom)
          + extensions.similarity(lower(c.prenom), v_prenom)) / 2.0)::REAL AS match_score
      FROM cand c
      ORDER BY match_score DESC, c.nom, c.prenom, c.id
      LIMIT p_limit;
  ELSE
    RETURN QUERY
      WITH cand AS (
        SELECT r.*
        FROM rpps r
        WHERE lower(r.nom) % v_nom
          AND (p_departement IS NULL OR r.code_departement = p_departement::CHAR(3))
          AND (r.categorie_code = ANY(v_categorie_codes) OR r.categorie_code IS NULL)
        LIMIT v_candidate_cap
      )
      SELECT
        c.id, c.rpps_id, c.civilite, c.nom, c.prenom,
        c.profession_code, c.profession_libelle,
        c.savoir_faire_code, c.savoir_faire_libelle,
        c.mode_exercice_code, c.mode_exercice_libelle,
        c.categorie_code, c.categorie_libelle,
        c.num_finess, c.num_finess_ej, c.siret, c.raison_sociale,
        c.adresse, c.code_postal, c.ville,
        c.code_departement, c.code_insee, c.telephone,
        ST_AsGeoJSON(c.geom)::jsonb AS geom,
        CASE c.geom_source
          WHEN 'ban_address'      THEN 'adresse'
          WHEN 'finess_join'      THEN 'etablissement_finess'
          WHEN 'commune_centroid' THEN 'centroide_commune'
        END::text AS geo_precision,
        extensions.similarity(lower(c.nom), v_nom)::REAL AS match_score
      FROM cand c
      ORDER BY match_score DESC, c.nom, c.prenom, c.id
      LIMIT p_limit;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION rpps_search_by_name TO anon;

NOTIFY pgrst, 'reload schema';
