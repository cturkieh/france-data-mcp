-- Retrait du cache paresseux DVF, remplacé par la table nationale et la RPC
-- `dvf_stats_in_radius`.
--
-- ORDRE : à appliquer APRÈS le déploiement du code qui lit `dvf_stats_in_radius`.
-- Appliquée avant, elle casse le code en production, qui appelle encore
-- `dvf_in_radius` et écrit dans `dvf_commune_cache`.
--
-- Vérification après apply :
--   SELECT to_regclass('public.dvf_commune_cache');        -- attendu : NULL
--   SELECT count(*) FROM pg_proc WHERE proname = 'dvf_in_radius';  -- attendu : 0

DROP FUNCTION IF EXISTS dvf_in_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INT);
DROP TABLE IF EXISTS dvf_commune_cache;

NOTIFY pgrst, 'reload schema';
