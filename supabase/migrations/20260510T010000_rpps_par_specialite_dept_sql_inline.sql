-- V0.5.2 — `rpps_par_specialite_dept` réécrite en `LANGUAGE sql STABLE`.
--
-- Le hotfix V0.5.1 (mig 20260510T000000) avait mitigé le timeout via
-- `statement_timeout = '15s'` mais le smoke test live post-deploy a montré
-- que dept 75 et 13 dépassent même les 15s. Root cause : `LANGUAGE plpgsql
-- STABLE` empêche l'inlining et bascule sur un plan generic après 5 appels
-- (default PG ≥ 12), qui choisit `rpps_insee_idx` (presorted key) et
-- stream-filter ~120K rows au lieu d'un bitmap scan sur
-- `rpps_dept_categorie_idx`.
--
-- Fix : `LANGUAGE sql STABLE` permet au planner d'inliner la fonction comme
-- une vue. Plan re-calculé à chaque appel avec les vrais params → bitmap
-- index scan + top-N heapsort → 25-50 ms sur dept dense (vs timeout 15s).
--
-- ⚠️ Pas de clause `SET search_path` : Postgres bloque l'inlining d'une SRF
-- dès que `proconfig IS NOT NULL` (cf. `inline_set_returning_function` dans
-- `optimizer/util/clauses.c`). PostGIS est installé dans `public` (cf
-- `pg_extension` au moment du diagnostic), donc le default `search_path`
-- couvre `ST_AsGeoJSON` sans qualification.
--
-- Pré-requis caller : `p_categorie_codes` doit être non-vide. Le default
-- "actifs" (codes 'C','M') est désormais résolu côté TS dans `rpps-db.ts`
-- (pattern explicite — plus de magie SQL `cardinality = 0 → IN ('C','M')`).
-- Effet de bord : un caller PostgREST direct passant `[]` recevra 0 rows
-- au lieu des actifs implicites. Comportement conforme à la sémantique
-- "ANY(empty array) = false" de Postgres.

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
LANGUAGE sql STABLE
AS $$
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
  WHERE r.code_departement = p_departement::CHAR(3)
    AND (p_profession_code    IS NULL OR r.profession_code    = p_profession_code)
    AND (p_savoir_faire_code  IS NULL OR r.savoir_faire_code  = p_savoir_faire_code)
    AND (p_mode_exercice_code IS NULL OR r.mode_exercice_code = p_mode_exercice_code)
    AND (r.categorie_code = ANY(p_categorie_codes) OR r.categorie_code IS NULL)
  ORDER BY r.code_insee NULLS LAST, r.nom, r.prenom, r.id
  LIMIT p_limit
  OFFSET p_offset;
$$;

-- Le statement_timeout custom de la V0.5.1 devient inutile (la fonction inline
-- répond en < 100 ms même sur dept dense). Reset au default Supabase 60s.
ALTER FUNCTION rpps_par_specialite_dept(TEXT, TEXT, TEXT, TEXT, TEXT[], INT, INT)
  RESET statement_timeout;

GRANT EXECUTE ON FUNCTION rpps_par_specialite_dept TO anon;

NOTIFY pgrst, 'reload schema';
