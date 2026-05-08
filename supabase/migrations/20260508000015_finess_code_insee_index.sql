-- Add the missing `code_insee` index on `finess`. Without it,
-- `finess_by_categorie(..., p_code_insee = '08105', ...)` falls into a
-- sequential scan over ~95K rows and trips the Supabase 8s statement
-- timeout (Postgres error 57014). Audit B4.2 caught this on v0.3.0.
--
-- Adding the index also benefits the `(p_code_insee IS NULL OR
-- f.code_insee = p_code_insee)` branch of `finess_by_categorie` whenever
-- a caller passes a 5-char INSEE code.
--
-- Two-part fix mirroring the swap rotation pattern (cf migration 10):
--   (1) one-shot CREATE INDEX on the current prod table
--   (2) update `ingest_create_finess_staging` so future ingestions
--       carry the index through the staging→prod rename.

-- ──────────────────────────────────────────────────────────────────────────
-- (1) One-shot index on current prod
-- ──────────────────────────────────────────────────────────────────────────
-- Supabase migrations run inside a transaction → `CREATE INDEX CONCURRENTLY`
-- is not allowed. The blocking `CREATE INDEX` finishes in a few seconds on
-- 95K rows and only blocks writes (not reads), which is acceptable for the
-- `finess` table that is read-heavy and only written once per ingestion.
CREATE INDEX IF NOT EXISTS finess_code_insee_idx ON finess (code_insee);

-- ──────────────────────────────────────────────────────────────────────────
-- (2) Update ingest_create_finess_staging to include the index
-- ──────────────────────────────────────────────────────────────────────────
-- The atomic_swap RPC renames `finess_staging_*` indexes to `finess_*`,
-- so the new index name follows the existing convention.

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
  CREATE INDEX finess_staging_geom_gist       ON finess_staging USING GIST (geom);
  CREATE INDEX finess_staging_geog_gist       ON finess_staging USING GIST (geog);
  CREATE INDEX finess_staging_categorie_idx   ON finess_staging (categorie_code);
  CREATE INDEX finess_staging_code_dept_idx   ON finess_staging (code_departement);
  CREATE INDEX finess_staging_code_insee_idx  ON finess_staging (code_insee);

  ALTER TABLE finess_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read finess" ON finess_staging FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_finess_staging FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_create_finess_staging TO service_role;
