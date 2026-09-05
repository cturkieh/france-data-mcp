-- `rpps_count_ban_eligible_rows` : ajout du `SET statement_timeout = '55s'` au
-- niveau fonction — DERNIÈRE RPC d'ingestion RPPS encore exemptée de l'invariant
-- (prouvé prod 2026-09-05 : `proconfig = {search_path=public, extensions}`, ~5 s
-- mesurés sur table propre ; passait seulement parce qu'appelée AVANT ban_join,
-- peu de bloat). Sans SET, elle hérite du budget 8 s service_role→authenticator
-- (gotcha CLAUDE.md) → 57014 le jour où la staging est un peu plus lourde.
--
-- Corps recopié VERBATIM depuis `20260517T120000_rpps_distinct_eligible_keys.sql` (PostgreSQL n'a pas
-- d'héritage de corps de fonction — gotcha CLAUDE.md « recopie VERBATIM ») :
-- le prédicat d'éligibilité BAN reste byte-identique aux sites gardés par
-- `ban-eligibility-predicate-parity.test.ts`. Garde de l'invariant :
-- `enrichment-statement-timeout.test.ts`.
--
-- Migration T-format : PROD-ONLY, appliquée via MCP Supabase `apply_migration`.

CREATE OR REPLACE FUNCTION rpps_count_ban_eligible_rows(
  p_source_table TEXT
) RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v_tbl TEXT;
  v_cnt BIGINT;
BEGIN
  v_tbl := CASE p_source_table
             WHEN 'rpps'         THEN 'rpps'
             WHEN 'rpps_staging' THEN 'rpps_staging'
             ELSE NULL
           END;
  IF v_tbl IS NULL THEN
    RAISE EXCEPTION 'rpps_count_ban_eligible_rows: invalid source table %', p_source_table
      USING ERRCODE = '22023';
  END IF;

  EXECUTE format(
    'SELECT count(*) FROM %I t WHERE (t.geom_source = ''commune_centroid'' OR (t.geom IS NULL AND t.adresse IS NOT NULL))',
    v_tbl
  ) INTO v_cnt;
  RETURN v_cnt;
END;
$$;
