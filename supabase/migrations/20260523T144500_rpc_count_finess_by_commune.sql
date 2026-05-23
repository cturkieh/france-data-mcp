-- V0.20 — RPC `count_finess_by_commune(p_code_insee, p_categorie_codes[]) → BIGINT`.
--
-- Compte les établissements FINESS d'une famille (codes catégorie agrégés
-- via `FINESS_FAMILY_CODES` côté TS) dans une commune INSEE donnée. Brique
-- pour `densiteEtablissementsSante` au niveau commune (V0.20, jumeau du
-- `count_rpps_by_commune` V0.9).
--
-- Performance : la WHERE clause `code_insee = X AND categorie_code = ANY(...)`
-- est servie par l'index composite `finess_insee_categorie_idx ON finess
-- (code_insee, categorie_code)` (migration 20260508000019, déjà mirroré dans
-- `ingest_create_finess_staging` via 20260508000021 — parité prod↔staging OK,
-- pas de nouvelle dette d'index). Index-only scan possible.
-- Plan attendu : index scan composite <5 ms même sur communes denses.
-- Fallback `finess_code_insee_idx ON finess (code_insee)` (migration
-- 20260508000015) sert aussi si le planner préfère le simple index.
--
-- LIMITATIONS connues (à documenter côté tool MCP) :
--   1. Paris/Marseille/Lyon : les FINESS portent l'INSEE arrondissement
--      (75101-75120, 13201-13216, 69381-69389), pas la commune-mère 75056.
--      `assertNotPlmCommune` côté lib (densite.ts) rejette les 2 cas avant
--      cette RPC pour cohérence avec `densiteProfessionnelsSante` (V0.9).
--   2. Communes sans FINESS de la famille : retourne 0. Pas une erreur — le
--      caller distingue via la sentinelle table vide (`P0002`).
--
-- Garde-fous (alignés count_rpps_by_commune V0.9) :
--   - Validation regex code_insee (métropole 5 chiffres, Corse 2A/2B + 3 chiffres,
--     DOM 5 chiffres).
--   - Garde-fou table FINESS vide via `EXISTS (SELECT 1 FROM finess LIMIT 1)` :
--     un swap ingest cassé qui daterait FINESS vide retournerait 0 sinon →
--     densité=0 → "désert établissements" faux positif. Lessons learned V0.8.1.
--     `EXISTS` plutôt que `pg_class.reltuples` (estimation stale après swap).
--   - `EXECUTE format` avec literal interpolation : custom plan PostgREST,
--     pattern V0.5.4 / count_finess actuel.
--
-- statement_timeout généreux (5s) — même seq scan ~50ms reste sous le cap.

DROP FUNCTION IF EXISTS count_finess_by_commune(TEXT, TEXT[]);

CREATE OR REPLACE FUNCTION count_finess_by_commune(
  p_code_insee       TEXT,
  p_categorie_codes  TEXT[]
) RETURNS BIGINT
LANGUAGE plpgsql STABLE
SET statement_timeout = '5s'
AS $$
DECLARE
  v_has_rows  BOOLEAN;
  v_count     BIGINT;
BEGIN
  -- Validation regex code_insee : 5 chars exact, refuse les codes département
  -- 2-3 chiffres pour forcer l'usage de count_finess(p_dept, ...) ailleurs.
  IF p_code_insee IS NULL THEN
    RAISE EXCEPTION 'p_code_insee is required (use count_finess for département-level)'
      USING ERRCODE = '22023';
  END IF;
  IF p_code_insee !~ '^([0-9]{2}|2[AB])[0-9]{3}$' THEN
    RAISE EXCEPTION 'p_code_insee must match ^([0-9]{2}|2[AB])[0-9]{3}$ (got: %)', p_code_insee
      USING ERRCODE = '22023';
  END IF;

  -- Validation catégorie : sans filtre, mélanger labos+hôpitaux+EHPAD n'a aucun
  -- sens. Cohérent avec count_finess (V0.8).
  IF p_categorie_codes IS NULL OR array_length(p_categorie_codes, 1) IS NULL THEN
    RAISE EXCEPTION 'p_categorie_codes must not be null or empty (a category filter is required to make sense of the count)'
      USING ERRCODE = '22023';
  END IF;

  -- Garde-fou table finess vide (jumeau count_rpps_by_commune V0.9). Sans ce
  -- check, un ingest cassé qui swap une table vide retournerait 0 silencieusement.
  -- `EXISTS (... LIMIT 1)` exact + <1 ms via heap scan (jamais d'index spécial requis).
  SELECT EXISTS (SELECT 1 FROM finess LIMIT 1) INTO v_has_rows;
  IF NOT v_has_rows THEN
    RAISE EXCEPTION 'finess table is empty — likely a failed ingest swap. Refusing to return 0 silently.'
      USING ERRCODE = 'P0002';
  END IF;

  -- EXECUTE format pour custom plan (V0.5.4 pattern, miroir count_rpps_by_commune
  -- + count_finess). L'interpolation literal du code_insee évite la cascade
  -- générique json_to_record + parsing wide planning.
  EXECUTE format($q$
    SELECT COUNT(*)
    FROM finess f
    WHERE f.code_insee = %L::CHAR(5)
      AND f.categorie_code = ANY($1)
  $q$, p_code_insee)
  INTO v_count
  USING p_categorie_codes;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION count_finess_by_commune TO anon;

COMMENT ON FUNCTION count_finess_by_commune IS
  'V0.20 — Compte les établissements FINESS d''une catégorie dans une commune INSEE. Brique pour densite_etablissements_sante au niveau commune. Paris/Marseille/Lyon : FINESS portent insee arrondissement (75101-75120 etc.), pas 75056. Garde-fou table vide P0002.';
