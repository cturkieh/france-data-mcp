-- ROBUSTESSE MATVIEW/SWAP 2026-05-18 — 2e volet du désamorçage cron RPPS.
-- À appliquer CONJOINTEMENT avec 20260518T140000 (jamais l'un sans l'autre).
--
-- DÉFAUT (prouvé prod, lecture seule, 2026-05-18). Les 3 matviews RPPS
-- (`rpps_savoir_faire_stats`, `rpps_count_stats`, `rpps_commune_centroids`)
-- sont définies `... FROM rpps ...`. Une matview PostgreSQL référence sa
-- table source par OID, pas par nom. `ingest_atomic_swap('rpps')` fait une
-- rotation par RENAME : `rpps`→`rpps_previous`→`rpps_previous_OLD`→
-- `DROP ... CASCADE`. Le post-swap actuel se contente d'un REFRESH
-- (`ingest_refresh_matview`, REFRESH-only) :
--   - 1er cron réussi : les matviews suivent l'OID → collées à l'ancienne
--     table (désormais `rpps_previous`) → REFRESH recalcule depuis les
--     données AVANT le cron → désync SILENCIEUSE (status `success`) ;
--   - 2e cron réussi : l'ancienne table part en `rpps_previous_OLD` puis
--     `DROP ... CASCADE` → les 3 matviews DÉTRUITES → REFRESH `42P01`
--     avalé en `partial` → `rpps_in_radius` / `densite_professionnels_sante`
--     / `lister_specialites_medicales` DOWN jusqu'à recréation manuelle.
-- Jamais exercé (0 cron RPPS réussi depuis 2026-05-09) ; le désamorçage du
-- timeout 57014 (20260518T140000) refait réussir le cron → ARME la bombe.
--
-- CORRECTION. `ingest_rebuild_rpps_matviews()` RECONSTRUIT les 3 matviews
-- post-swap au lieu de les REFRESH. `CREATE MATERIALIZED VIEW ... FROM rpps`
-- résout `rpps` PAR NOM au moment du CREATE (post-swap = la NOUVELLE table)
-- → corrige À LA FOIS la désync du 1er cron ET la destruction du 2e (les
-- matviews sont re-liées au nouvel OID à chaque cron, jamais à celui qui
-- part en `_previous_OLD`). Le pipeline `scripts/ingest/rpps.ts` appelle
-- cette fonction post-swap à la place de `refreshRppsMatviews`.
--
-- BASCULE SANS FENÊTRE (build-new + RENAME). Pour chaque matview M :
-- construire `M_rebuild` (peuplée), ses index, son GRANT ; puis, DANS LA
-- MÊME TRANSACTION (corps PL/pgSQL), `DROP M` + `ALTER M_rebuild RENAME TO
-- M`. MVCC sérialise : un lecteur concurrent (`rpps_in_radius`) voit soit
-- l'ancienne M, soit la nouvelle, JAMAIS `42P01`. Le `DROP M` est SANS
-- CASCADE : si un objet dépend de M de façon inattendue, le DROP échoue →
-- la transaction rollback → l'ancienne M reste intacte et peuplée (juste
-- périmée) = dégradation gracieuse, PAS de destruction silencieuse (les
-- RPC `lister_savoir_faire_rpps`/`count_rpps`/`rpps_in_radius` résolvent la
-- matview au runtime → aucune dépendance catalogue → DROP simple suffit).
-- `M_rebuild` résiduel d'un run interrompu : `DROP ... IF EXISTS CASCADE`
-- en tête (objet jetable). Fonction idempotente, rejouable.
--
-- DÉFAUT SYMÉTRIQUE AMELI (NON corrigé ici — décision de périmètre).
-- `ameli_nomenclature_stats` (`FROM annuaire_ameli`, même `ingest_atomic_
-- swap`, même `refreshAmeliMatviews` REFRESH-only) a EXACTEMENT la même
-- bombe, masquée FORTUITEMENT par `shortCircuitIfSameChecksum` dans
-- `scripts/ingest/ameli.ts` (AVANT le swap : l'extract Ameli ne changeant
-- quasi jamais, le 2e swap consécutif n'a pas lieu). NON imminent →
-- backlog P1 (corriger Ameli par la même mécanique `ingest_rebuild_*`).
-- NE PAS « optimiser » ce short-circuit sans corriger Ameli d'abord.
--
-- PARITÉ DDL (anti-drift). Les SELECT ci-dessous sont la RECOPIE VERBATIM
-- des matviews canoniques (20260514T040000, 20260514T050000,
-- 20260515T030000). Gardé par `scripts/ingest/rpps-matview-rebuild.test.ts`
-- (compare le noyau SELECT normalisé) : un changement de définition d'une
-- matview canonique sans MAJ de cette fonction = test rouge avant merge.
--
-- APPLICATION. Naming `YYYYMMDDThhmmss` → la CLI Supabase saute ce fichier
-- (`db reset` ne l'applique pas) : appliqué MANUELLEMENT en prod via le
-- canal psql pooler, APRÈS 20260518T140000. `CREATE OR REPLACE` (signature
-- `RETURNS VOID` ; fonction nouvelle), idempotent, rejouable. Appliquer la
-- fonction ne modifie rien en prod tant que le cron ne l'exécute pas.

CREATE OR REPLACE FUNCTION ingest_rebuild_rpps_matviews()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '10min'
AS $$
BEGIN
  -- ── rpps_savoir_faire_stats ──────────────────────────────────────────
  DROP MATERIALIZED VIEW IF EXISTS rpps_savoir_faire_stats_rebuild CASCADE;
  CREATE MATERIALIZED VIEW rpps_savoir_faire_stats_rebuild AS
SELECT
  r.profession_code,
  r.savoir_faire_code,
  MAX(r.savoir_faire_libelle) AS savoir_faire_libelle,
  COUNT(*)::BIGINT AS count_ps
FROM rpps r
WHERE r.savoir_faire_code IS NOT NULL
  AND r.profession_code IS NOT NULL
GROUP BY r.profession_code, r.savoir_faire_code;
  CREATE UNIQUE INDEX rpps_savoir_faire_stats_rebuild_pk
    ON rpps_savoir_faire_stats_rebuild (profession_code, savoir_faire_code);
  CREATE INDEX rpps_savoir_faire_stats_rebuild_profession_idx
    ON rpps_savoir_faire_stats_rebuild (profession_code);
  GRANT SELECT ON rpps_savoir_faire_stats_rebuild TO anon;
  DROP MATERIALIZED VIEW IF EXISTS rpps_savoir_faire_stats;
  ALTER MATERIALIZED VIEW rpps_savoir_faire_stats_rebuild RENAME TO rpps_savoir_faire_stats;
  ALTER INDEX rpps_savoir_faire_stats_rebuild_pk RENAME TO rpps_savoir_faire_stats_pk;
  ALTER INDEX rpps_savoir_faire_stats_rebuild_profession_idx RENAME TO rpps_savoir_faire_stats_profession_idx;

  -- ── rpps_count_stats ─────────────────────────────────────────────────
  DROP MATERIALIZED VIEW IF EXISTS rpps_count_stats_rebuild CASCADE;
  CREATE MATERIALIZED VIEW rpps_count_stats_rebuild AS
SELECT
  r.code_departement,
  r.profession_code,
  r.savoir_faire_code,
  r.mode_exercice_code,
  r.categorie_code,
  COUNT(*)::BIGINT AS count_ps
FROM rpps r
GROUP BY
  r.code_departement,
  r.profession_code,
  r.savoir_faire_code,
  r.mode_exercice_code,
  r.categorie_code;
  CREATE UNIQUE INDEX rpps_count_stats_rebuild_pk
    ON rpps_count_stats_rebuild (
      profession_code,
      savoir_faire_code,
      mode_exercice_code,
      categorie_code,
      code_departement
    ) NULLS NOT DISTINCT;
  GRANT SELECT ON rpps_count_stats_rebuild TO anon;
  DROP MATERIALIZED VIEW IF EXISTS rpps_count_stats;
  ALTER MATERIALIZED VIEW rpps_count_stats_rebuild RENAME TO rpps_count_stats;
  ALTER INDEX rpps_count_stats_rebuild_pk RENAME TO rpps_count_stats_pk;

  -- ── rpps_commune_centroids ───────────────────────────────────────────
  DROP MATERIALIZED VIEW IF EXISTS rpps_commune_centroids_rebuild CASCADE;
  CREATE MATERIALIZED VIEW rpps_commune_centroids_rebuild AS
SELECT
  r.code_insee,
  ST_Centroid(ST_Collect(r.geom))::geography AS geog
FROM rpps r
WHERE r.geog IS NOT NULL
  AND r.code_insee IS NOT NULL
GROUP BY r.code_insee;
  CREATE UNIQUE INDEX rpps_commune_centroids_rebuild_pk
    ON rpps_commune_centroids_rebuild (code_insee);
  CREATE INDEX rpps_commune_centroids_rebuild_geog_gist
    ON rpps_commune_centroids_rebuild USING GIST (geog);
  GRANT SELECT ON rpps_commune_centroids_rebuild TO anon;
  DROP MATERIALIZED VIEW IF EXISTS rpps_commune_centroids;
  ALTER MATERIALIZED VIEW rpps_commune_centroids_rebuild RENAME TO rpps_commune_centroids;
  ALTER INDEX rpps_commune_centroids_rebuild_pk RENAME TO rpps_commune_centroids_pk;
  ALTER INDEX rpps_commune_centroids_rebuild_geog_gist RENAME TO rpps_commune_centroids_geog_gist;

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_rebuild_rpps_matviews FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_rebuild_rpps_matviews TO service_role;

COMMENT ON FUNCTION ingest_rebuild_rpps_matviews IS
  'Robustesse matview/swap 2026-05-18 : reconstruit (build-new + RENAME atomique) les 3 matviews RPPS post-swap au lieu de REFRESH. Corrige le suivi d OID (désync 1er cron + destruction CASCADE 2e cron) prouvé prod. Appelée par scripts/ingest/rpps.ts post-swap. Défaut symétrique Ameli = backlog P1 (masqué par shortCircuitIfSameChecksum).';
