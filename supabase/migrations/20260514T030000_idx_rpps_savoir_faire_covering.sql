-- V0.8.1 hotfix — index couvrant pour `lister_savoir_faire_rpps`.
--
-- Smoke test V0.8.0 en prod a révélé un timeout 57014 (statement_timeout 60s)
-- sur la query `SELECT savoir_faire_code, MAX(libelle), COUNT(*) GROUP BY` :
-- full seq scan + hash agg sur 2.23M rows à chaque appel. L'agent efficiency
-- de la chaîne /simplify l'avait flaggé en LOW priority (tool de découverte
-- considéré peu appelé) — la prod a donné raison à l'avertissement.
--
-- Index covering `(profession_code, savoir_faire_code) WHERE savoir_faire_code IS NOT NULL`
-- permet à PostgreSQL de servir la query via Index-only scan + Group Aggregate
-- au lieu d'un Hash Agg sur la table heap. Estimation perf : 800-2000ms → <100ms.
--
-- Le `WHERE savoir_faire_code IS NOT NULL` réduit la taille de l'index
-- d'environ 30% (les PS sans savoir_faire = pharma, infirmiers, etc., ne sont
-- jamais retournés par le RPC).
--
-- `libelle` exclu de l'index : un seul accès heap par groupe pour le MAX,
-- coût négligeable vs gain index size. Si bench montre encore lent, on
-- pourra ajouter `INCLUDE (savoir_faire_libelle)` (Postgres 11+ covering).

CREATE INDEX IF NOT EXISTS rpps_profession_savoir_faire_partial_idx
  ON rpps (profession_code, savoir_faire_code)
  WHERE savoir_faire_code IS NOT NULL;

COMMENT ON INDEX rpps_profession_savoir_faire_partial_idx IS
  'V0.8.1 — index couvrant pour lister_savoir_faire_rpps (évite seq scan 2.23M).';
