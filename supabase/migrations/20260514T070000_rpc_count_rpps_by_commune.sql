-- V0.9 — RPC `count_rpps_by_commune(p_code_insee, p_profession_code,
-- p_savoir_faire_code, p_mode_exercice_codes[], p_categorie_codes[]) → BIGINT`.
--
-- Compte les PS RPPS dans une commune INSEE. Brique pour
-- `densite_professionnels_sante` au niveau commune (V0.9).
--
-- Performance : `rpps_insee_idx ON rpps(code_insee)` déjà présent. Les communes
-- denses (Paris arrondissements 75108=Paris 8e ~700 PS médecins, Lille 59350
-- ~3K PS) sont indexées efficacement. Pas de matview à ce stade : la cardinalité
-- par commune × profession × filtre est faible (<10K rows scan typique), un
-- index scan composite reste en <100 ms même sur les communes les plus denses.
--
-- LIMITATIONS connues (à documenter côté tool MCP) :
--   1. Le `code_insee` stocké dans `rpps` provient soit du match commune
--      (CP + libellé) soit de l'enrichissement FINESS. Pour Paris, les rows
--      portent l'insee de l'arrondissement (75101-75120), PAS 75056. Pour
--      Marseille / Lyon idem. Le caller qui veut Paris entier doit utiliser
--      `densite_professionnels_sante` au niveau département (75).
--   2. Communes sans PS résidant : retourne 0. Ce n'est pas une erreur — le
--      caller distingue via la sentinelle matview vide (`count_rpps` P0002).
--
-- Validation regex : couvre métropole 5 chiffres, Corse 2A/2B + 3 chiffres,
-- DOM 5 chiffres (971xx-978xx).

DROP FUNCTION IF EXISTS count_rpps_by_commune(TEXT, TEXT, TEXT, TEXT[], TEXT[]);

CREATE OR REPLACE FUNCTION count_rpps_by_commune(
  p_code_insee            TEXT,
  p_profession_code       TEXT,
  p_savoir_faire_code     TEXT,
  p_mode_exercice_codes   TEXT[],
  p_categorie_codes       TEXT[]
) RETURNS BIGINT
LANGUAGE plpgsql STABLE
-- statement_timeout généreux côté anon par défaut (3 s) — les communes très
-- denses (Paris arrondissements) restent sous 500 ms en index scan, mais on
-- accepte jusqu'à 5 s avant cancel observable.
SET statement_timeout = '5s'
AS $$
DECLARE
  -- Sémantique identique à `count_rpps` (V0.8) : NULL et `[]` confondus →
  -- default DREES. Le caller TS densite.ts envoie `[]` quand non spécifié.
  v_categorie_codes  TEXT[] := CASE
    WHEN p_categorie_codes IS NULL OR array_length(p_categorie_codes, 1) IS NULL THEN ARRAY['C', 'M']
    ELSE p_categorie_codes
  END;
  v_mode_codes       TEXT[] := CASE
    WHEN p_mode_exercice_codes IS NULL OR array_length(p_mode_exercice_codes, 1) IS NULL THEN NULL
    ELSE p_mode_exercice_codes
  END;
  v_has_rows         BOOLEAN;
  v_count            BIGINT;
BEGIN
  -- Validation code_insee : 5 chars exact. Métropole 5 chiffres OU Corse
  -- (2A/2B + 3 chiffres) OU DOM (971xx-978xx). Refuse les codes département
  -- 2-3 chiffres pour forcer l'usage du niveau dept ailleurs.
  IF p_code_insee IS NULL THEN
    RAISE EXCEPTION 'p_code_insee is required (use count_rpps for département-level)'
      USING ERRCODE = '22023';
  END IF;
  IF p_code_insee !~ '^([0-9]{2}|2[AB])[0-9]{3}$' THEN
    RAISE EXCEPTION 'p_code_insee must match ^([0-9]{2}|2[AB])[0-9]{3}$ (got: %)', p_code_insee
      USING ERRCODE = '22023';
  END IF;

  -- Garde-fou table rpps vide (V0.9 — équivalent sentinelle P0002 de count_rpps).
  -- Sans ce check, un ingest cassé qui swap une table vide retournerait 0 PS
  -- silencieusement → densité=0 → "désert médical" faux positif. Cf. lessons
  -- learned V0.8.1 (mode_exercice 1/2/3 vs L/S/M).
  --
  -- IMPLEMENTATION : `EXISTS (SELECT 1 FROM rpps LIMIT 1)` au lieu de
  -- `pg_class.reltuples` (chopped en /review V0.9 Passe 2). `reltuples` est
  -- une estimation maintenue par ANALYZE/autovacuum — stale après un
  -- ALTER TABLE RENAME (swap atomique) tant que l'autovacuum n'est pas
  -- repassé. EXISTS scan 1 row via index, exact, <1 ms.
  SELECT EXISTS (SELECT 1 FROM rpps LIMIT 1) INTO v_has_rows;
  IF NOT v_has_rows THEN
    RAISE EXCEPTION 'rpps table is empty — likely a failed ingest swap. Refusing to return 0 silently.'
      USING ERRCODE = 'P0002';
  END IF;

  -- EXECUTE format pour custom plan : sans ça, PostgREST wrappe l'appel dans
  -- json_to_record LATERAL et le planner choisit un plan generic basé sur la
  -- sélectivité moyenne (n_distinct). Sur une commune dense (Paris 8e), ça
  -- bascule en seq scan + filter au lieu d'index scan composite.
  -- Cf. lessons learned V0.5.4 (rpps_par_specialite_dept).
  EXECUTE format($q$
    SELECT COUNT(*)
    FROM rpps r
    WHERE r.code_insee = %L::CHAR(5)
      AND ($1 IS NULL OR r.profession_code      = $1)
      AND ($2 IS NULL OR r.savoir_faire_code    = $2)
      AND ($3 IS NULL OR r.mode_exercice_code = ANY($3))
      AND (r.categorie_code = ANY($4) OR r.categorie_code IS NULL)
  $q$, p_code_insee)
  INTO v_count
  USING p_profession_code, p_savoir_faire_code, v_mode_codes, v_categorie_codes;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION count_rpps_by_commune TO anon;

COMMENT ON FUNCTION count_rpps_by_commune IS
  'V0.9 — Compte les PS RPPS dans une commune INSEE. Brique pour densite_professionnels_sante au niveau commune. Paris/Marseille/Lyon : rows portent insee arrondissement (75101-75120 etc.), pas 75056.';
