-- V0.4 phase 1 — Ameli staging RPC.
-- Drops + recreates `annuaire_ameli_staging` with a schema identical to the
-- prod `annuaire_ameli` table. The atomic swap then renames staging → prod
-- preserving every index, RLS policy, and grant.
--
-- SECURITY DEFINER mirrors the FINESS staging RPC: Supabase removed direct
-- CREATE TABLE on `public` for service_role, so the DDL runs with the owner
-- (postgres) privileges. The function does no caller input, so injection is
-- not a concern.

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

  ALTER TABLE annuaire_ameli_staging ENABLE ROW LEVEL SECURITY;
  -- MUST mirror the prod policy name + USING clause exactly so the swap
  -- rename keeps anon SELECT working. Service_role bypasses RLS for ingest.
  CREATE POLICY "anon read annuaire_ameli" ON annuaire_ameli_staging
    FOR SELECT TO anon USING (true);

  -- Tell PostgREST about the new staging table immediately so the first
  -- INSERT doesn't race the schema-cache reload (FINESS V0.2 lesson).
  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_annuaire_ameli_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_annuaire_ameli_staging TO service_role;

NOTIFY pgrst, 'reload schema';
