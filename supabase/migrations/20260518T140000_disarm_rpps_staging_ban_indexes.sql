-- DÉSAMORÇAGE 2026-05-18 — bombe à retardement du cron RPPS mensuel (`main`).
--
-- CONTEXTE. Pendant le GATE prod de la feature `feat/rpps-ban-geocoding`
-- (NON mergée), des migrations de la branche ont été appliquées MANUELLEMENT
-- en prod, dont `20260517T120000` + `20260517T130000` qui ont remplacé
-- `ingest_create_rpps_staging` par un superset créant 2 index fonctionnels
-- BAN Unicode-lourds sur `rpps_staging` :
--   `rpps_staging_ban_eligible_normkey_idx`     (rpps_address_key_for_index(...))
--   `rpps_staging_ban_eligible_normkey_id_idx`  (rpps_address_key_for_index(...), id)
-- Le pipeline d'ingestion RPPS de `main` (cron `ingest-rpps.yml`, le 5 de
-- chaque mois) appelle cette fonction puis fait `ingest_apply_rpps_finess_
-- enrichment_batch` (UPDATE de masse sur `rpps_staging`, posant geom /
-- geom_source / code_insee). Ces colonnes sont à la fois dans le prédicat
-- partiel ET la maintenance d'expression des 2 index BAN → recalcul de la
-- normalisation Unicode `rpps_address_key_for_index(...)` par ligne updatée
-- × centaines de milliers → dépasse `statement_timeout` → SQLSTATE 57014 en
-- phase `validate`, AVANT le swap atomique (données `rpps` jamais touchées).
-- PROUVÉ : run GitHub Actions #26029698016 (2026-05-18, échec ~57 min,
-- error_phase=validate). Dernier cron `main` réussi = 2026-05-09, AVANT
-- application prod du superset BAN.
--
-- CORRECTION. Restaurer `ingest_create_rpps_staging` à la dernière
-- définition de `main` = `20260516T020000_drop_rpps_insee_idx.sql:32-117`
-- (dette #3), recopié VERBATIM ci-dessous. Recopier 20260516T020000 plutôt
-- que « la version prod MOINS 2 lignes » est la SEULE option correcte : le delta
-- feat `20260516T050000` avait re-créé `rpps_staging_insee_idx`
-- mono-colonne, retiré exprès en dette #3 — un patch chirurgical de la
-- version prod le ré-introduirait silencieusement.
-- Vérifié : `20260516T030000` (postérieure sur main) ne redéfinit PAS cette
-- fonction (CREATE INDEX IF NOT EXISTS trgm idempotents, même expression
-- `lower(nom) extensions.gin_trgm_ops` que le mirror ci-dessous + réécriture
-- de la RPC `rpps_search_by_name`). Donc cette définition reste la
-- référence `main` exacte ; `rpps_search_by_name` n'est pas régressé.
--
-- POINT CONTRE-INTUITIF (à comprendre avant d'appliquer). La prod a
-- aujourd'hui `rpps_geog_precise_gist` (partiel, Phase 1 BAN) et PAS
-- `rpps_geog_gist` (global, droppé par `20260516T050000`). Cette définition
-- crée `rpps_staging_geog_gist` GLOBAL (pas le partiel). Au PREMIER cron
-- réussi post-fix, le swap RENAME fera donc revenir `rpps_geog_gist` global
-- et DISPARAÎTRE `rpps_geog_precise_gist` : retour propre et VOULU à l'état
-- `main` / V0.10.2. Aucun consommateur `main` ne dépend d'un GiST sur
-- `rpps` (`rpps_in_radius` v0.10.8 passe par la matview
-- `rpps_commune_centroids` + `rpps_insee_id_idx`). Idem,
-- `rpps_profession_savoir_faire_partial_idx` (dans cette def, absent de la
-- prod faute de swap réussi depuis le 9 mai) sera matérialisé par ce 1er
-- cron : réconciliation bénigne, pas une régression.
--
-- HORS DE CE FICHIER — points opérationnels (lus par l'ops, NON couverts
-- par le guard automatique) :
--   (a) Le timeout 57014 du cron est désamorcé par la SEULE restauration de
--       la staging-create ci-dessous : l'UPDATE de masse FINESS qui le
--       déclenchait porte sur `rpps_staging` (recréée sans les 2 index BAN
--       à chaque cron). Les points (b)/(c) sont du nettoyage, pas le fix.
--   (b) Les 2 index BAN existent AUSSI sur la TABLE `rpps` (buildés
--       CONCURRENTLY pendant le GATE). On les retire par 2 `DROP INDEX
--       CONCURRENTLY` exécutés SÉPARÉMENT (non transactionnels, gotcha
--       Supavisor — hors de ce fichier transactionnel). Un oubli s'auto-
--       résout au 1er swap (l'ancienne `rpps` part en `rpps_previous_OLD`
--       puis `DROP ... CASCADE`). Après CHAQUE DROP CONCURRENTLY, vérifier
--       qu'aucun index `rpps_*ban_eligible_normkey*` ne reste INVALID (un
--       DROP CONCURRENTLY interrompu laisse un index invalide silencieux) :
--       `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid`.
--   (c) Le guard `staging-parity.test.ts` prouve le superset vs les
--       migrations VERSIONNÉES seulement — il est AVEUGLE aux index présents
--       en prod hors migration (précisément les 2 index BAN du GATE). Sa
--       verdeur ne dispense donc PAS de (b) ni d'un `\d rpps` de contrôle
--       en prod après application.
--
-- RÉVERSIBILITÉ. Re-armer la feature = ré-appliquer `20260517T120000` puis
-- `20260517T130000` — mais JAMAIS en replay brut (ré-introduirait la bombe) :
-- uniquement via le fix architectural (sortir la création des 2 index BAN
-- de `ingest_create_rpps_staging` vers un step dédié post-enrichment FINESS
-- / pré-énumération BAN), lors de la reprise de `feat/rpps-ban-geocoding`.
--
-- APPLICATION. Naming `YYYYMMDDThhmmss` → la CLI Supabase saute ce fichier
-- (`db reset` ne l'applique pas) : appliqué MANUELLEMENT en prod via le
-- canal psql pooler. `CREATE OR REPLACE` (signature `RETURNS VOID`
-- inchangée → pas de `DROP FUNCTION` requis), idempotent, rejouable.

CREATE OR REPLACE FUNCTION ingest_create_rpps_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  DROP TABLE IF EXISTS rpps_staging CASCADE;
  CREATE TABLE rpps_staging (
    id                       BIGSERIAL PRIMARY KEY,
    rpps_id                  TEXT         NOT NULL,
    identifiant_pp           TEXT,
    civilite                 TEXT,
    nom                      TEXT         NOT NULL,
    prenom                   TEXT         NOT NULL,
    profession_code          TEXT,
    profession_libelle       TEXT,
    categorie_code           TEXT,
    categorie_libelle        TEXT,
    savoir_faire_code        TEXT,
    savoir_faire_libelle     TEXT,
    mode_exercice_code       TEXT,
    mode_exercice_libelle    TEXT,
    num_finess               TEXT,
    num_finess_ej            TEXT,
    siret                    TEXT,
    siren                    TEXT,
    raison_sociale           TEXT,
    enseigne_commerciale     TEXT,
    secteur_activite_libelle TEXT,
    adresse                  TEXT,
    code_postal              CHAR(5),
    ville                    TEXT,
    code_departement         CHAR(3),
    code_insee               CHAR(5),
    telephone                TEXT,
    email                    TEXT,
    geom                     geometry(Point, 4326),
    geog                     GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
    geom_source              TEXT,
    raw                      JSONB,
    created_at               TIMESTAMPTZ  DEFAULT now()
  );
  CREATE INDEX rpps_staging_geog_gist            ON rpps_staging USING GIST (geog);
  CREATE INDEX rpps_staging_rpps_id_idx          ON rpps_staging (rpps_id);
  CREATE INDEX rpps_staging_dept_idx             ON rpps_staging (code_departement);
  CREATE INDEX rpps_staging_profession_idx       ON rpps_staging (profession_code);
  CREATE INDEX rpps_staging_mode_idx             ON rpps_staging (mode_exercice_code);
  CREATE INDEX rpps_staging_num_finess_idx       ON rpps_staging (num_finess);
  CREATE INDEX rpps_staging_savoir_faire_idx     ON rpps_staging (savoir_faire_code);
  -- `rpps_staging_insee_idx (code_insee)` SUPPRIMÉ — redondant avec le
  -- composite `rpps_staging_insee_id_idx (code_insee, id)` plus bas.
  CREATE INDEX rpps_staging_categorie_idx        ON rpps_staging (categorie_code);
  -- Composite indexes — must mirror prod so swap rename preserves them.
  CREATE INDEX rpps_staging_dept_profession_idx   ON rpps_staging (code_departement, profession_code);
  CREATE INDEX rpps_staging_dept_savoir_faire_idx ON rpps_staging (code_departement, savoir_faire_code);
  CREATE INDEX rpps_staging_dept_mode_idx         ON rpps_staging (code_departement, mode_exercice_code);
  CREATE INDEX rpps_staging_dept_categorie_idx    ON rpps_staging (code_departement, categorie_code);
  CREATE INDEX rpps_staging_dept_insee_sort_idx   ON rpps_staging (code_departement, code_insee, nom, prenom, id);
  CREATE INDEX rpps_staging_pending_enrichment_idx ON rpps_staging (id)
    WHERE geom IS NULL AND num_finess IS NOT NULL AND geom_source IS NULL;
  CREATE INDEX rpps_staging_geom_source_idx       ON rpps_staging (geom_source);
  -- V0.10.2 — mirror des index prod ajoutés après 20260510T020000 (sinon
  -- perdus au swap mensuel). Trigram : `rpps_search_by_name`. Partiel :
  -- `lister_specialites_medicales` / `rpps_par_specialite_dept`. Composite
  -- (code_insee, id) : early-stop déterministe du LATERAL rpps_in_radius
  -- (sans lui, P0 57014 régresse sur commune dense au prochain swap).
  CREATE INDEX rpps_staging_nom_trgm_idx
    ON rpps_staging USING GIN (lower(nom) extensions.gin_trgm_ops);
  CREATE INDEX rpps_staging_prenom_trgm_idx
    ON rpps_staging USING GIN (lower(prenom) extensions.gin_trgm_ops);
  CREATE INDEX rpps_staging_profession_savoir_faire_partial_idx
    ON rpps_staging (profession_code, savoir_faire_code)
    WHERE savoir_faire_code IS NOT NULL;
  CREATE INDEX rpps_staging_insee_id_idx
    ON rpps_staging (code_insee, id);

  ALTER TABLE rpps_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read rpps" ON rpps_staging FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_rpps_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_rpps_staging TO service_role;

COMMENT ON FUNCTION ingest_create_rpps_staging IS
  'Desamorcage 2026-05-18 : corps = recopie verbatim de 20260516T020000 (derniere def main, dette #3). Volontairement SANS les 2 index fonctionnels BAN Unicode-lourds (rpps_staging_ban_eligible_normkey_idx / _id_idx) qui, crees par le delta feat non merge, faisaient timeouter (57014) l enrichment FINESS du cron RPPS mensuel (run #26029698016). Cree rpps_staging_geog_gist GLOBAL : au 1er swap post-fix, rpps_geog_precise_gist (cree par le delta feat sur la table rpps) disparait et rpps_geog_gist global revient = retour voulu a l etat main. Les 2 index BAN encore presents sur la table rpps sont droppes hors de ce fichier (CONCURRENTLY, separe).';
