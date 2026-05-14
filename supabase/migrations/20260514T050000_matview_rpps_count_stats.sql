-- V0.8.3 — Materialized view pré-agrégée pour `count_rpps`.
--
-- Diagnostic (Sentry FRANCE-DATA-MCP-4, smoke test prod V0.8.2) :
--   `densite_professionnels_sante({code_dept:"75", profession_code:"10",
--   compare_national:true})` déclenche `count_rpps(p_dept=NULL,
--   profession_code='10', mode_exercice IN ('L','S','M'), categorie IN
--   ('C','M'))`. COUNT(*) France entière sur ~500 K médecins avec heap visit
--   pour filtrer mode + categorie → ~22 s, statement_timeout anon (3 s)
--   cancel 57014. Smoke test reproductible (<5 s avant timeout).
--
-- V0.8.0 (RPC count_rpps initial) avait anticipé ça via EXECUTE format pour
-- forcer un custom plan côté dept précis, mais la branche France entière
-- (p_dept IS NULL) reste un seq scan + filtres : pas viable.
--
-- Solution : matview `rpps_count_stats` pré-agrégée par
-- (code_departement, profession_code, savoir_faire_code, mode_exercice_code,
-- categorie_code) → COUNT(*). Estimation ~50-100 K rows après GROUP BY
-- (combinaisons non vides seulement). Lookup index <50 ms quel que soit le
-- pattern de filtre (dept précis, France entière, n'importe quel combo).
--
-- Cf. CHANGELOG [0.8.3] pour le trade-off REFRESH manuel et le TODO V0.8.4
-- d'intégration post-ingest.
--
-- UNIQUE INDEX avec `NULLS NOT DISTINCT` (Postgres 15+) requis pour REFRESH
-- CONCURRENTLY : sans ça, plusieurs rows avec NULL dans une colonne seraient
-- considérées comme distinctes par l'index UNIQUE classique, alors que le
-- GROUP BY les a fusionnées en une seule (sémantique GROUP BY = NULL=NULL).

DROP FUNCTION IF EXISTS count_rpps(TEXT, TEXT, TEXT, TEXT[], TEXT[]);

CREATE MATERIALIZED VIEW IF NOT EXISTS rpps_count_stats AS
SELECT
  r.code_departement,
  r.profession_code,
  r.savoir_faire_code,
  r.mode_exercice_code,
  r.categorie_code,
  COUNT(*)::BIGINT AS count_ps
FROM rpps r
GROUP BY
  r.code_departement,
  r.profession_code,
  r.savoir_faire_code,
  r.mode_exercice_code,
  r.categorie_code;

-- UNIQUE pour REFRESH CONCURRENTLY future. NULLS NOT DISTINCT (PG15+) traite
-- NULL = NULL comme GROUP BY, cohérent avec la sémantique de la matview.
-- Préfixe (profession_code) couvre déjà le pattern de filtre le plus commun
-- (~50-100 K rows total → index scan <50 ms même sans index secondaire dédié).
CREATE UNIQUE INDEX IF NOT EXISTS rpps_count_stats_pk
  ON rpps_count_stats (
    profession_code,
    savoir_faire_code,
    mode_exercice_code,
    categorie_code,
    code_departement
  ) NULLS NOT DISTINCT;

GRANT SELECT ON rpps_count_stats TO anon;

COMMENT ON MATERIALIZED VIEW rpps_count_stats IS
  'V0.8.3 — pré-agrégation count RPPS par (dept, profession, savoir_faire, mode_exercice, categorie). REFRESH après chaque ingest RPPS.';

-- RPC réécrite : interroge la matview au lieu de scan rpps. Sémantique
-- strictement identique à V0.8.0 (defaults DREES, gestion NULL, validation
-- regex dept). Tests existants comptant doivent rester verts.
CREATE OR REPLACE FUNCTION count_rpps(
  p_dept                  TEXT,
  p_profession_code       TEXT,
  p_savoir_faire_code     TEXT,
  p_mode_exercice_codes   TEXT[],
  p_categorie_codes       TEXT[]
) RETURNS BIGINT
LANGUAGE plpgsql STABLE
-- Fail-fast si la matview drift en cardinalité (drop d'index, query non
-- planifiée comme attendu) : query cible <50 ms sur ~50-100 K rows, 2 s
-- laisse une marge x40. La clause `SET` (vs `SET LOCAL` dans le BEGIN) est
-- scopée à l'invocation : push à l'entrée, pop au retour, indépendamment du
-- contexte transactionnel du caller. Au-delà → erreur SQLSTATE 57014
-- capturée par Sentry, signal observable au lieu de dégrader silencieusement
-- vers le timeout anon par défaut (3 s).
SET statement_timeout = '2s'
AS $$
DECLARE
  -- Sémantique identique à V0.8.0 : NULL et [] confondus → default DREES.
  -- Cf. commentaire V0.8.0 pour la justification (caller TS densite.ts
  -- envoie [] quand non spécifié et attend le default).
  v_categorie_codes  TEXT[] := CASE
    WHEN p_categorie_codes IS NULL OR array_length(p_categorie_codes, 1) IS NULL THEN ARRAY['C', 'M']
    ELSE p_categorie_codes
  END;
  v_mode_codes       TEXT[] := CASE
    WHEN p_mode_exercice_codes IS NULL OR array_length(p_mode_exercice_codes, 1) IS NULL THEN NULL
    ELSE p_mode_exercice_codes
  END;
  v_matview_total    BIGINT;
  v_count            BIGINT;
BEGIN
  -- Validation dept : couvre métropole 2 chiffres, DOM/COM 3 chiffres, Corse 2A/2B.
  IF p_dept IS NOT NULL AND p_dept !~ '^(\d{2,3}|2A|2B)$' THEN
    RAISE EXCEPTION 'p_dept must match ^(\d{2,3}|2A|2B)$ or be NULL (got: %)', p_dept
      USING ERRCODE = '22023';
  END IF;

  -- Garde-fou matview vide : si la matview n'a aucune row (REFRESH WITH NO
  -- DATA, GRANT SELECT cassé, rollback ingest partiel), `COALESCE(SUM, 0)`
  -- retournerait silencieusement 0 → `densiteProfessionnelsSante` calculerait
  -- densité 0/100k habitants sans signal d'incident. C'est exactement le
  -- pattern qui a déclenché V0.8.1 (mode_exercice 1/2/3 vs L/S/M → 0
  -- silencieux toute la France). Sentinelle <1 ms (PK index lookup).
  SELECT COUNT(*) INTO v_matview_total FROM rpps_count_stats;
  IF v_matview_total = 0 THEN
    RAISE EXCEPTION 'rpps_count_stats matview is empty (cardinality 0). Refusing to return 0 silently — run REFRESH MATERIALIZED VIEW rpps_count_stats.'
      USING ERRCODE = 'P0002';  -- no_data_found
  END IF;

  -- Plus besoin d'EXECUTE format / custom plan : la matview est petite
  -- (~50-100 K rows), n'importe quel index scan termine en <50 ms.
  SELECT COALESCE(SUM(s.count_ps), 0)::BIGINT INTO v_count
  FROM rpps_count_stats s
  WHERE (p_dept              IS NULL OR s.code_departement   = p_dept)
    AND (p_profession_code   IS NULL OR s.profession_code    = p_profession_code)
    AND (p_savoir_faire_code IS NULL OR s.savoir_faire_code  = p_savoir_faire_code)
    AND (v_mode_codes        IS NULL OR s.mode_exercice_code = ANY(v_mode_codes))
    AND (s.categorie_code = ANY(v_categorie_codes) OR s.categorie_code IS NULL);

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION count_rpps TO anon;

COMMENT ON FUNCTION count_rpps IS
  'V0.8.3 — interroge la matview rpps_count_stats (perf <50 ms vs ~22 s en V0.8.0/V0.8.2 sur France entière). Sémantique identique à V0.8.0.';

-- Pas de REFRESH explicite après CREATE : `CREATE MATERIALIZED VIEW … AS
-- SELECT` (WITH DATA est le default Postgres) peuple déjà la matview au CREATE.
-- Ajouter un REFRESH inconditionnel ici doublerait le coût au 1er run (~30 s)
-- ET surtout poserait un AccessExclusiveLock bloquant les lecteurs anon au
-- replay (CI retry, env rebuild, `CREATE … IF NOT EXISTS` no-op mais REFRESH
-- relance le rebuild). Le REFRESH récurrent post-ingest RPPS mensuel se fait
-- ailleurs (TODO V0.8.4 : intégration `scripts/ingest/rpps.ts` post-swap).
--
-- Note : V0.8.2 (matview rpps_savoir_faire_stats) fait un REFRESH inconditionnel
-- final — gaspillage négligeable (~250 rows) mais même risque rejeu. À backporter
-- au prochain cleanup de cette migration si besoin.
