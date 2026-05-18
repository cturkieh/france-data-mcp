-- FIX C 2026-05-18 — 3e volet du désamorçage cron RPPS (conjoint A+B+C).
-- À appliquer APRÈS 20260518T140000 (A) et 20260518T150000 (B).
--
-- DÉFAUT (prouvé prod 2026-05-18 : run #26046475566 + EXPLAIN ANALYZE +
-- pg_roles, lecture seule). Le fix A (retrait des 2 index BAN Unicode de
-- `ingest_create_rpps_staging`) a été PROUVÉ insuffisant : le cron RPPS de
-- validation a re-échoué EXACTEMENT pareil — `ingest_apply_rpps_finess_
-- enrichment_batch failed: canceling statement due to statement timeout`
-- (SQLSTATE 57014), `error_phase=validate`, AVANT le swap (données `rpps`
-- intactes). Cause-racine RÉELLE, convergente :
--   1. Le cron appelle l'enrichment via supabase-js clé SERVICE_ROLE →
--      PostgREST → rôle `service_role`. `pg_roles` prod : `service_role`
--      rolconfig=NULL → hérite du `statement_timeout` de `authenticator`
--      = 8s (doc Supabase officielle « Timeouts »). La fonction (def
--      `20260509T210000`) n'a AUCUN `SET statement_timeout` fonction —
--      SEULE RPC longue du projet sans (toutes les autres en ont une :
--      `ingest_rebuild_rpps_matviews` '10min', matviews '10min', etc.).
--   2. Aucun `ANALYZE rpps_staging` entre le bulk COPY (~2,24M lignes dans
--      une table fraîchement CREATE) et le 1er batch d'enrichment → le
--      planner n'a aucune statistique → plan dégradé → un batch de 10K
--      (CTE sur 2,24M + LEFT JOIN finess + 10K UPDATE) dépasse 8s → 57014
--      déterministe sur le 1er batch. Mesure prod (plan chaud, stats à
--      jour) : 5,3s/batch — soit déjà seulement 1,5× sous le couperet 8s.
--   Les index BAN n'étaient qu'un AGGRAVANT (INSERT 2,24M lignes ralenti =
--   run ~57 min ; maintenance d'index par row updatée).
--
-- CORRECTION C (defense-in-depth, attaque les DEUX facteurs prouvés) :
--   C1. `CREATE OR REPLACE ingest_apply_rpps_finess_enrichment_batch` —
--       corps RECOPIÉ VERBATIM de `20260509T210000` (la dernière def main,
--       seule chose qui change = le header) + `SET statement_timeout =
--       '55s'` au niveau fonction. Best practice Supabase explicite pour
--       une RPC récurrente longue (« function-level approach … avoids
--       PostgREST reloads, keeps timeout encapsulated ») + convention du
--       projet. Valeur 55s : SOUS le cap passerelle PostgREST ~60s (gotcha
--       CLAUDE.md) → si un batch dérape, 57014 propre/diagnosticable AVANT
--       le timeout passerelle opaque ; ~10× le batch chaud (5,3s) = marge
--       large pour cache froid / charge / plan tiède post-ANALYZE.
--   C2. `ingest_analyze_rpps_staging()` = `ANALYZE rpps_staging`. Appelée
--       par `scripts/ingest/rpps.ts` APRÈS le COPY et AVANT l'enrichment.
--       Pratique Postgres canonique « bulk COPY puis ANALYZE avant de
--       requêter » : donne au planner des stats fraîches → bon plan
--       (Index Scan `rpps_staging_pending_enrichment_idx`) dès le 1er
--       batch. supabase-js ne peut pas lancer `ANALYZE` en SQL brut → RPC
--       dédiée SECURITY DEFINER (pattern projet pour le DDL via RPC).
--       Elle porte AUSSI `SET statement_timeout = '55s'` : sans lui elle
--       hériterait du même budget 8s `service_role`→`authenticator` (le
--       défaut racine que C corrige) → un `ANALYZE` lent à froid (free-tier
--       IOPS, 2,24M lignes) re-casserait le cron en 57014, une étape plus
--       tôt. Aucune RPC d'ingestion n'est exemptée de cette borne.
--
-- POURQUOI LE 09/05 PASSAIT (probable, non sur-affirmé) : falaise de
-- scaling — batchs marginalement < 8s avec moins de données ; croissance
-- RPPS/FINESS → bascule au-dessus. « Marchait jusqu'à ce que ça casse. »
--
-- PARITÉ ANTI-DRIFT. Le corps de C1 ci-dessous est la recopie verbatim de
-- `20260509T210000`. Gardé par `scripts/ingest/enrichment-statement-
-- timeout.test.ts` (corps normalisé == migration canonique ; un drift de
-- logique d'enrichment sans MAJ canonique = test rouge avant merge).
--
-- APPLICATION. Naming `YYYYMMDDThhmmss` → la CLI Supabase saute ce fichier
-- (`db reset` ne l'applique pas) : appliqué MANUELLEMENT en prod via le
-- canal psql pooler, APRÈS A et B. `CREATE OR REPLACE` (signatures
-- inchangées → pas de `DROP FUNCTION`), idempotent, rejouable. Appliquer
-- ne modifie rien tant que le cron ne ré-exécute pas l'enrichment.

-- ── C1 : enrichment + SET statement_timeout fonction ─────────────────────
-- Corps VERBATIM de 20260509T210000:145-170 ; seul ajout = le header
-- `SET statement_timeout = '55s'`.
CREATE OR REPLACE FUNCTION ingest_apply_rpps_finess_enrichment_batch(p_limit INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v_updated INT;
BEGIN
  WITH batch AS (
    SELECT id, num_finess
    FROM rpps_staging
    WHERE geom IS NULL
      AND num_finess IS NOT NULL
      AND geom_source IS NULL
    ORDER BY id
    LIMIT p_limit
  )
  UPDATE rpps_staging r
  SET
    geom             = CASE WHEN f.geom IS NOT NULL THEN f.geom             ELSE r.geom END,
    code_insee       = CASE WHEN f.geom IS NOT NULL THEN f.code_insee       ELSE r.code_insee END,
    code_departement = CASE WHEN f.geom IS NOT NULL THEN f.code_departement ELSE r.code_departement END,
    geom_source      = CASE WHEN f.geom IS NOT NULL THEN 'finess_join'      ELSE 'finess_unmatched' END
  FROM batch b
  LEFT JOIN finess f ON f.num_finess = b.num_finess
  WHERE r.id = b.id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_apply_rpps_finess_enrichment_batch FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_apply_rpps_finess_enrichment_batch TO service_role;

COMMENT ON FUNCTION ingest_apply_rpps_finess_enrichment_batch IS
  'Fix C 2026-05-18 : corps verbatim de 20260509T210000 + SET statement_timeout=55s fonction. Sans ce SET la fonction heritait du budget service_role->authenticator 8s (pg_roles prod) ; un batch 10K depassait 8s -> 57014 deterministe en validate, cron RPPS casse (run #26046475566). Couple a ingest_analyze_rpps_staging (stats fraiches post-COPY). Justification valeur 55s + post-mortem : en-tete migration 20260518T160000.';

-- ── C2 : ANALYZE rpps_staging post-COPY ──────────────────────────────────
-- supabase-js ne peut pas lancer `ANALYZE` en SQL brut (pas une requête
-- table PostgREST) → RPC dédiée. Appelée par rpps.ts APRÈS le bulk COPY,
-- AVANT l'enrichment : stats fraîches → bon plan dès le 1er batch.
-- `SET statement_timeout = '55s'` : même borne que C1 — sans lui cette RPC
-- hériterait du budget racine 8s `service_role`→`authenticator` et un
-- `ANALYZE` lent à froid re-casserait le cron une étape plus tôt (aucune
-- RPC d'ingestion n'est exemptée de cette borne).
CREATE OR REPLACE FUNCTION ingest_analyze_rpps_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
BEGIN
  ANALYZE rpps_staging;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_analyze_rpps_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_analyze_rpps_staging TO service_role;

COMMENT ON FUNCTION ingest_analyze_rpps_staging IS
  'Fix C 2026-05-18 : ANALYZE rpps_staging + SET statement_timeout=55s. Appelee par rpps.ts post-COPY (2,24M lignes bulk) / pre-enrichment. Sans stats fraiches le planner part en plan degrade sur le 1er batch d enrichment -> >8s -> 57014. Le SET evite que cette RPC re-herite du budget racine 8s service_role->authenticator. Pratique Postgres canonique bulk COPY puis ANALYZE.';
