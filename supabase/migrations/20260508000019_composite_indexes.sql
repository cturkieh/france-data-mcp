-- V0.4.1 — Index composites pour éliminer les timeouts SQL 57014.
--
-- Audit empirique 2026-05-08 (Charleville) : `professionnels_par_specialite_dept`
-- timeout sur (dept=08, specialite=06) avec limit=500 et `etablissements_finess_by_categorie`
-- timeout sur (categorie="pharmacie", code_insee="08105") avec limit=500.
--
-- Cause confirmée : index simples séparés `(code_departement)` et `(specialite_code)`
-- côté Ameli, `(categorie_code)` et `(code_departement)` côté FINESS. Postgres ne
-- combine pas deux index B-tree de manière efficace quand chaque côté a une forte
-- cardinalité — il choisit un seul index et filtre l'autre côté en seq scan, ce
-- qui dépasse les 8s de Supabase statement_timeout.
--
-- Fix : index composites alignés sur les patterns de query effectifs des RPCs.
-- - annuaire_ameli  : (code_departement, specialite_code), (code_departement, type_ps_code)
-- - finess          : (code_departement, categorie_code), (code_insee, categorie_code)
--
-- Note sur CONCURRENTLY : Supabase migrations tournent dans une transaction,
-- donc CREATE INDEX CONCURRENTLY n'est pas autorisé. Un CREATE INDEX bloquant
-- finit en quelques secondes sur les volumes actuels (~462 K Ameli, ~95 K FINESS).
-- ANALYZE final pour rafraîchir les stats que le planner utilise.

CREATE INDEX IF NOT EXISTS annuaire_ameli_dept_spec_idx
  ON annuaire_ameli (code_departement, specialite_code);

CREATE INDEX IF NOT EXISTS annuaire_ameli_dept_type_idx
  ON annuaire_ameli (code_departement, type_ps_code);

CREATE INDEX IF NOT EXISTS finess_dept_categorie_idx
  ON finess (code_departement, categorie_code);

CREATE INDEX IF NOT EXISTS finess_insee_categorie_idx
  ON finess (code_insee, categorie_code);

ANALYZE annuaire_ameli;
ANALYZE finess;

NOTIFY pgrst, 'reload schema';
