-- ban_join — refonte 2026-05-19. Cf. docs/plans/2026-05-19-ban-join-design.md.
--
-- Remplace le step BAN cron cassé (build index lourd via RPC PostgREST,
-- timeouté structurellement au cap passerelle 60 s — réfuté prod run
-- #26087010166) par un UPDATE ensembliste rpps_staging ⟕ geocoded_addresses,
-- jumeau de ingest_apply_rpps_finess_enrichment_batch, PILOTÉ PAR CURSEUR
-- KEYSET (p_after) — PAS par sentinelle (l'approche sentinelle re-scanne le
-- préfixe traité → quadratique → 57014 en fin de parcours, RÉFUTÉ prod :
-- proxy OFFSET 1.2M > 120 s ; keyset = ~4,8 s/lot constant, prouvé prod).
--
-- PARITÉ BYTE-À-BYTE (garde-fou dur) : l'expression
-- rpps_address_key_for_index(adresse,code_postal,code_insee) ET le prédicat
-- geom_source='commune_centroid' OR (geom IS NULL AND adresse IS NOT NULL)
-- sont byte-identiques à rpps_distinct_eligible_keys / rpps_count_ban_eligible_rows
-- / ingest_build_rpps_staging_ban_indexes (gardés par
-- ban-eligibility-{index-expr,predicate}-parity.test.ts). statement_timeout
-- fonction = '55s' (< cap passerelle PostgREST 60 s — gotcha CLAUDE.md ;
-- gardé par enrichment-statement-timeout.test.ts).
--
-- APPLICATION : naming YYYYMMDDThhmmss → la CLI Supabase saute ce fichier
-- (db reset ne l'applique pas) ; appliquée MANUELLEMENT en prod via le canal
-- psql pooler. CREATE OR REPLACE, signature stable, idempotente, rejouable.

CREATE OR REPLACE FUNCTION ingest_apply_rpps_ban_join_batch(
  p_after BIGINT, p_limit INT)
RETURNS TABLE(last_id BIGINT, applied INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
BEGIN
  RETURN QUERY
  WITH batch AS (
    SELECT id,
           rpps_address_key_for_index(adresse, code_postal, code_insee) AS akey
    FROM rpps_staging
    WHERE id > p_after
      AND (geom_source = 'commune_centroid'
           OR (geom IS NULL AND adresse IS NOT NULL))
    ORDER BY id
    LIMIT p_limit
  ),
  -- wCTE data-modifying : PostgreSQL l'exécute EXACTEMENT UNE FOIS dès qu'il
  -- est référencé n'importe où dans la requête (ici via le count scalaire
  -- ci-dessous), même absent du FROM principal. NE PAS le « simplifier » en
  -- le croyant mort : le retirer supprimerait l'UPDATE silencieusement.
  upd AS (
    UPDATE rpps_staging r
    SET geom = ST_SetSRID(ST_MakePoint(g.lon, g.lat), 4326),
        geom_source = 'ban_address'
    FROM batch b
    JOIN geocoded_addresses g
      ON g.address_key = b.akey AND g.accepted = true
    WHERE r.id = b.id
    RETURNING 1
  )
  -- last_id = dernière clé VUE du lot (curseur keyset, matchée ou non) ;
  -- applied = nb réellement posé (count des RETURNING de `upd`).
  SELECT max(b.id)::BIGINT AS last_id,
         (SELECT count(*)::INT FROM upd) AS applied
  FROM batch b;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_apply_rpps_ban_join_batch(BIGINT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_apply_rpps_ban_join_batch(BIGINT, INT) TO service_role;

COMMENT ON FUNCTION ingest_apply_rpps_ban_join_batch(BIGINT, INT) IS
  'ban_join (refonte 2026-05-19, cf. docs/plans/2026-05-19-ban-join-design.md) — pose ensembliste cache geocoded_addresses → rpps_staging pour UN lot keyset (p_after BIGINT curseur, p_limit INT). Jumeau de ingest_apply_rpps_finess_enrichment_batch mais piloté CURSEUR KEYSET (p_after), pas sentinelle (sentinelle = re-scan quadratique → 57014 fin de parcours, réfuté prod ; keyset ~4,8s/lot constant, prouvé prod). RETURNS (last_id = max(id) du lot VU matché ou non = curseur ; NULL ⇒ page vide ⇒ fin ; applied = nb réellement posés). JOIN (pas LEFT JOIN) + zéro sentinelle : une ligne non cachée garde commune_centroid (repli ~3km). Expression rpps_address_key_for_index + prédicat geom_source=commune_centroid OR (geom NULL AND adresse NOT NULL) byte-identiques à rpps_distinct_eligible_keys / rpps_count_ban_eligible_rows / ingest_build_rpps_staging_ban_indexes (gardes ban-eligibility-*-parity). SECURITY DEFINER, SET statement_timeout=55s (< cap passerelle 60s, garde enrichment-statement-timeout), EXECUTE service_role only. Idempotente, rejouable. Naming T-format : CLI Supabase la saute, appliquée manuellement via canal psql.';
