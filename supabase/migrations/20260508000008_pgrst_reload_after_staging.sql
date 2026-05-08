-- Notify PostgREST to reload its schema cache after creating the runtime
-- staging table. Without this, the next supabase-js insert against
-- `finess_staging` fails with "Could not find the table 'public.finess_staging'
-- in the schema cache" — PostgREST hasn't seen the new table yet.
--
-- Supabase's stock setup includes a `pgrst_ddl_watch` event trigger that
-- already listens to DDL changes, but the trigger fires AFTER the function
-- returns; explicit NOTIFY ensures the reload is queued before we hit
-- PostgREST again. Combined with a ~1.5s sleep client-side, this is the
-- canonical pattern for "create table at runtime then immediately insert".

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
    code_insee          CHAR(5)      NOT NULL,
    ville               TEXT,
    telephone           VARCHAR(20),
    email               TEXT,
    date_ouverture      DATE,
    date_maj            DATE,
    geom                geometry(Point, 4326),
    raw                 JSONB,
    created_at          TIMESTAMPTZ  DEFAULT now()
  );
  CREATE INDEX finess_staging_geom_gist     ON finess_staging USING GIST (geom);
  CREATE INDEX finess_staging_categorie_idx ON finess_staging (categorie_code);
  CREATE INDEX finess_staging_dept_idx      ON finess_staging (left(code_insee, 2));
  ALTER TABLE finess_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read finess" ON finess_staging FOR SELECT TO anon USING (true);

  -- Tell PostgREST to refresh its schema cache so the new table becomes
  -- queryable immediately. Caller should still wait briefly (~1-2s) before
  -- the first insert to let PostgREST process the notification.
  NOTIFY pgrst, 'reload schema';
END;
$$;
