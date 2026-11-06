-- Retire les 2 index trigrammes de rpps (176 Mo), devenus inutiles.
--
-- À appliquer seulement après la preuve en prod de 20261106T120000 : tant qu'ils
-- existent, revenir à l'ancienne RPC ne demande aucune reconstruction d'index.
-- Si ce fichier n'est pas appliqué avant le prochain swap, ils disparaissent quand
-- même : ingest_create_rpps_staging ne les crée plus.

DROP INDEX IF EXISTS rpps_nom_trgm_idx;
DROP INDEX IF EXISTS rpps_prenom_trgm_idx;
