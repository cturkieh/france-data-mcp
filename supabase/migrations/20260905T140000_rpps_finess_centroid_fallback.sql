-- Step 5c-bis du cron RPPS : REPLI FINESS pour les lignes restées au centroïde
-- de commune APRÈS ban_join alors qu'elles portent un `num_finess` connu,
-- géolocalisé, et situé DANS LA MÊME COMMUNE que l'adresse déclarée.
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
-- Garde « même commune » (`f.code_insee = b.code_insee`, revue 2026-09-05,
-- mesuré prod) : 3 857 de ces 57 462 lignes ont un FINESS situé dans une AUTRE
-- commune que leur `code_insee`/`ville` déclarés. Les poser créerait une ligne
-- « Dr X, ville B » pointée en A (incohérence exposée, recherche rayon centrée
-- sur B qui ne la retrouve plus, `densite_*` qui la compte en B). On les laisse
-- au centroïde : 53 605 lignes corrigées (94 % du gain) avec zéro incohérence.
--
-- Ordre : APRÈS ban_join (BAN housenumber > point FINESS DREES, Lambert93
-- grossier — cf. CLAUDE.md « décalage partagé ~50-100 m »), AVANT le re-ANALYZE
-- 5d et le swap. `geom_source = 'finess_join'` (même sémantique « position de
-- l'établissement FINESS » que 5b) → ces lignes entrent dans le GiST PARTIEL
-- `rpps_geog_precise_gist` (prédicat `IN ('finess_join','ban_address')`) et
-- dans la branche `precise` de `rpps_in_radius`.
--
-- EFFET DE BORD ASSUMÉ : ces lignes SORTENT définitivement de l'éligibilité BAN
-- (prédicat `geom_source = 'commune_centroid' OR …` de `rpps_measure_ban_to_geocode`
-- et du drain `rpps_eligible_rows_after_id`). La jauge 6d chute d'un cran
-- (~54 K) au 1er run — ce n'est PAS un progrès BAN — et ces adresses
-- d'établissements ne seront plus soumises au géocodage (elles se géocodent
-- mal ; économie de quota BAN ; le point FINESS est l'état final voulu).
--
-- `code_insee` / `code_departement` NE sont PAS écrasés (≠ 5b, où la ligne n'en
-- avait pas) : la commune déclarée reste la référence des comptages.
--
-- Patron = jumeau de `ingest_apply_rpps_ban_join_batch` (curseur KEYSET
-- `p_after`, jamais sentinelle — cf. docs/plans/ban-join.md ; `RETURNS
-- TABLE(last_id, applied)` consommé par `runKeysetRpc`). Plan mesuré prod
-- (table propre) : Index Scan `geom_source_idx` + top-N sort par lot, ~4,5 s /
-- lot de 10 K, ~8 lots — pas le « constant » de ban_join (aucun index
-- (geom_source, id) ; on n'en ajoute PAS sur la staging, gotcha index lourd),
-- mais linéaire et borné. `length(num_finess) = 9` : le cast explicite
-- `::CHAR(9)` TRONQUE en silence — une dérive amont vers 10 caractères
-- matcherait un établissement RÉEL mais FAUX ; le filtre rend l'échec propre
-- (ligne ignorée). Le cast est côté texte (pas sur la colonne indexée, gotcha
-- CLAUDE.md « JAMAIS WHERE col_char = p_text ») ; en pratique le planner fait
-- un hash join sur les 93 K lignes de `finess` (mesuré). `SET
-- statement_timeout` au niveau fonction (budget 8 s hérité sinon), < 60 s cap
-- passerelle PostgREST.
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
    SELECT id, num_finess, code_insee
    FROM rpps_staging
    WHERE id > p_after
      AND geom_source = 'commune_centroid'
      AND num_finess IS NOT NULL
      AND length(num_finess) = 9
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
     AND f.code_insee = b.code_insee
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
  'Cron RPPS 5c-bis : pose la position FINESS (geom_source=finess_join) sur les lignes rpps_staging restées commune_centroid après ban_join et portant un num_finess géolocalisé dans la MÊME commune. Keyset p_after, lots p_limit. Voir migration 20260905T140000.';
