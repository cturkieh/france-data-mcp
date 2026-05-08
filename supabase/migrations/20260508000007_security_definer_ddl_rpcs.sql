-- Make the DDL RPCs SECURITY DEFINER.
--
-- Supabase recently restricted `service_role` from running CREATE/DROP TABLE
-- on the `public` schema. The two ingestion RPCs (`ingest_atomic_swap` and
-- `ingest_create_finess_staging`) issue DDL via `EXECUTE format(...)`, so they
-- need to run with the owner's privileges (postgres), not the caller's
-- (service_role). Caught on the first prod ingestion attempt 2026-05-08.
--
-- We re-CREATE OR REPLACE the two functions with the same body, only adding
-- SECURITY DEFINER. The identifier-validation regex on `ingest_atomic_swap`
-- (`^[a-z_][a-z0-9_]*$`) remains the defense-in-depth against table-name
-- injection from a privileged caller.

CREATE OR REPLACE FUNCTION ingest_atomic_swap(p_prod_table TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_staging  TEXT := p_prod_table || '_staging';
  v_previous TEXT := p_prod_table || '_previous';
  v_old_old  TEXT := p_prod_table || '_previous_OLD';
BEGIN
  IF p_prod_table !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid table name %', p_prod_table;
  END IF;

  EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', v_old_old);

  IF to_regclass(v_previous) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I RENAME TO %I', v_previous, v_old_old);
  END IF;

  IF to_regclass(p_prod_table) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I RENAME TO %I', p_prod_table, v_previous);
  END IF;

  EXECUTE format('ALTER TABLE %I RENAME TO %I', v_staging, p_prod_table);

  EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', v_old_old);
END;
$$;

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
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_atomic_swap          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ingest_create_finess_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_atomic_swap          TO service_role;
GRANT  EXECUTE ON FUNCTION ingest_create_finess_staging TO service_role;
