-- V0.8 — RPC `count_finess(p_dept, p_categorie_codes[]) → BIGINT`.
--
-- Compte les établissements FINESS d'une catégorie (ou famille de catégories
-- agrégées via `FINESS_FAMILY_CODES` côté TS) dans un département donné.
-- Utilisé par `densiteEtablissementsSante` qui calcule la densité d'établis-
-- sements pour 100 000 habitants en croisant avec INSEE Melodi.
--
-- `p_dept` NULL → comptage France entière (cas `compare_national=true`).
--
-- `p_categorie_codes` : codes `categorie_code` à inclure (ex `['620']` pour
-- LBM, `['365','366']` pour pharmacies, `['225','226']` pour EHPAD…).
-- Tableau vide ou NULL → throw EXCEPTION : sans filtre catégorie, le résultat
-- n'a aucun sens (compter "tous les établissements de santé" mélange labos,
-- hôpitaux, pharmacies, EHPAD, centres de PMI…).
--
-- Pattern V0.5.4 (LANGUAGE plpgsql + EXECUTE format avec interpolation
-- literal) repris pour forcer un custom plan. Le COUNT est encore plus
-- pénalisant qu'un SELECT car il visite toutes les lignes matching.

DROP FUNCTION IF EXISTS count_finess(TEXT, TEXT[]);

CREATE OR REPLACE FUNCTION count_finess(
  p_dept             TEXT,
  p_categorie_codes  TEXT[]
) RETURNS BIGINT
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_count  BIGINT;
BEGIN
  IF p_categorie_codes IS NULL OR array_length(p_categorie_codes, 1) IS NULL THEN
    RAISE EXCEPTION 'p_categorie_codes must not be null or empty (a category filter is required to make sense of the count)'
      USING ERRCODE = '22023';
  END IF;

  IF p_dept IS NOT NULL AND p_dept !~ '^(\d{2,3}|2A|2B)$' THEN
    RAISE EXCEPTION 'p_dept must match ^(\d{2,3}|2A|2B)$ or be NULL (got: %)', p_dept
      USING ERRCODE = '22023';
  END IF;

  IF p_dept IS NULL THEN
    SELECT COUNT(*) INTO v_count
    FROM finess f
    WHERE f.categorie_code = ANY(p_categorie_codes);
    RETURN v_count;
  END IF;

  EXECUTE format($q$
    SELECT COUNT(*)
    FROM finess f
    WHERE f.code_departement = %L::CHAR(3)
      AND f.categorie_code = ANY($1)
  $q$, p_dept)
  INTO v_count
  USING p_categorie_codes;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION count_finess TO anon;

COMMENT ON FUNCTION count_finess IS
  'Compte les établissements FINESS matching la catégorie. p_dept NULL = France entière. Utilisé par densite_etablissements_sante (V0.8).';
