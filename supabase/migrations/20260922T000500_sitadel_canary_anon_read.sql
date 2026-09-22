-- Canary Sit@del : prouver AUSSI que la lecture anon a survécu au swap.
--
-- `check_ingest_canary` est SECURITY INVOKER et le cron l'appelle sous
-- `service_role` (BYPASSRLS) : il voit les lignes quoi qu'il arrive côté `anon`,
-- seul chemin du tool. Scénario fermé : une migration future recrée
-- `ingest_create_sitadel_logements_staging` en oubliant la policy anon → le swap
-- promeut une table illisible → `anon` reçoit `[]` sans erreur → permis
-- « indisponibles » partout, run `success`, canary vert, `data_freshness` fraîche.
-- Désormais : `anon_read_perdue` dans `canary_failures` → run `partial` → vigie.
--
-- Historique prod : appliquée en DEUX temps le 2026-09-22 (`sitadel_canary_anon_read`
-- puis `sitadel_canary_anon_read_array_append`). La 1re écrivait `missing || 'x'`
-- → 22P02 UNIQUEMENT dans la branche rouge, donc invisible tant que tout va bien.
-- Attrapé en rejouant la branche rouge (DROP POLICY dans un DO annulé par
-- RAISE) : sans policy → `{anon_read_perdue}` ; avec → `{}`. Ce fichier = l'état final.
--
-- Def COMPLÈTE recopiée VERBATIM de 20260921T230000 (toutes les branches) + le
-- bloc anon dans la branche `sitadel`.

CREATE OR REPLACE FUNCTION check_ingest_canary(p_source TEXT) RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  missing TEXT[];
BEGIN
  IF p_source = 'finess' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN finess f
      ON t.key_type = 'num_finess'
     AND f.num_finess = t.key_value
    WHERE t.source = 'finess'
      AND t.key_type = 'num_finess'
      AND f.num_finess IS NULL;

  ELSIF p_source = 'ameli_ps' THEN
    missing := NULL;

  ELSIF p_source = 'cds' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN centres_sante c
      ON t.key_type = 'etab_finess'
     AND c.etab_finess = t.key_value
    WHERE t.source = 'cds'
      AND t.key_type = 'etab_finess'
      AND c.etab_finess IS NULL;

  ELSIF p_source = 'rpps' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN rpps r
      ON t.key_type = 'rpps_id'
     AND r.rpps_id = t.key_value
    WHERE t.source = 'rpps'
      AND t.key_type = 'rpps_id'
      AND r.rpps_id IS NULL;

  ELSIF p_source = 'iris' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN iris i
      ON t.key_type = 'code_iris'
     AND i.code_iris = t.key_value
    WHERE t.source = 'iris'
      AND t.key_type = 'code_iris'
      AND i.code_iris IS NULL;

  ELSIF p_source = 'sitadel' THEN
    -- Pivot key_type 'code_insee' : la commune doit avoir ≥ 1 ligne.
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    WHERE t.source = 'sitadel'
      AND t.key_type = 'code_insee'
      AND NOT EXISTS (
        SELECT 1 FROM sitadel_logements s WHERE s.code_insee = t.key_value
      );

    -- Lecture ANON : le tool lit `sitadel_logements` sous `anon`. Table sans
    -- policy = default-deny = 200 OK avec `[]`, PAS une erreur → l'outil
    -- rendrait `indisponible:no_data` pour TOUTE la France, cron vert.
    IF NOT has_table_privilege('anon', 'public.sitadel_logements', 'SELECT')
       OR NOT EXISTS (
         SELECT 1 FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND p.tablename = 'sitadel_logements'
           AND p.cmd = 'SELECT'
           AND 'anon' = ANY (p.roles)
       ) THEN
      -- `array_append`, PAS `|| 'x'` : un littéral nu est lu comme un TABLEAU
      -- (22P02 « malformed array literal », prouvé en rejouant la branche rouge).
      missing := array_append(COALESCE(missing, ARRAY[]::TEXT[]), 'anon_read_perdue');
    END IF;

  ELSE
    RAISE EXCEPTION 'check_ingest_canary: unknown source %', p_source
      USING ERRCODE = '22023';
  END IF;

  RETURN COALESCE(missing, ARRAY[]::TEXT[]);
END;
$$;

NOTIFY pgrst, 'reload schema';
