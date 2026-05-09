-- V0.5.1 hotfix perf — `rpps_par_specialite_dept` timeout 57014 sur dept 08
-- (5K rows uniquement). Trois facteurs cumulés diagnostiqués au smoke test :
--
--   1. Mismatch type CHAR(3) vs TEXT param → `(code_departement)::text = $1`
--      casse l'usage de l'index B-tree → seq scan complet (2,2 M rows).
--      Fix : variable locale typée `v_dept CHAR(3) := p_departement::CHAR(3)`.
--
--   2. Helper `rpps_categorie_match(code, $codes)` empêchait l'évaluation au
--      planning (`cardinality($codes) = 0` est runtime). Le planner
--      pessimiste gardait un plan generic. Fix : 2 branches plpgsql, chacune
--      avec un filtre catégorie inliné comme literal — le planner peut alors
--      utiliser rpps_dept_categorie_idx via Bitmap Index Scan.
--
--   3. Le ORDER BY sur `code_insee` (1ère colonne) faisait choisir au planner
--      l'index `rpps_insee_idx` via Presorted Key, qui filtre 78 K rows en
--      streaming. La query inline réécrite avec dept-bitmap-scan + top-N
--      heapsort revient à 19-25 ms. Mais en plpgsql, le plan generic reste
--      ~5-8 s même avec les fixes 1 et 2 — le `force_custom_plan` ne suffit
--      pas. Mitigation pragmatique : étendre le statement_timeout à 15 s sur
--      cette RPC (scope local) pour débloquer le caller anon (3 s default).
--      Tuning fin au backlog : matérialiser un MV par dept ou réécrire en
--      SQL function avec `SECURITY INVOKER` + JIT exec_plan_cache off.

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
  geom                     JSONB
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_dept CHAR(3) := p_departement::CHAR(3);
BEGIN
  IF cardinality(p_categorie_codes) = 0 THEN
    RETURN QUERY
    SELECT
      r.id, r.rpps_id, r.civilite, r.nom, r.prenom,
      r.profession_code, r.profession_libelle,
      r.savoir_faire_code, r.savoir_faire_libelle,
      r.mode_exercice_code, r.mode_exercice_libelle,
      r.categorie_code, r.categorie_libelle,
      r.num_finess, r.num_finess_ej, r.siret, r.raison_sociale,
      r.adresse, r.code_postal, r.ville,
      r.code_departement, r.code_insee, r.telephone,
      ST_AsGeoJSON(r.geom)::jsonb AS geom
    FROM rpps r
    WHERE r.code_departement = v_dept
      AND (p_profession_code    IS NULL OR r.profession_code    = p_profession_code)
      AND (p_savoir_faire_code  IS NULL OR r.savoir_faire_code  = p_savoir_faire_code)
      AND (p_mode_exercice_code IS NULL OR r.mode_exercice_code = p_mode_exercice_code)
      AND (r.categorie_code IN ('C', 'M') OR r.categorie_code IS NULL)
    ORDER BY r.code_insee NULLS LAST, r.nom, r.prenom, r.id
    LIMIT p_limit
    OFFSET p_offset;
  ELSE
    RETURN QUERY
    SELECT
      r.id, r.rpps_id, r.civilite, r.nom, r.prenom,
      r.profession_code, r.profession_libelle,
      r.savoir_faire_code, r.savoir_faire_libelle,
      r.mode_exercice_code, r.mode_exercice_libelle,
      r.categorie_code, r.categorie_libelle,
      r.num_finess, r.num_finess_ej, r.siret, r.raison_sociale,
      r.adresse, r.code_postal, r.ville,
      r.code_departement, r.code_insee, r.telephone,
      ST_AsGeoJSON(r.geom)::jsonb AS geom
    FROM rpps r
    WHERE r.code_departement = v_dept
      AND (p_profession_code    IS NULL OR r.profession_code    = p_profession_code)
      AND (p_savoir_faire_code  IS NULL OR r.savoir_faire_code  = p_savoir_faire_code)
      AND (p_mode_exercice_code IS NULL OR r.mode_exercice_code = p_mode_exercice_code)
      AND (r.categorie_code = ANY(p_categorie_codes) OR r.categorie_code IS NULL)
    ORDER BY r.code_insee NULLS LAST, r.nom, r.prenom, r.id
    LIMIT p_limit
    OFFSET p_offset;
  END IF;
END;
$$;

ALTER FUNCTION rpps_par_specialite_dept(TEXT, TEXT, TEXT, TEXT, TEXT[], INT, INT)
  SET statement_timeout = '15s';

GRANT EXECUTE ON FUNCTION rpps_par_specialite_dept TO anon;

NOTIFY pgrst, 'reload schema';
