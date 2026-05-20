-- V0.12.0 — `rpps_lookup_by_id` retourne `geo_precision` (+1 colonne).
-- Mapping IDENTIQUE aux autres RPC RPPS V0.12.0 (ban_address → 'adresse',
-- finess_join → 'etablissement_finess', commune_centroid → 'centroide_commune').
-- Un PS multi-sites a 1 ligne par site, donc 1 `geo_precision` par site
-- (un site finess_join et un site commune_centroid peuvent coexister pour
-- un même rpps_id — la précision est PAR SITE, pas globale).
--
-- ⚠️ Signature RETURNS TABLE change (+1 colonne) → DROP+CREATE obligatoire
-- (42P13). Recopie VERBATIM de 20260509T200000 + ajout colonne `geo_precision`
-- TEXT à la fin du RETURNS TABLE et du SELECT.

DROP FUNCTION IF EXISTS rpps_lookup_by_id(TEXT);

CREATE OR REPLACE FUNCTION rpps_lookup_by_id(p_rpps_id TEXT)
RETURNS TABLE (
  id                       BIGINT,
  rpps_id                  TEXT,
  identifiant_pp           TEXT,
  civilite                 TEXT,
  nom                      TEXT,
  prenom                   TEXT,
  profession_code          TEXT,
  profession_libelle       TEXT,
  categorie_code           TEXT,
  categorie_libelle        TEXT,
  savoir_faire_code        TEXT,
  savoir_faire_libelle     TEXT,
  mode_exercice_code       TEXT,
  mode_exercice_libelle    TEXT,
  num_finess               TEXT,
  num_finess_ej            TEXT,
  siret                    TEXT,
  siren                    TEXT,
  raison_sociale           TEXT,
  adresse                  TEXT,
  code_postal              CHAR(5),
  ville                    TEXT,
  code_departement         CHAR(3),
  code_insee               CHAR(5),
  telephone                TEXT,
  email                    TEXT,
  geom                     JSONB,
  geo_precision            TEXT
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id, r.rpps_id, r.identifiant_pp, r.civilite, r.nom, r.prenom,
    r.profession_code, r.profession_libelle,
    r.categorie_code, r.categorie_libelle,
    r.savoir_faire_code, r.savoir_faire_libelle,
    r.mode_exercice_code, r.mode_exercice_libelle,
    r.num_finess, r.num_finess_ej, r.siret, r.siren,
    r.raison_sociale, r.adresse, r.code_postal, r.ville,
    r.code_departement, r.code_insee, r.telephone, r.email,
    ST_AsGeoJSON(r.geom)::jsonb AS geom,
    CASE r.geom_source
      WHEN 'ban_address'      THEN 'adresse'
      WHEN 'finess_join'      THEN 'etablissement_finess'
      WHEN 'commune_centroid' THEN 'centroide_commune'
    END::text AS geo_precision
  FROM rpps r
  WHERE r.rpps_id = p_rpps_id
  ORDER BY r.id;
END;
$$;

GRANT EXECUTE ON FUNCTION rpps_lookup_by_id(TEXT) TO anon;

NOTIFY pgrst, 'reload schema';
