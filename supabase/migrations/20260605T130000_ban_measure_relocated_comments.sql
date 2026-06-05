-- Doc-only — réaligne les commentaires des colonnes mesure BAN sur la nouvelle
-- sémantique. La mesure `rpps_measure_ban_to_geocode` est désormais appelée
-- POST-SWAP sur `rpps` (résidu après ban_join = vraie file Phase 2), et non plus
-- pré-ban_join sur `rpps_staging` (~1,29 M lignes → 57014 systématique au 1er run
-- réel, prouvé prod run #27003446829). La RPC elle-même est inchangée (elle
-- whiteliste déjà `rpps` | `rpps_staging`) ; seul le caller `scripts/ingest/rpps.ts`
-- a bougé. Aucune donnée touchée.

COMMENT ON COLUMN ingest_log.ban_eligible_distinct IS
  'Phase 1 mesure — nb d''adresses DISTINCTES éligibles BAN restant en commune_centroid sur `rpps` APRÈS le swap + ban_join (= résidu non résolu par le cache). NULL = mesure non exécutée (run pre-2026-05-20, échec early, ou run failed avant le swap). Mesuré par rpps_measure_ban_to_geocode(''rpps'') post-swap.';
COMMENT ON COLUMN ingest_log.ban_to_geocode_distinct IS
  'Phase 1 mesure — sous-ensemble des éligibles distincts résiduels PAS encore résolu/capé dans geocoded_addresses (= taille de la file BAN qu''un re-géocodage Phase 2 aurait à traiter). NULL = idem. Mesuré post-swap sur `rpps` par rpps_measure_ban_to_geocode.';
