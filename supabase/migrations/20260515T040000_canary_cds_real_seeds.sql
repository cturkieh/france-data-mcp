-- V0.10.3 — Seed des cibles canary réelles pour la source `cds`.
--
-- Fait suite à `20260515T010200_canary_cds_extension.sql` qui a étendu le
-- RPC `check_ingest_canary` à `cds` SANS seeder de cibles (délibéré : on ne
-- connaissait pas encore les `etab_finess` réels avant la 1ère ingestion
-- CNAM). La 1ère ingestion réelle a réussi le 2026-05-15 (run GH
-- 25929550424, 3550 CDS en prod), on peut donc poser des cibles stables.
--
-- Critères de sélection (vérifiés en prod via le serveur MCP + table
-- `centres_sante`/`finess` le 2026-05-15) :
-- 1. Centres municipaux (CMS/CSM) : gérés par des collectivités, conventionnés
--    Sécu de façon pérenne — probabilité de radiation/fermeture très faible
--    sur l'horizon de vie de cette migration (≠ CDS privés volatils).
-- 2. Doublement ancrés : présents à la fois dans `centres_sante` (annuaire
--    CNAM) ET dans `finess` (extrait DREES géocodé) — robustes aux deux
--    pipelines, et le canary teste implicitement le pivot FINESS nominal.
-- 3. Couverture géographique : 5 départements distincts (02, 10, 11, 16, 19)
--    → une régression d'ingestion ciblée sur un seul périmètre est détectée.
-- 4. Aucun placeholder à purger (l'extension V0.10 n'en a jamais seedé) →
--    migration = INSERT pur idempotent.
--
-- Idempotente : ré-application sûre via ON CONFLICT DO NOTHING (PK =
-- (source, key_type, key_value)). Le `description` documente l'identité
-- publique (nom + commune) pour qu'un futur opérateur vérifie en 30 s via
-- l'annuaire ameli si un canary missing remonte (CDS fermé, déconventionné,
-- ou num_finess CNAM modifié à l'amont).

INSERT INTO ingest_canary_targets (source, key_type, key_value, description)
VALUES
  (
    'cds', 'etab_finess', '020017141',
    'CSM Municipal de Coucy-le-Château-Auffrique (02) — INSEE 02217. Municipal, ancré finess+centres_sante.'
  ),
  (
    'cds', 'etab_finess', '100010248',
    'Centre Municipal de Santé de Nogent-sur-Seine (10) — INSEE 10268. Municipal, ancré finess+centres_sante.'
  ),
  (
    'cds', 'etab_finess', '110007069',
    'Centre de Santé Médical Municipal de Port-la-Nouvelle (11) — INSEE 11266. Municipal, ancré finess+centres_sante.'
  ),
  (
    'cds', 'etab_finess', '160016903',
    'Centre de Santé Municipal de Cognac (16) — INSEE 16102. Municipal, ancré finess+centres_sante.'
  ),
  (
    'cds', 'etab_finess', '190013383',
    'Centre de Santé Municipal de la Ville de Tulle (19) — INSEE 19272. Municipal, ancré finess+centres_sante.'
  )
ON CONFLICT (source, key_type, key_value) DO NOTHING;

NOTIFY pgrst, 'reload schema';
