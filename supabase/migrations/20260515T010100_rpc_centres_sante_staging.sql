-- V0.10 — CDS staging RPC.
-- Drop + recreate `centres_sante_staging` avec un schema IDENTIQUE à la
-- prod `centres_sante`. L'atomic swap renomme staging → prod en préservant
-- index, RLS policy, et grants.
--
-- SECURITY DEFINER : Supabase a retiré le CREATE TABLE direct sur `public`
-- pour service_role (cf. lesson V0.4) → DDL via owner postgres.
-- Pas d'input caller, donc pas de risque d'injection.
--
-- IMPORTANT — superset strict obligatoire (lesson V0.5.1) : tout futur
-- ALTER de la table prod DOIT être répliqué ici, sinon le swap perd
-- silencieusement la colonne/index ajouté.

CREATE OR REPLACE FUNCTION ingest_create_centres_sante_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  DROP TABLE IF EXISTS centres_sante_staging CASCADE;
  CREATE TABLE centres_sante_staging (
    etab_finess               CHAR(9)      PRIMARY KEY,
    etab_raison_sociale       TEXT         NOT NULL,
    accepte_carte_vitale      BOOLEAN      NOT NULL,
    accepte_apcv              BOOLEAN      NOT NULL,
    specialites_codes         TEXT[]       NOT NULL,
    specialites_libelles      TEXT[]       NOT NULL,
    type_etab_code            TEXT         NOT NULL,
    type_etab_libelle         TEXT         NOT NULL,
    telephone                 TEXT,
    voie                      TEXT,
    complement_voie           TEXT,
    lieu_dit                  TEXT,
    code_postal               CHAR(5)      NOT NULL,
    ville                     TEXT         NOT NULL,
    code_departement          CHAR(3)      NOT NULL,
    code_insee                CHAR(5),
    geom                      geometry(Point, 4326),
    geog                      GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
    raw                       JSONB        DEFAULT '{}'::jsonb,
    created_at                TIMESTAMPTZ  DEFAULT now()
  );

  CREATE INDEX centres_sante_staging_geog_gist       ON centres_sante_staging USING GIST (geog);
  CREATE INDEX centres_sante_staging_dept_idx        ON centres_sante_staging (code_departement);
  CREATE INDEX centres_sante_staging_insee_idx       ON centres_sante_staging (code_insee);
  CREATE INDEX centres_sante_staging_type_idx        ON centres_sante_staging (type_etab_code);
  CREATE INDEX centres_sante_staging_specialites_gin ON centres_sante_staging USING GIN (specialites_codes);

  ALTER TABLE centres_sante_staging ENABLE ROW LEVEL SECURITY;
  -- DOIT mirror la policy prod (nom + USING) pour que le swap garde anon SELECT.
  -- service_role bypass RLS pour l'ingest.
  CREATE POLICY "anon read centres_sante" ON centres_sante_staging
    FOR SELECT TO anon USING (true);

  -- Tell PostgREST about the new staging table immediately so the first
  -- INSERT doesn't race the schema-cache reload (lesson V0.2 finess).
  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_centres_sante_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_centres_sante_staging TO service_role;

NOTIFY pgrst, 'reload schema';
