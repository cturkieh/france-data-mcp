-- V0.5.1 hotfix — étend le statement_timeout de `ingest_atomic_swap` à 10 min.
--
-- Contexte : le 1er run V0.5.1 (run GH 25611148383) a tout réussi côté
-- pipeline (2,23 M rows ingérées, 391 K matched FINESS, geo coverage 74,13 %)
-- mais le swap atomic a fail avec « canceling statement due to statement
-- timeout ». Le timeout Supabase default 60s est insuffisant pour DDL
-- (RENAME table + 14 RENAME INDEX en cascade) sur 2,23 M rows avec
-- l'index geog GIST gigantesque que la swap doit re-stat.
--
-- ALTER FUNCTION ... SET ... étend uniquement le scope de cette fonction —
-- les autres RPCs et requêtes utilisateur gardent le timeout default 60s.
-- 10 min couvre largement le cas RPPS (steady state ~30-60s observé sur
-- FINESS/Ameli plus petits) avec marge pour les pics charge Supabase.

ALTER FUNCTION ingest_atomic_swap(TEXT) SET statement_timeout = '600s';

NOTIFY pgrst, 'reload schema';
