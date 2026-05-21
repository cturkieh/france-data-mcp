-- Chantier C — Géocodage Ameli. Cf. docs/plans/ameli-geocoding.md.
--
-- 2/3 : recopie de `ingest_create_annuaire_ameli_staging` (dernière def
-- `20260514T090000` — 8 index : 5 base + 2 composites V0.4.1 + 1 covering
-- V0.9.4) + ajout :
--   • colonne `geom_source` (DEFAULT 'commune_centroid', NOT NULL, CHECK)
--   • GiST PARTIEL `annuaire_ameli_staging_geog_precise_gist`
--     WHERE geom_source = 'ban_address'
--
-- POURQUOI MIRRORER PROD ↔ STAGING (gotcha CLAUDE.md prouvé prod RPPS) :
-- Tout index/colonne présent sur la table prod DOIT être créé à l'identique
-- par la staging-create — sinon le RENAME du swap atomique perd
-- silencieusement l'index/la colonne (gotcha 2026-05-19 RPPS
-- `rpps_staging_geog_precise_gist`). Garde-fou : `staging-parity.test.ts`.
--
-- RECOPIE VERBATIM de la dernière def `20260514T090000` (PostgreSQL n'a pas
-- d'héritage de corps de fonction — un patch « prod − N lignes »
-- réintroduirait silencieusement les composites V0.4.1 ou le covering V0.9.4
-- retirés par une migration ultérieure). On garde le GiST GLOBAL
-- `annuaire_ameli_staging_geog_gist` (sert les tools radius existants tant
-- que le backfill BAN n'a pas peuplé majoritairement le partiel — phasage :
-- DROP du global après que les tools soient passés en branche `precise`).
--
-- IDÉMPOTENCE : CREATE OR REPLACE FUNCTION. Sa première invocation par le
-- cron Ameli (DROP + CREATE TABLE) appliquera la nouvelle disposition.
--
-- APPLICATION : naming `YYYYMMDDThhmmss` → CLI Supabase saute, applied
-- MANUELLEMENT en prod via dashboard SQL editor.

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
    -- Chantier C 2026-05-21 : provenance des coords. DEFAULT évite de toucher
    -- au code TS du COPY (parseAmeliRecord n'écrit pas explicitement la
    -- colonne — l'INSERT prend le DEFAULT à chaque ligne, byte-équivalent).
    -- NOT NULL = invariant produit (jamais de coord muette).
    geom_source                   TEXT         NOT NULL DEFAULT 'commune_centroid'
                                  CHECK (geom_source IN ('commune_centroid', 'ban_address')),
    raw                           JSONB,
    created_at                    TIMESTAMPTZ  DEFAULT now()
  );

  -- 5 index de base (`20260508000018`)
  CREATE INDEX annuaire_ameli_staging_geog_gist      ON annuaire_ameli_staging USING GIST (geog);
  CREATE INDEX annuaire_ameli_staging_dept_idx       ON annuaire_ameli_staging (code_departement);
  CREATE INDEX annuaire_ameli_staging_specialite_idx ON annuaire_ameli_staging (specialite_code);
  CREATE INDEX annuaire_ameli_staging_type_ps_idx    ON annuaire_ameli_staging (type_ps_code);
  CREATE INDEX annuaire_ameli_staging_insee_idx      ON annuaire_ameli_staging (code_insee);

  -- 2 composites V0.4.1 — survive the swap.
  CREATE INDEX annuaire_ameli_staging_dept_spec_idx  ON annuaire_ameli_staging (code_departement, specialite_code);
  CREATE INDEX annuaire_ameli_staging_dept_type_idx  ON annuaire_ameli_staging (code_departement, type_ps_code);

  -- 1 covering V0.9.4 pour l'ORDER BY de ameli_by_specialite_dept (anti top-N
  -- heapsort 57014, cf. 20260514T090000).
  CREATE INDEX annuaire_ameli_staging_dept_sort_covering_idx
    ON annuaire_ameli_staging (code_departement, code_insee NULLS LAST, nom, prenom, id);

  -- Chantier C 2026-05-21 : GiST PARTIEL pour la branche precise des tools
  -- radius. Doit voyager dans `annuaire_ameli` via le RENAME du swap.
  -- Prédicat byte-identique à l'index prod `annuaire_ameli_geog_precise_gist`
  -- (20260521T100000) — garde-fou parity étendu dans staging-parity.test.ts.
  CREATE INDEX annuaire_ameli_staging_geog_precise_gist
    ON annuaire_ameli_staging USING GIST (geog)
    WHERE geom_source = 'ban_address';

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

COMMENT ON FUNCTION ingest_create_annuaire_ameli_staging IS
  'V0.4 phase 1 + V0.4.1 composites + V0.9.4 covering + Chantier C 2026-05-21 — (re)crée annuaire_ameli_staging avec geom_source NOT NULL DEFAULT commune_centroid + GiST PARTIEL ban_address. Recopie VERBATIM de la dernière def 20260514T090000 (l''héritage par patch « prod − N lignes » est interdit — réintroduirait les composites/covering retirés). Les 9 index voyagent dans annuaire_ameli via le RENAME du swap atomique. SECURITY DEFINER pour permettre le DDL au service_role.';

NOTIFY pgrst, 'reload schema';
