-- Fix P1 — `ingest_rebuild_finess_hosted_activities` était la SEULE des 3 RPC de
-- rebuild post-swap en SECURITY INVOKER (les jumelles `ingest_rebuild_rpps_matviews`
-- / `ingest_rebuild_ameli_matviews` sont DEFINER + `search_path`). Appelée via
-- supabase-js clé service_role → PostgREST l'exécute comme `service_role`, qui n'a
-- PAS le privilège CREATE sur le schéma `public` → le `CREATE MATERIALIZED VIEW
-- ..._rebuild` échoue en `42501 permission denied for schema public` → rollback de
-- la transaction PL/pgSQL → la matview reste collée à l'OID de l'ANCIENNE table
-- (`rpps_previous` après le swap RPPS) = données périmées servies + bombe OID
-- ARMÉE (le DROP CASCADE du prochain swap la détruit → `42P01`).
--
-- PROUVÉ PROD : run #27003446829 (2026-06-05), status `partial`,
-- `error_message = "post-swap finess_hosted_activities rebuild (42501): permission
-- denied for schema public"`, `pg_depend(finess_hosted_activities)` → `rpps_previous`.
-- C'était le 1er cron RPPS depuis la migration `20260523T100557` qui a câblé ce
-- rebuild — défaut jamais exécuté avant aujourd'hui (omission copier-coller du
-- SECURITY DEFINER vs les jumelles).
--
-- FIX : recréer la fonction à l'identique (corps byte-identique au SELECT canonique
-- de la matview — garde-fou `finess-hosted-activities-rebuild.test.ts`), en ajoutant
-- `SECURITY DEFINER` + `SET search_path = public, extensions`. Owner = `postgres`
-- (owner du schéma + de la matview) → le CREATE réussit. Lockdown REVOKE PUBLIC /
-- GRANT service_role conservé (obligatoire pour une fonction SECURITY DEFINER).
-- IDEMPOTENT : CREATE OR REPLACE.
--
-- Le re-pointage de la matview sur `rpps` (désamorçage de la bombe) est fait par un
-- appel `SELECT ingest_rebuild_finess_hosted_activities()` post-migration (hors fichier).

CREATE OR REPLACE FUNCTION ingest_rebuild_finess_hosted_activities()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '10min'
AS $$
BEGIN
  -- DROP la matview obsolète (collée à l'ancien OID des tables swappées)
  DROP MATERIALIZED VIEW IF EXISTS finess_hosted_activities_rebuild;

  -- CREATE la nouvelle (résolue PAR NOM, donc liée aux OIDs actuels).
  -- ⚠️ Corps DOIT être byte-identique au SELECT canonique ci-dessus —
  -- garde-fou : finess-hosted-activities-rebuild.test.ts.
  CREATE MATERIALIZED VIEW finess_hosted_activities_rebuild AS
  WITH bio AS (
    SELECT r.num_finess
    FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
    WHERE f.categorie_code NOT IN ('610','611','612')
      AND ( r.savoir_faire_libelle ILIKE 'Biologie médicale%'
            OR r.savoir_faire_libelle ILIKE 'Anatomie et cytologie%'
            OR r.profession_libelle = 'Technicien de Laboratoire' )
    GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
  ),
  pharma AS (
    SELECT r.num_finess
    FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
    WHERE f.categorie_code NOT IN ('620','627','628','629','610','611','612','300','330','132')
      AND r.profession_libelle = 'Pharmacien'
    GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
  ),
  img AS (
    SELECT r.num_finess
    FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
    WHERE f.categorie_code IS DISTINCT FROM '619'
      AND ( r.profession_libelle = 'Manipulateur ERM'
            OR r.savoir_faire_libelle ILIKE 'Radio-diagnostic%'
            OR r.savoir_faire_libelle ILIKE 'Radiologie et imagerie%' )
    GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
  ),
  unioned AS (
    SELECT num_finess, 'biologie'::text AS activite FROM bio
    UNION ALL
    SELECT num_finess, 'pharmacie'::text FROM pharma
    UNION ALL
    SELECT num_finess, 'imagerie'::text FROM img
  ),
  grouped AS (
    SELECT num_finess, array_agg(activite ORDER BY activite)::text[] AS activites
    FROM unioned GROUP BY num_finess
  )
  SELECT
    g.num_finess,
    g.activites,
    f.raison_sociale,
    f.categorie_code,
    f.categorie_libelle,
    f.code_departement,
    f.code_insee,
    f.geom,
    f.geog
  FROM grouped g
  JOIN finess f ON f.num_finess = g.num_finess;

  -- Indexes sur la _rebuild (avant le rename atomique)
  CREATE UNIQUE INDEX finess_hosted_activities_rebuild_pkey
    ON finess_hosted_activities_rebuild (num_finess);
  CREATE INDEX finess_hosted_activities_rebuild_activites_gin
    ON finess_hosted_activities_rebuild USING GIN (activites);
  CREATE INDEX finess_hosted_activities_rebuild_geog_gist
    ON finess_hosted_activities_rebuild USING GIST (geog);
  CREATE INDEX finess_hosted_activities_rebuild_code_dept
    ON finess_hosted_activities_rebuild (code_departement);
  CREATE INDEX finess_hosted_activities_rebuild_code_insee
    ON finess_hosted_activities_rebuild (code_insee);

  GRANT SELECT ON finess_hosted_activities_rebuild TO anon, authenticated, service_role;

  -- RENAME atomique (1 transaction PL/pgSQL)
  DROP MATERIALIZED VIEW IF EXISTS finess_hosted_activities;
  ALTER MATERIALIZED VIEW finess_hosted_activities_rebuild
    RENAME TO finess_hosted_activities;
  ALTER INDEX finess_hosted_activities_rebuild_pkey
    RENAME TO finess_hosted_activities_pkey;
  ALTER INDEX finess_hosted_activities_rebuild_activites_gin
    RENAME TO finess_hosted_activities_activites_gin;
  ALTER INDEX finess_hosted_activities_rebuild_geog_gist
    RENAME TO finess_hosted_activities_geog_gist;
  ALTER INDEX finess_hosted_activities_rebuild_code_dept
    RENAME TO finess_hosted_activities_code_dept;
  ALTER INDEX finess_hosted_activities_rebuild_code_insee
    RENAME TO finess_hosted_activities_code_insee;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_rebuild_finess_hosted_activities FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_rebuild_finess_hosted_activities TO service_role;

COMMENT ON FUNCTION ingest_rebuild_finess_hosted_activities IS
  'Rebuild post-swap (RPPS ou FINESS) de la matview finess_hosted_activities. Pattern OID — JAMAIS REFRESH. SECURITY DEFINER (owner postgres) — REQUIS : le CREATE MATERIALIZED VIEW exige CREATE sur public, refusé à service_role (42501) en SECURITY INVOKER, prouvé prod run #27003446829. Hooké dans scripts/ingest/{rpps,finess}.ts post-swap.';
