-- Sentinelle de la pose BAN FINESS — dénominateur CORRECT (post-mortem du
-- second run forcé du 2026-09-06, run #34023827629, issue #76).
--
-- La sentinelle de 20260906T120000 comparait « 0 posé » aux ÉLIGIBLES (sans
-- point + voie). Faux positif prouvé au deuxième run : tout ce qui était
-- posable l'avait été au premier (2 720, propagés par le repli), les 1 902
-- éligibles restants sont des rejets BAN (score < 0,5 / non résolus) → 0 posé
-- est LÉGITIME, le run est sorti `partial` et la vigie a alerté pour rien.
--
-- Le bon dénominateur est ce que la pose FERAIT : les éligibles dont la clé
-- est en cache, acceptée, en précision rue/bâtiment/lieu-dit — exactement le
-- prédicat de `ingest_apply_finess_ban_join`, en count. Appelée AVANT la pose :
-- posable = 0 → « 0 posé » attendu (info) ; posé < posable → pose muette ou
-- partielle (partial + trace). Même jointure que la pose (454 ms mesuré).

CREATE OR REPLACE FUNCTION finess_count_ban_posable(p_source_table TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v_tbl TEXT := finess_resolve_source_table(p_source_table);
  v_cnt BIGINT;
BEGIN
  IF v_tbl IS NULL THEN
    RAISE EXCEPTION 'finess_count_ban_posable: invalid source table %', p_source_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  EXECUTE format($q$
    SELECT count(*)
      FROM %I s
      JOIN geocoded_addresses g
        ON g.address_key = rpps_address_key_for_index(s.voie, s.code_postal::text, s.code_insee::text)
     WHERE finess_is_ban_eligible(s.geom, s.voie)
       AND g.accepted = true
       AND g.result_type IN ('housenumber', 'street', 'locality')
  $q$, v_tbl) INTO v_cnt;
  RETURN v_cnt;
END;
$$;

REVOKE EXECUTE ON FUNCTION finess_count_ban_posable(TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION finess_count_ban_posable(TEXT) TO service_role;
