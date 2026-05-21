-- Chantier C — Géocodage Ameli. Cf. docs/plans/ameli-geocoding.md.
--
-- 1/3 : ajoute `geom_source` à `annuaire_ameli` + GiST PARTIEL sur la branche
-- `ban_address`. Jumeau de la disposition RPPS prouvée prod 2026-05-19 (cf.
-- migration 20260516T050000 + gotcha CLAUDE.md « GiST partiel découplé »).
--
-- POURQUOI un GiST PARTIEL et non un GiST global :
-- - La branche "precise" des tools de radius filtre `WHERE geom_source =
--   'ban_address'` (futur clone du pattern `rpps_in_radius` precise). Un GiST
--   GLOBAL ferait remonter TOUTES les rows du bbox, puis filtrerait
--   `geom_source` en Filter post-index → cluster co-localisé `commune_centroid`
--   ramené pour rien → 57014 en zone dense (post-mortem RPPS 2026-05-19).
-- - Le PARTIEL n'indexe QUE les rows BAN (~150 K post-backfill), élague côté
--   index avant le bbox scan. Coût maintenance proportionnel au sous-ensemble.
--
-- IDÉMPOTENCE : ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. Le
-- backfill `UPDATE ... WHERE geom_source IS NULL` est lui aussi idempotent
-- (no-op après le 1er run).
--
-- APPLICATION : naming `YYYYMMDDThhmmss` → CLI Supabase saute ce fichier
-- (db reset ne l'applique pas en local). Appliquée MANUELLEMENT en prod via
-- le dashboard SQL editor (canal validé V0.12.3, cf. CLAUDE.md).

-- ───────────────────────────────────────────────────────────────────────────
-- (1) Colonne `geom_source` — TRANSACTION pour atomicité ADD + UPDATE +
--     CHECK + NOT NULL (silent-failure hunter M-4 Passe 1). Sans BEGIN/COMMIT,
--     un INSERT concurrent (cron Ameli hebdo manuellement redéclenché pendant
--     l'apply) entre l'UPDATE bulk et l'ALTER NOT NULL créerait une row NULL
--     → l'ALTER NOT NULL throw → état schéma indéfini (colonne ADD-ée sans
--     CHECK, sans NOT NULL, sans DEFAULT). Wrapper en transaction rend
--     l'apply tout-ou-rien : un retry après échec rejoue verbatim, idempotent.
-- ───────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE annuaire_ameli
  ADD COLUMN IF NOT EXISTS geom_source TEXT;

-- Initialiser les rows existantes : tout est au centroïde commune aujourd'hui
-- (cf. `scripts/ingest/ameli.ts` parseAmeliRecord — geom = matched.lon/lat
-- depuis l'index commune). `UPDATE ... WHERE geom_source IS NULL` = idempotent.
UPDATE annuaire_ameli
   SET geom_source = 'commune_centroid'
 WHERE geom_source IS NULL;

-- CHECK + NOT NULL APRÈS l'initialisation (sinon l'ALTER NOT NULL échouerait
-- sur les rows existantes pré-fix). Le DO guardé évite l'erreur si déjà posé.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'annuaire_ameli_geom_source_check'
      AND conrelid = 'annuaire_ameli'::regclass
  ) THEN
    ALTER TABLE annuaire_ameli
      ADD CONSTRAINT annuaire_ameli_geom_source_check
      CHECK (geom_source IN ('commune_centroid', 'ban_address'));
  END IF;
END$$;

ALTER TABLE annuaire_ameli ALTER COLUMN geom_source SET NOT NULL;
ALTER TABLE annuaire_ameli ALTER COLUMN geom_source SET DEFAULT 'commune_centroid';

COMMIT;

COMMENT ON COLUMN annuaire_ameli.geom_source IS
  'Chantier C 2026-05-21 — provenance des coordonnées : ''commune_centroid'' (repli ~3 km, posé à l''ingestion via matchCommune sur geo.api.gouv) ou ''ban_address'' (adresse précise BAN, posée par ingest_apply_ameli_ban_join_batch depuis le cache geocoded_addresses partagé avec RPPS). Le GiST PARTIEL annuaire_ameli_geog_precise_gist couvre exclusivement ban_address — un GiST global re-régresserait la branche precise des tools radius (cf. gotcha CLAUDE.md ban_join RPPS post-mortem 2026-05-19).';

-- ───────────────────────────────────────────────────────────────────────────
-- (2) GiST PARTIEL sur la branche precise
-- ───────────────────────────────────────────────────────────────────────────
-- Le prédicat `WHERE geom_source = 'ban_address'` doit être BYTE-IDENTIQUE
-- entre cet index et la future RPC `professionnels_in_radius`/etc. branche
-- precise (sinon planner inapplicable). Pas de garde-fou texte aujourd'hui
-- côté Ameli (à ajouter avec les modifs tools — task #11).
CREATE INDEX IF NOT EXISTS annuaire_ameli_geog_precise_gist
  ON annuaire_ameli USING GIST (geog)
  WHERE geom_source = 'ban_address';

COMMENT ON INDEX annuaire_ameli_geog_precise_gist IS
  'Chantier C 2026-05-21 — GiST PARTIEL sur les rows géocodées BAN (precise). Jumeau de rpps_geog_precise_gist. Prédicat byte-identique aux call-sites des tools radius (branche precise). PAS de GiST global à côté : re-régresserait via Filter post-index (gotcha CLAUDE.md prouvé prod RPPS 2026-05-19). Coût maintenance proportionnel au sous-ensemble ban_address (~150 K post-backfill, vs 462 K total).';

NOTIFY pgrst, 'reload schema';
