-- Create the FINESS staging table from scratch each ingestion run.
-- Same schema as `finess` so the atomic swap (rename staging → prod) lands cleanly.
--
-- IMPORTANT: the staging policy MUST mirror the prod policy exactly. After
-- ingest_atomic_swap renames `finess_staging` → `finess`, the table's RLS
-- policies are preserved (Postgres only renames relname). If staging used
-- `USING (false)`, the swap would lock anon out of `finess` permanently — the
-- MCP server would silently return empty results for every query. Caught by
-- the final code review on V0.2 phase 1+2.
CREATE OR REPLACE FUNCTION ingest_create_finess_staging()
RETURNS VOID
LANGUAGE plpgsql
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
  -- Same policy name + USING clause as prod, so the rename is idempotent and
  -- anon retains read access after the swap. Service_role writes during
  -- ingestion bypass RLS regardless (no INSERT policy needed).
  CREATE POLICY "anon read finess" ON finess_staging FOR SELECT TO anon USING (true);
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_finess_staging FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_create_finess_staging TO service_role;
