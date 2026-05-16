-- Dette #3 (backlog Robustesse / ops, 2026-05-16) — suppression de l'index
-- mono-colonne `rpps_insee_idx (code_insee)`, rendu REDONDANT par l'ajout du
-- composite `rpps_insee_id_idx (code_insee, id)` (migration
-- 20260515T030000, V0.10.2). Un B-tree composite à préfixe `code_insee`
-- couvre tout prédicat / tri que servait l'index mono-colonne (égalité,
-- range et ORDER BY sur la colonne de tête) ; garder les deux ne fait que
-- doubler le coût d'écriture/maintenance sur 2,23 M lignes sans bénéfice de
-- lecture. Opération ops dédiée, zéro urgence, hors P0.
--
-- Vérifié : aucun chemin de requête ne dépend du NOM de l'index (Postgres
-- n'a pas de hint d'index ; le planner choisit `rpps_insee_id_idx` pour
-- `WHERE code_insee = X`). Les anciens commentaires WHY de
-- `count_rpps_by_commune` / `rpps_par_specialite_dept` qui le citaient sont
-- des notes historiques, pas des dépendances.
--
-- ── PARITÉ STAGING (NON NÉGOCIABLE) ───────────────────────────────────────
-- Le swap mensuel fait `rpps_staging` → `rpps` (RENAME). Si on se contentait
-- du DROP côté prod sans retirer l'index équivalent de
-- `ingest_create_rpps_staging`, le prochain ingest le RE-CRÉERAIT (renommé)
-- → le DROP serait silencieusement annulé au swap suivant. On recrée donc la
-- staging-create en SUPERSET STRICT de la précédente (20260515T030000) MOINS
-- le seul index `(code_insee)` mono-colonne, en conservant le composite
-- `(code_insee, id)`. Garde-fou : `scripts/ingest/staging-parity.test.ts`
-- (généralisé pour honorer DROP INDEX par nom, sinon faux négatif).

DROP INDEX IF EXISTS rpps_insee_idx;

-- Reproduction verbatim de la staging-create 20260515T030000, à l'identique
-- SAUF la ligne `rpps_staging_insee_idx` mono-colonne (retirée) — le
-- composite `rpps_staging_insee_id_idx (code_insee, id)` reste, miroir exact
-- du `rpps_insee_id_idx` prod conservé.
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
  'Dette #3 (2026-05-16) — superset de 20260515T030000 MOINS l index mono-colonne (code_insee) redondant (composite (code_insee, id) conservé). Le swap mensuel ne ré-introduit donc plus rpps_insee_idx.';
