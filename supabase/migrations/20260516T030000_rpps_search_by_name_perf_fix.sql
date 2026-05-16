-- `rpps_search_by_name(nom)` SANS `departement` sur un nom commun
-- (DUPONT/MARTIN/BERNARD, top 100 FR) timeout SQLSTATE 57014.
--
-- Root cause (l'index GIN EST utilisé — ce n'est PAS un seq scan) :
--  1. La fonction n'avait AUCUN `SET statement_timeout` → elle hérite du
--     défaut bas du rôle `anon` (~3 s), alors que toutes les autres RPC
--     RPPS lourdes en portent un explicite (rpps_par_specialite_dept 15s,
--     count_rpps_by_commune 5s, rpps_in_radius 10min).
--  2. Le `LIMIT p_limit` était appliqué APRÈS `similarity()` + top-N
--     heapsort sur l'INTÉGRALITÉ du candidate set trigram. Sur un nom
--     commun, le GIN `%` (seuil 0.3) laisse passer des dizaines de
--     milliers de lignes sur 2,2 M → le LIMIT ne borne pas le travail
--     coûteux (calcul similarity par ligne + tri). Avec `departement`,
--     le prédicat réduit le set d'un facteur ~100 → <1 s.
--
-- Fix (pattern canonique du repo pour le piège O(lignes), cf. post-mortem
-- V0.10.2 `rpps_in_radius`) :
--  a. CTE `cand` qui applique le filtre GIN `%` + dept + catégorie et CAPE
--     le candidate set AVANT tout calcul de similarity/tri. `similarity()`
--     et le heapsort ne s'exécutent QUE sur ≤ v_candidate_cap lignes.
--  b. `SET statement_timeout = '10s'` explicite (homogénéité + ne plus
--     subir le défaut anon implicite).
--
-- Compromis assumé : sur un nom très commun sans dept, le cap renvoie un
-- échantillon de porteurs du nom (pas le top-similarity global) — cohérent
-- avec le contrat du tool ("recherche par identité, affiner avec
-- departement/prenom" + note metadata match_score). Le wrapper TS mappe en
-- complément un 57014 résiduel en message actionnable (-32602).

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS rpps_nom_trgm_idx
  ON rpps USING GIN (lower(nom) extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS rpps_prenom_trgm_idx
  ON rpps USING GIN (lower(prenom) extensions.gin_trgm_ops);

DROP FUNCTION IF EXISTS rpps_search_by_name(TEXT, TEXT, TEXT, INT);
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
  match_score              REAL
)
LANGUAGE plpgsql STABLE
SET statement_timeout = '10s'
AS $$
DECLARE
  v_nom    TEXT    := lower(trim(p_nom));
  v_prenom TEXT    := lower(trim(coalesce(p_prenom, '')));
  v_categorie_codes TEXT[] := COALESCE(NULLIF(p_categorie_codes, ARRAY[]::TEXT[]), ARRAY['C']);
  -- Borne du candidate set AVANT similarity/tri. Généreux (couvre largement
  -- les usages légitimes nom+dept ou nom+prenom) tout en bornant le pire cas
  -- nom-commun-seul. Au-delà, la recherche est intrinsèquement trop large :
  -- le contrat invite à préciser departement/prenom.
  v_candidate_cap CONSTANT INT := 2000;
BEGIN
  IF v_nom IS NULL OR v_nom = '' THEN
    RAISE EXCEPTION 'p_nom is required (non empty)' USING ERRCODE = '22023';
  END IF;
  IF p_departement IS NOT NULL AND p_departement !~ '^(\d{2,3}|2A|2B)$' THEN
    RAISE EXCEPTION 'p_departement must match ^(\d{2,3}|2A|2B)$ (got: %)', p_departement
      USING ERRCODE = '22023';
  END IF;

  -- Branche 1 : nom + prenom. La CTE `cand` cape le set trigram AVANT le
  -- calcul de score combiné + tri (le coût quadratique du diagnostic).
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
        extensions.similarity(lower(c.nom), v_nom)::REAL AS match_score
      FROM cand c
      ORDER BY match_score DESC, c.nom, c.prenom, c.id
      LIMIT p_limit;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION rpps_search_by_name TO anon;

NOTIFY pgrst, 'reload schema';
