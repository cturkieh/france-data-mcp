-- Step 5c-bis du cron RPPS : REPLI FINESS pour les lignes restées au centroïde
-- de commune APRÈS ban_join alors qu'elles portent un `num_finess` connu et
-- géolocalisé.
--
-- Pourquoi (prouvé prod 2026-09-05, table `rpps` post-swap) : l'enrichment
-- FINESS (5b, `ingest_apply_rpps_finess_enrichment_batch`) ne vise que les
-- lignes SANS geom (commune introuvable). Une ligne dont la commune est reconnue
-- reçoit le centroïde (TS), puis ban_join tente l'adresse texte de la structure
-- dans le cache BAN — les adresses d'établissements (nom de structure, CS/BP,
-- cedex) se géocodent mal → 70 677 lignes restaient au centroïde AVEC un
-- num_finess, dont 57 462 dont l'établissement est géolocalisé dans `finess`.
-- La position exacte était sous la main et jamais utilisée.
--
-- Ordre : APRÈS ban_join (BAN housenumber > point FINESS DREES, Lambert93
-- grossier — cf. CLAUDE.md « décalage partagé ~50-100 m »), AVANT le re-ANALYZE
-- 5d et le swap. `geom_source = 'finess_join'` (même sémantique « position de
-- l'établissement FINESS » que 5b) → ces lignes entrent dans le GiST PARTIEL
-- `rpps_geog_precise_gist` (prédicat `IN ('finess_join','ban_address')`) et
-- dans la branche `precise` de `rpps_in_radius`.
--
-- `code_insee` / `code_departement` NE sont PAS écrasés (≠ 5b, où la ligne n'en
-- avait pas) : la commune déclarée de la ligne reste la référence des comptages
-- par commune ; seul le point change.
--
-- Patron = jumeau de `ingest_apply_rpps_ban_join_batch` (curseur KEYSET
-- `p_after`, jamais sentinelle — cf. docs/plans/ban-join.md ; `RETURNS
-- TABLE(last_id, applied)` consommé par `runKeysetRpc`). Jointure sur
-- `finess_pkey` (CHAR(9)) via cast EXPLICITE du côté texte (`::CHAR(9)`) —
-- sinon Postgres caste la COLONNE indexée en text et perd l'index (gotcha
-- CLAUDE.md « JAMAIS WHERE col_char = p_text »). `SET statement_timeout` au
-- niveau fonction (budget 8 s hérité sinon — gotcha CLAUDE.md), < 60 s cap
-- passerelle PostgREST. ~70 K éligibles / lots de 10 K ≈ 8 lots.
--
-- Migration T-format : PROD-ONLY, appliquée via MCP Supabase `apply_migration`
-- (la CLI la saute ; cf. mémoire migrations-t-format-canal-apply).

CREATE OR REPLACE FUNCTION ingest_apply_rpps_finess_centroid_fallback_batch(
  p_after BIGINT,
  p_limit INTEGER
)
RETURNS TABLE(last_id BIGINT, applied INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
SET statement_timeout TO '55s'
AS $$
BEGIN
  RETURN QUERY
  WITH batch AS (
    SELECT id, num_finess
    FROM rpps_staging
    WHERE id > p_after
      AND geom_source = 'commune_centroid'
      AND num_finess IS NOT NULL
    ORDER BY id
    LIMIT p_limit
  ),
  -- wCTE data-modifying : exécutée EXACTEMENT UNE FOIS dès qu'elle est
  -- référencée (ici par le count scalaire). NE PAS la « simplifier » en la
  -- croyant morte : la retirer supprimerait l'UPDATE silencieusement.
  upd AS (
    UPDATE rpps_staging r
    SET geom        = f.geom,
        geom_source = 'finess_join'
    FROM batch b
    JOIN finess f
      ON f.num_finess = b.num_finess::CHAR(9)
     AND f.geom IS NOT NULL
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

REVOKE EXECUTE ON FUNCTION ingest_apply_rpps_finess_centroid_fallback_batch(BIGINT, INTEGER) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_apply_rpps_finess_centroid_fallback_batch(BIGINT, INTEGER) TO service_role;

COMMENT ON FUNCTION ingest_apply_rpps_finess_centroid_fallback_batch(BIGINT, INTEGER) IS
  'Cron RPPS 5c-bis : pose la position FINESS (geom_source=finess_join) sur les lignes rpps_staging restées commune_centroid après ban_join et portant un num_finess géolocalisé. Keyset p_after, lots p_limit. Voir migration 20260905T140000.';
