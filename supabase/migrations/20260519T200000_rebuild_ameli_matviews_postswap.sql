-- ROBUSTESSE MATVIEW/SWAP AMELI 2026-05-19 — clôture du backlog P1
-- symétrique au fix RPPS 20260518T150000 (ingest_rebuild_rpps_matviews).
--
-- DÉFAUT (même classe que RPPS, prouvé prod par transitivité + DROP testé).
-- `ameli_nomenclature_stats` est définie `... FROM annuaire_ameli ...`
-- (migration canonique 20260515T020100). Une matview PostgreSQL référence sa
-- table source par OID, pas par nom. `ingest_atomic_swap('annuaire_ameli')`
-- fait une rotation par RENAME
-- (`annuaire_ameli`→`_previous`→`_previous_OLD`→`DROP ... CASCADE`). Le
-- post-swap actuel se contente d'un REFRESH (`ingest_refresh_matview`,
-- REFRESH-only) :
--   - 1er cron réussi : la matview suit l'OID → collée à l'ancienne table
--     → REFRESH recalcule depuis les données AVANT le cron → désync
--     SILENCIEUSE (status `success`), `lister_specialites_ameli` /
--     `lister_types_ps_ameli` servent du périmé ;
--   - 2e cron réussi : `DROP <t>_previous_OLD CASCADE` DÉTRUIT la matview
--     → REFRESH `42P01` avalé en `partial` → les 2 RPC DOWN jusqu'à
--     recréation manuelle.
-- Masqué FORTUITEMENT jusqu'ici par `shortCircuitIfSameChecksum`
-- (`ameli.ts`, AVANT le swap : extrait Ameli souvent identique → 2e swap
-- consécutif évité). NON garanti : Ameli est HEBDOMADAIRE sur ~485 k PS,
-- l'extrait CHANGE → la bombe s'arme. Backlog P1 explicite (CLAUDE.md,
-- header 20260518T150000, rpps-matview-rebuild.test.ts) — clôturé ici.
--
-- CORRECTION. `ingest_rebuild_ameli_matviews()` RECONSTRUIT la matview
-- post-swap au lieu de la REFRESH (mécanique IDENTIQUE à
-- `ingest_rebuild_rpps_matviews`). `CREATE MATERIALIZED VIEW ... FROM
-- annuaire_ameli` résout `annuaire_ameli` PAR NOM au moment du CREATE
-- (post-swap = la NOUVELLE table) → corrige À LA FOIS la désync du 1er cron
-- ET la destruction du 2e. `scripts/ingest/ameli.ts` appelle cette fonction
-- post-swap à la place de `refreshAmeliMatviews`.
--
-- BASCULE SANS FENÊTRE (build-new + RENAME, 1 transaction PL/pgSQL).
-- Construire `ameli_nomenclature_stats_rebuild` (peuplée) + son UNIQUE
-- INDEX + GRANT ; puis `DROP MATERIALIZED VIEW ameli_nomenclature_stats`
-- (SANS CASCADE) + `ALTER ... RENAME`. MVCC sérialise : un lecteur
-- concurrent (`ameli_lister_specialites`/`ameli_lister_types_ps`) voit soit
-- l'ancienne, soit la nouvelle, JAMAIS `42P01`.
--
-- DROP SANS CASCADE — PROUVÉ EN PROD (2026-05-19, transaction ROLLBACK) :
-- `DROP MATERIALIZED VIEW ameli_nomenclature_stats` RÉUSSIT malgré les 2
-- RPC `ameli_lister_specialites`/`ameli_lister_types_ps` qui la référencent.
-- Les fonctions `LANGUAGE sql` à corps `$$...$$` classique NE créent PAS de
-- dépendance catalogue bloquante (≠ vue) → DROP simple suffit, exactement
-- comme pour les matviews RPPS (résolution au runtime). CASCADE est
-- d'ailleurs PROSCRIT ici (il droperait silencieusement les 2 RPC) ; le
-- DROP simple + RENAME dans la même txn les laisse valides (la matview
-- réapparaît sous le même nom avant le COMMIT). `_rebuild` résiduel d'un
-- run interrompu : `DROP ... IF EXISTS CASCADE` en tête (objet jetable).
-- Idempotente, rejouable.
--
-- PARITÉ DDL (anti-drift). Le SELECT + l'UNIQUE INDEX ci-dessous sont la
-- RECOPIE VERBATIM de la matview canonique 20260515T020100. Gardé par
-- `scripts/ingest/ameli-matview-rebuild.test.ts` (compare le noyau SELECT
-- normalisé) : un changement de la matview canonique sans MAJ de cette
-- fonction = test rouge avant merge.
--
-- APPLICATION. Naming `YYYYMMDDThhmmss` → la CLI Supabase saute ce fichier
-- (`db reset` ne l'applique pas) : appliqué MANUELLEMENT en prod via le
-- canal psql pooler. `CREATE OR REPLACE` (signature `RETURNS VOID` ;
-- fonction nouvelle), idempotent, rejouable. Appliquer la fonction ne
-- modifie rien en prod tant que le cron ne l'exécute pas.

CREATE OR REPLACE FUNCTION ingest_rebuild_ameli_matviews()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '10min'
AS $$
BEGIN
  -- ── ameli_nomenclature_stats ─────────────────────────────────────────
  DROP MATERIALIZED VIEW IF EXISTS ameli_nomenclature_stats_rebuild CASCADE;
  CREATE MATERIALIZED VIEW ameli_nomenclature_stats_rebuild AS
SELECT
  a.specialite_code,
  a.specialite_libelle,
  a.type_ps_code,
  a.type_ps_libelle,
  COUNT(*)::BIGINT AS cnt
FROM annuaire_ameli a
GROUP BY a.specialite_code, a.specialite_libelle, a.type_ps_code, a.type_ps_libelle;
  CREATE UNIQUE INDEX ameli_nomenclature_stats_rebuild_pk
    ON ameli_nomenclature_stats_rebuild (specialite_code, specialite_libelle, type_ps_code, type_ps_libelle)
    NULLS NOT DISTINCT;
  GRANT SELECT ON ameli_nomenclature_stats_rebuild TO anon;
  DROP MATERIALIZED VIEW IF EXISTS ameli_nomenclature_stats;
  ALTER MATERIALIZED VIEW ameli_nomenclature_stats_rebuild RENAME TO ameli_nomenclature_stats;
  ALTER INDEX ameli_nomenclature_stats_rebuild_pk RENAME TO ameli_nomenclature_stats_pk;

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_rebuild_ameli_matviews FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_rebuild_ameli_matviews TO service_role;

COMMENT ON FUNCTION ingest_rebuild_ameli_matviews IS
  'Robustesse matview/swap 2026-05-19 : reconstruit (build-new + RENAME atomique) la matview ameli_nomenclature_stats post-swap au lieu de REFRESH. Clôture le backlog P1 symétrique au fix RPPS 20260518T150000 (suivi d OID : désync 1er cron + destruction CASCADE 2e cron). DROP sans CASCADE prouvé prod (les 2 RPC sql ne créent pas de dépendance bloquante). Appelée par scripts/ingest/ameli.ts post-swap à la place de refreshAmeliMatviews. SELECT + index VERBATIM de la matview canonique 20260515T020100 (parité gardée par ameli-matview-rebuild.test.ts).';
