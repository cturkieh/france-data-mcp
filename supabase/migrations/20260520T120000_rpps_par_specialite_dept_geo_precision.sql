-- V0.12.0 — `rpps_par_specialite_dept` retourne `geo_precision` (+1 colonne).
-- Mapping IDENTIQUE aux autres RPC RPPS V0.12.0 (ban_address → 'adresse',
-- finess_join → 'etablissement_finess', commune_centroid → 'centroide_commune').
-- Préserve EXECUTE format (custom plan par dept, post-mortem V0.5.4).
--
-- ⚠️ Signature RETURNS TABLE change (+1 colonne) → DROP+CREATE obligatoire
-- (42P13). Recopie VERBATIM de 20260510T030000 + ajout colonne.

DROP FUNCTION IF EXISTS rpps_par_specialite_dept(TEXT, TEXT, TEXT, TEXT, TEXT[], INT, INT);

CREATE OR REPLACE FUNCTION rpps_par_specialite_dept(
  p_departement        TEXT,
  p_profession_code    TEXT,
  p_savoir_faire_code  TEXT,
  p_mode_exercice_code TEXT,
  p_categorie_codes    TEXT[],
  p_limit              INT,
  p_offset             INT
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
  geo_precision            TEXT
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_categorie_codes TEXT[] := COALESCE(NULLIF(p_categorie_codes, ARRAY[]::TEXT[]), ARRAY['C', 'M']);
BEGIN
  IF p_departement IS NULL OR p_departement !~ '^(\d{2,3}|2A|2B)$' THEN
    RAISE EXCEPTION 'p_departement must match ^(\d{2,3}|2A|2B)$ (got: %)', p_departement
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY EXECUTE format($q$
    SELECT
      r.id, r.rpps_id, r.civilite, r.nom, r.prenom,
      r.profession_code, r.profession_libelle,
      r.savoir_faire_code, r.savoir_faire_libelle,
      r.mode_exercice_code, r.mode_exercice_libelle,
      r.categorie_code, r.categorie_libelle,
      r.num_finess, r.num_finess_ej, r.siret, r.raison_sociale,
      r.adresse, r.code_postal, r.ville,
      r.code_departement, r.code_insee, r.telephone,
      ST_AsGeoJSON(r.geom)::jsonb AS geom,
      CASE r.geom_source
        WHEN 'ban_address'      THEN 'adresse'
        WHEN 'finess_join'      THEN 'etablissement_finess'
        WHEN 'commune_centroid' THEN 'centroide_commune'
      END::text AS geo_precision
    FROM rpps r
    WHERE r.code_departement = %L::CHAR(3)
      AND ($1 IS NULL OR r.profession_code    = $1)
      AND ($2 IS NULL OR r.savoir_faire_code  = $2)
      AND ($3 IS NULL OR r.mode_exercice_code = $3)
      AND (r.categorie_code = ANY($4) OR r.categorie_code IS NULL)
    ORDER BY r.code_insee NULLS LAST, r.nom, r.prenom, r.id
    LIMIT $5 OFFSET $6
  $q$, p_departement)
  USING p_profession_code, p_savoir_faire_code, p_mode_exercice_code, v_categorie_codes, p_limit, p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION rpps_par_specialite_dept TO anon;

NOTIFY pgrst, 'reload schema';
