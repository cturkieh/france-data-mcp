-- Réserve à service_role les fonctions internes d'ingestion et de géocodage.
--
-- Supabase donne EXECUTE à anon et authenticated sur toute nouvelle fonction de `public`
-- (`pg_default_acl`) : `REVOKE ... FROM PUBLIC` seul ne le retire pas. Aucune de ces
-- fonctions n'est appelée par `src/` ou `api/` ; les scripts et les crons utilisent la clé
-- service_role, qui garde son droit explicite.
--
-- Appliquée en prod le 2026-11-06 depuis l'éditeur SQL. Garde-fou :
-- `scripts/ingest/fonctions-internes-droits.test.ts`.

REVOKE EXECUTE ON FUNCTION ameli_count_ban_eligible_rows(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ameli_distinct_eligible_keys(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ameli_eligible_rows_after_id(text, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ameli_measure_ban_to_geocode(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_analyze_ameli_staging() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_analyze_rpps_staging() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_apply_ameli_ban_join_batch(bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_apply_rpps_ban_geocoding_batch(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_apply_rpps_ban_join_batch(bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_apply_rpps_finess_centroid_fallback_batch(bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_apply_rpps_finess_enrichment_batch(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_atomic_swap(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_build_ameli_staging_ban_indexes() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_build_rpps_staging_ban_indexes() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_create_annuaire_ameli_staging() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_create_centres_sante_staging() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_create_finess_staging() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_create_iris_familles_staging() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_create_iris_population_staging() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_create_iris_revenu_staging() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_create_iris_staging() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_create_rpps_staging() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_create_sitadel_logements_staging() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_drop_stale_previous(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_rebuild_ameli_matviews() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_rebuild_finess_hosted_activities() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_rebuild_rpps_matviews() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_refresh_matview(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION rpps_count_ban_eligible_rows(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION rpps_distinct_eligible_keys(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION rpps_eligible_rows_after_id(text, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION rpps_geocoded_cache_lookup(text[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION rpps_measure_ban_to_geocode(text) FROM PUBLIC, anon, authenticated;
