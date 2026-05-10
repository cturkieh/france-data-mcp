-- V0.5.6 — remplace les 3 IDNPS placeholder du seed canary RPPS V0.5.0
-- (`20260509T200500_canary_seed_rpps.sql`) par 3 IDNPS référents stables
-- vérifiés en prod via le serveur MCP france-data-mcp le 2026-05-10.
--
-- Critères de sélection :
-- 1. PS publiquement identifiables dans l'Annuaire Santé ANS libre accès
--    (https://annuaire.sante.fr — l'IDNPS est une donnée publique par
--    design de la nomenclature ANS).
-- 2. Couverture géographique : 1 PS métropole IDF (75) + 1 PS région
--    Provence (13) + 1 PS DOM Réunion (974) — vérifie que le canary détecte
--    une régression d'ingestion ciblée sur un seul périmètre géographique.
-- 3. Couverture professionnelle : 1 Médecin (code 10) + 1 Infirmier (code 60)
--    + 1 Pharmacien (code 21) — les 3 plus grosses populations RPPS.
-- 4. Stabilité estimée : PS rattachés à des structures établies (CHU public,
--    CH intercommunal, officine titulaire) — probabilité de radiation faible
--    sur l'horizon de vie de cette migration.
-- 5. Catégorie professionnelle Civil (`C`) pour les 3 — aligné sur le
--    default V0.5.5 du filtre `categorieCodes` (helper `buildCategorieCodes`).
--    Sourcing d'un PS Agent public (`M`) pour étendre la couverture est
--    backloggé — aucun candidat M trouvé via le sample MCP du 2026-05-10.
--
-- Ordre INSERT puis DELETE (et non l'inverse) pour éliminer toute fenêtre
-- où la table serait vide pour `source='rpps'` : si un cron RPPS tombe
-- pendant la migration, il voit au pire les 3 placeholders missing
-- (comportement baseline V0.5.5), jamais une table vide qui retournerait
-- silencieusement `[]` (canary actif désactivé sans warning). Idempotente :
-- ré-application sûre via ON CONFLICT DO NOTHING + DELETE qui matche 0 row
-- la 2e fois.

-- 1. Insertion des 3 IDNPS référents stables EN PREMIER (defense en
--    profondeur contre le silent-canary-disable décrit en tête).
--    Format observé en prod : 12 chiffres (préfixe `81` = Type d'identifiant
--    PP nomenclature TRE_G08 ANS, suivi de 10 chiffres IDNPS). Le tool MCP
--    `professionnel_by_rpps` accepte 11 ou 12 chiffres pour rétrocompat
--    avec d'anciens IDs sans préfixe.
--    Les colonnes `description` documentent l'identité publique pour qu'un
--    futur opérateur puisse vérifier en 30 secondes via annuaire.sante.fr
--    si un canary missing remonte (ex: profession changée, radiation, etc.).
INSERT INTO ingest_canary_targets (source, key_type, key_value, description)
VALUES
  (
    'rpps', 'rpps_id', '810005156566',
    'Dr Cristina ABABEI, Médecin Psychiatre, GHU Paris (FINESS 750802514 / 750015109) — dept 75. Civil, multi-sites public stable.'
  ),
  (
    'rpps', 'rpps_id', '810102839510',
    'Marguerite ABBAS MOUSSA, Infirmière, CHI Aix-en-Provence (FINESS 130000409) — dept 13. Civil, CH intercommunal public.'
  ),
  (
    'rpps', 'rpps_id', '810108485847',
    'Juliette BLANCHARD, Pharmacien, Pharmacie Durand Les Avirons (FINESS 970465340) — dept 974 La Réunion. Civil, officine titulaire DOM.'
  )
ON CONFLICT (source, key_type, key_value) DO NOTHING;

-- 2. Purge des 3 placeholders V0.5.0 EN SECOND, après que les référents
--    stables soient en place. DELETE explicite sur les key_value historiques
--    (pas de truncation — d'autres seeds futurs cohabiteront, voir
--    `ingest_canary_targets` partagé avec FINESS / Ameli).
--    ⚠️ Si V0.5.0 (`20260509T200500_canary_seed_rpps.sql`) est modifiée
--    rétroactivement avec d'autres placeholder values, mettre à jour la
--    liste IN ci-dessous — sinon les anciennes valeurs persistent à côté
--    des nouveaux seeds après cette migration.
--
--    Bloc DO + RAISE NOTICE pour tracer dans les logs Supabase combien de
--    rows ont été purgées (attendu : 3 au 1er run, 0 si ré-application).
--    Une valeur intermédiaire (1 ou 2) signale un ré-seed manuel partiel
--    pré-migration → l'opérateur investigue via les logs sans bloquer le
--    déploiement (pas de RAISE EXCEPTION : un canary swap bloqué pour
--    cause cosmétique aurait un coût plus élevé que le bénéfice).
DO $$
DECLARE
  purged_count INT;
BEGIN
  WITH purged AS (
    DELETE FROM ingest_canary_targets
    WHERE source = 'rpps'
      AND key_type = 'rpps_id'
      AND key_value IN (
        '81000964799',  -- placeholder mid-spectrum V0.5.0 (11 chars sentinel)
        '00000000001',  -- placeholder bas de spectre
        '99999999999'   -- placeholder haut de spectre
      )
    RETURNING key_value
  )
  SELECT count(*) INTO purged_count FROM purged;

  RAISE NOTICE '[v0.5.6 canary] purged % placeholder rows from V0.5.0 (expected 3 at first apply, 0 on re-apply)', purged_count;

  IF purged_count NOT IN (0, 3) THEN
    RAISE WARNING '[v0.5.6 canary] purged % rows but expected 0 or 3 — possible manual re-seed of placeholders pre-migration, investigate', purged_count;
  END IF;
END $$;
