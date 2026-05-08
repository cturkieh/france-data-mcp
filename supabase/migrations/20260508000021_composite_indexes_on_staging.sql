-- V0.4.1 fix-crit.1 — Re-définir les staging RPCs avec les indexes composites.
--
-- Race condition silencieuse identifiée par l'audit 2026-05-08 (silent-failure-hunter) :
-- la migration 20260508000019 crée les composite indexes directement sur les
-- tables prod (`annuaire_ameli`, `finess`). Mais le pipeline d'ingestion suit
-- le pattern :
--   1. `ingest_create_*_staging` → recrée DROP TABLE + CREATE TABLE staging
--   2. INSERT … staging
--   3. `ingest_atomic_swap` → renomme staging → prod, dropant l'ancienne prod
--
-- Au prochain ingest hebdo (Ameli) ou bimestriel (FINESS), la nouvelle prod
-- table est issue du staging — qui n'avait pas les composite indexes →
-- les SQL 57014 timeouts (Charleville T2) reviennent silencieusement, sans
-- log, sans message, sans erreur de migration.
--
-- Fix : redéfinir les deux staging RPCs en ajoutant les composite indexes
-- sur la staging table. Le swap les renomme `finess_*` / `annuaire_ameli_*`
-- automatiquement (pattern atomic_swap).

-- ──────────────────────────────────────────────────────────────────────────
-- (1) FINESS staging — ajoute (code_departement, categorie_code) + (code_insee, categorie_code)
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ingest_create_finess_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  DROP TABLE IF EXISTS finess_staging CASCADE;
  CREATE TABLE finess_staging (
    num_finess          CHAR(9)      PRIMARY KEY,
    raison_sociale      TEXT         NOT NULL,
    categorie_code      VARCHAR(4),
    categorie_libelle   TEXT,
    num_voie            VARCHAR(10),
    type_voie           VARCHAR(50),
    voie                TEXT,
    code_postal         CHAR(5),
    code_departement    CHAR(3)      NOT NULL,
    code_insee          CHAR(5)      NOT NULL,
    ville               TEXT,
    telephone           VARCHAR(20),
    email               TEXT,
    date_ouverture      DATE,
    date_maj            DATE,
    geom                geometry(Point, 4326),
    geog                GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
    raw                 JSONB,
    created_at          TIMESTAMPTZ  DEFAULT now()
  );
  CREATE INDEX finess_staging_geom_gist           ON finess_staging USING GIST (geom);
  CREATE INDEX finess_staging_geog_gist           ON finess_staging USING GIST (geog);
  CREATE INDEX finess_staging_categorie_idx       ON finess_staging (categorie_code);
  CREATE INDEX finess_staging_code_dept_idx       ON finess_staging (code_departement);
  CREATE INDEX finess_staging_code_insee_idx      ON finess_staging (code_insee);
  -- v0.4.1 composite indexes — survive the swap
  CREATE INDEX finess_staging_dept_categorie_idx  ON finess_staging (code_departement, categorie_code);
  CREATE INDEX finess_staging_insee_categorie_idx ON finess_staging (code_insee, categorie_code);

  ALTER TABLE finess_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read finess" ON finess_staging FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_finess_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_finess_staging TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- (2) Ameli staging — ajoute (code_departement, specialite_code) + (code_departement, type_ps_code)
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ingest_create_annuaire_ameli_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  DROP TABLE IF EXISTS annuaire_ameli_staging CASCADE;
  CREATE TABLE annuaire_ameli_staging (
    id                            BIGSERIAL    PRIMARY KEY,
    nom                           TEXT         NOT NULL,
    prenom                        TEXT         NOT NULL,
    civilite                      TEXT,
    raison_sociale                TEXT,
    specialite_code               TEXT,
    specialite_libelle            TEXT,
    type_ps_code                  TEXT,
    type_ps_libelle               TEXT,
    activite_particuliere_code    TEXT,
    activite_particuliere_libelle TEXT,
    adresse                       TEXT,
    code_postal                   CHAR(5),
    ville                         TEXT,
    code_departement              CHAR(3)      NOT NULL,
    code_insee                    CHAR(5),
    secteur_conventionnel_code    TEXT,
    secteur_conventionnel_libelle TEXT,
    nature_exercice_code          TEXT,
    nature_exercice_libelle       TEXT,
    option_tarifaire_code         TEXT,
    option_tarifaire_libelle      TEXT,
    telephone                     TEXT,
    geom                          geometry(Point, 4326),
    geog                          GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
    raw                           JSONB,
    created_at                    TIMESTAMPTZ  DEFAULT now()
  );
  CREATE INDEX annuaire_ameli_staging_geog_gist      ON annuaire_ameli_staging USING GIST (geog);
  CREATE INDEX annuaire_ameli_staging_dept_idx       ON annuaire_ameli_staging (code_departement);
  CREATE INDEX annuaire_ameli_staging_specialite_idx ON annuaire_ameli_staging (specialite_code);
  CREATE INDEX annuaire_ameli_staging_type_ps_idx    ON annuaire_ameli_staging (type_ps_code);
  CREATE INDEX annuaire_ameli_staging_insee_idx      ON annuaire_ameli_staging (code_insee);
  -- v0.4.1 composite indexes — survive the swap
  CREATE INDEX annuaire_ameli_staging_dept_spec_idx  ON annuaire_ameli_staging (code_departement, specialite_code);
  CREATE INDEX annuaire_ameli_staging_dept_type_idx  ON annuaire_ameli_staging (code_departement, type_ps_code);

  ALTER TABLE annuaire_ameli_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read annuaire_ameli" ON annuaire_ameli_staging
    FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_annuaire_ameli_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_annuaire_ameli_staging TO service_role;

NOTIFY pgrst, 'reload schema';
