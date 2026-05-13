-- V0.8 — RPC `count_rpps(p_dept, p_profession_code, p_savoir_faire_code,
-- p_mode_exercice_codes[], p_categorie_codes[]) → BIGINT`.
--
-- Compte les PS RPPS qui matchent les filtres. Utilisé par la fonction
-- cross-source `densite_professionnels_sante` qui calcule la densité PS pour
-- 100 000 hab. en croisant avec INSEE Melodi (DS_POPULATIONS_REFERENCE).
--
-- `p_dept` NULL → comptage France entière (tous départements). Sinon : filtre
-- exact sur `code_departement` (CHAR(3) interpolé via EXECUTE format pour
-- forcer un custom plan, cf. lessons learned V0.5.4).
--
-- `p_mode_exercice_codes` est un TEXT[] pour permettre la méthodo DREES qui
-- agrège libéral+salarié+mixte (codes ANS '1','2','3'). NULL ou [] → pas de
-- filtre mode_exercice.
--
-- `p_categorie_codes` default `[C, M]` (Civil + Militaire actifs, hors
-- étudiants E) si NULL ou []. Cohérent avec rpps_par_specialite_dept V0.5.4.
--
-- Pourquoi LANGUAGE plpgsql + EXECUTE format au lieu d'une query SQL inline :
-- même problème que rpps_par_specialite_dept (cf. migration V0.5.4) — sans
-- custom plan, COUNT(*) sur dept dense (75/13) avec filtre profession peut
-- déclencher seq scan au lieu d'index scan composite. Le COUNT est encore
-- plus pénalisant qu'un SELECT car il visite toutes les lignes matching.

DROP FUNCTION IF EXISTS count_rpps(TEXT, TEXT, TEXT, TEXT[], TEXT[]);

CREATE OR REPLACE FUNCTION count_rpps(
  p_dept                  TEXT,
  p_profession_code       TEXT,
  p_savoir_faire_code     TEXT,
  p_mode_exercice_codes   TEXT[],
  p_categorie_codes       TEXT[]
) RETURNS BIGINT
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  -- Pattern aligné sur count_finess : `array_length(x, 1) IS NULL` est plus
  -- idiomatique Postgres que `NULLIF(x, ARRAY[]::TEXT[])` (pas de dépendance
  -- au cast type, gère NULL et tableau vide d'une seule expression).
  --
  -- IMPORTANT (sémantique caller) : NULL et `[]` sont délibérément confondus —
  -- le caller TS (densite.ts buildCountInput) envoie `[]` quand `categorieCodes`
  -- n'est pas spécifié, et veut alors recevoir le default DREES `[C, M]`. Si un
  -- caller MCP passe explicitement `categorie_codes: []` voulant désactiver le
  -- filtre (= "tous statuts confondus, étudiants inclus"), il obtiendra le
  -- default DREES à la place — il doit alors lister explicitement les codes
  -- voulus (ex `['C','M','E']`). Idem pour `mode_exercice_codes`.
  v_categorie_codes  TEXT[] := CASE
    WHEN p_categorie_codes IS NULL OR array_length(p_categorie_codes, 1) IS NULL THEN ARRAY['C', 'M']
    ELSE p_categorie_codes
  END;
  v_mode_codes       TEXT[] := CASE
    WHEN p_mode_exercice_codes IS NULL OR array_length(p_mode_exercice_codes, 1) IS NULL THEN NULL
    ELSE p_mode_exercice_codes
  END;
  v_count            BIGINT;
BEGIN
  -- Validation du dept identique à rpps_par_specialite_dept (couvre métropole
  -- 2 chiffres, DOM/COM 3 chiffres, Corse 2A/2B). NULL accepté = comptage
  -- France entière.
  IF p_dept IS NOT NULL AND p_dept !~ '^(\d{2,3}|2A|2B)$' THEN
    RAISE EXCEPTION 'p_dept must match ^(\d{2,3}|2A|2B)$ or be NULL (got: %)', p_dept
      USING ERRCODE = '22023';
  END IF;

  IF p_dept IS NULL THEN
    -- France entière : pas d'EXECUTE format (rien à interpoler), query SQL
    -- directe via SELECT INTO avec variables plpgsql nommées (les $N ne sont
    -- valides qu'à l'intérieur d'un EXECUTE USING).
    SELECT COUNT(*) INTO v_count
    FROM rpps r
    WHERE (p_profession_code   IS NULL OR r.profession_code      = p_profession_code)
      AND (p_savoir_faire_code IS NULL OR r.savoir_faire_code    = p_savoir_faire_code)
      AND (v_mode_codes        IS NULL OR r.mode_exercice_code = ANY(v_mode_codes))
      AND (r.categorie_code = ANY(v_categorie_codes) OR r.categorie_code IS NULL);
    RETURN v_count;
  END IF;

  -- Dept précis : EXECUTE format pour custom plan via interpolation literal.
  EXECUTE format($q$
    SELECT COUNT(*)
    FROM rpps r
    WHERE r.code_departement = %L::CHAR(3)
      AND ($1 IS NULL OR r.profession_code      = $1)
      AND ($2 IS NULL OR r.savoir_faire_code    = $2)
      AND ($3 IS NULL OR r.mode_exercice_code = ANY($3))
      AND (r.categorie_code = ANY($4) OR r.categorie_code IS NULL)
  $q$, p_dept)
  INTO v_count
  USING p_profession_code, p_savoir_faire_code, v_mode_codes, v_categorie_codes;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION count_rpps TO anon;

COMMENT ON FUNCTION count_rpps IS
  'Compte les PS RPPS matching les filtres. p_dept NULL = France entière. Utilisé par densite_professionnels_sante (V0.8).';
