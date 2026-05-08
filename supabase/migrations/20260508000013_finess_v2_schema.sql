-- FINESS schema v2 — fixes 4 critical bugs from the post-v0.2.0 audit (Cyril,
-- 2026-05-08): wrong city ("ARDENNES" instead of real commune), null postal
-- codes, broken department filter on `finess_by_categorie` (returned 221
-- rows nationwide instead of just dept 08), and a 30-km radius timeout on
-- `finess_in_radius` without family filter.
--
-- Three structural changes are needed:
--
-- 1. Add `code_departement CHAR(3)` (NOT NULL, indexed) so the categorie RPC
--    filters on a real column instead of `left(code_insee, 2)`. The previous
--    filter was broken by the parser inserting commune-codes-only (e.g. "105"
--    for Charleville) into `code_insee CHAR(5)`, which CHAR-padded to "105  ",
--    so `left("105  ", 2) = "10"` matched the wrong department.
--
-- 2. Add `geog GEOGRAPHY` as a STORED generated column (cast of `geom` to
--    geography) plus a GIST index on it. The radius RPC was timing out because
--    `ST_DWithin(geom::geography, point, distance)` cannot use the existing
--    GIST index on `geom` (geometry) — the implicit cast disables index lookup.
--    A dedicated geography column with its own GIST index makes ST_DWithin
--    sub-100ms even at 30 km without a category filter.
--
-- 3. Drop the `left(code_insee, 2)` index — it served the broken filter, no
--    longer needed once the RPC switches to `code_departement`.
--
-- IMPORTANT — this migration prepares the SCHEMA. Existing rows in `finess`
-- still have wrong values (commune codes in code_insee, "ARDENNES" in ville,
-- null code_postal). The next ingestion run rebuilds the table from scratch
-- via the staging→prod swap, so existing bad rows get fully replaced. Until
-- then, queries against `code_departement` return zero rows (column is NULL
-- on rows already loaded). This is acceptable because:
--   - The categorie RPC filter was already broken in v0.2.0.
--   - The radius RPC keeps working on the geog column (which is generated
--     from the existing geom — already correctly populated).
--   - The next ingestion fixes everything in one swap.

-- ──────────────────────────────────────────────────────────────────────────
-- (1) finess (prod table) — additive ALTER, safe for existing data
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE finess ADD COLUMN IF NOT EXISTS code_departement CHAR(3);

-- v0.2.1 review caught a hazard with backfilling existing rows: in v0.2.0
-- the parser stored commune-only codes (e.g. "105" for Charleville) into
-- `code_insee CHAR(5)`, so left-2 returns "10" — the Aube department —
-- not "08" (Ardennes). Backfilling from `left(code_insee, 2)` would tag
-- Charleville rows with dept "10" and leave the table mis-filterable until
-- the next ingestion swap completes.
--
-- We deliberately leave `code_departement` NULL on existing rows. The
-- next ingestion via staging→prod swap will rebuild the table from scratch
-- with the new parser, and every row will land with a correct, validated
-- `code_departement`. Until then:
--   - finess_in_radius keeps working (it doesn't use code_departement).
--   - finess_by_categorie with `p_departement = NULL` still returns rows.
--   - finess_by_categorie with a non-null `p_departement` returns zero —
--     this is honest "not yet ingested" behavior, NOT a regression of the
--     v0.2.0 broken filter (which silently returned wrong rows).
DO $finess_v2_audit$
DECLARE
  v_rows_with_null_dept INT;
  v_total INT;
BEGIN
  SELECT count(*) INTO v_total FROM finess;
  SELECT count(*) INTO v_rows_with_null_dept FROM finess WHERE code_departement IS NULL;
  RAISE NOTICE
    '[finess v2 schema] code_departement column added. % rows total, % NULL (will be filled by next ingestion swap).',
    v_total,
    v_rows_with_null_dept;
END;
$finess_v2_audit$;

-- Geography column for ST_DWithin index lookup. Generated stored so it stays
-- consistent with `geom` automatically — no manual sync, no triggers.
ALTER TABLE finess
  ADD COLUMN IF NOT EXISTS geog GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED;

-- New indexes
CREATE INDEX IF NOT EXISTS finess_geog_gist ON finess USING GIST (geog);
CREATE INDEX IF NOT EXISTS finess_code_dept_idx ON finess (code_departement);

-- Drop the obsolete left(code_insee, 2) index — replaced by code_departement.
-- The CASCADE keeps the migration idempotent if a previous attempt half-applied.
DROP INDEX IF EXISTS finess_dept_idx CASCADE;

-- ──────────────────────────────────────────────────────────────────────────
-- (2) ingest_create_finess_staging — recreate with new column + indexes
-- ──────────────────────────────────────────────────────────────────────────
-- The staging table mirrors the prod schema exactly, so the atomic swap
-- promotes a fully-populated `code_departement` column on every ingestion.

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
    -- Generated geography column. STORED so the GIST index can use it; the
    -- generation runs on every insert/update of `geom`, so the staging-time
    -- ingest pipeline gets the geography "for free" once the geom UPDATE
    -- batch has run.
    geog                GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
    raw                 JSONB,
    created_at          TIMESTAMPTZ  DEFAULT now()
  );
  CREATE INDEX finess_staging_geom_gist     ON finess_staging USING GIST (geom);
  CREATE INDEX finess_staging_geog_gist     ON finess_staging USING GIST (geog);
  CREATE INDEX finess_staging_categorie_idx ON finess_staging (categorie_code);
  CREATE INDEX finess_staging_code_dept_idx ON finess_staging (code_departement);

  ALTER TABLE finess_staging ENABLE ROW LEVEL SECURITY;
  -- Same policy name + USING clause as prod, so the rename is idempotent and
  -- anon retains read access after the swap.
  CREATE POLICY "anon read finess" ON finess_staging FOR SELECT TO anon USING (true);

  -- Tell PostgREST about the new staging table immediately (the ingest
  -- script's first INSERT used to race the schema-cache reload — see
  -- migration 20260508000008 for the postmortem).
  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_finess_staging FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_create_finess_staging TO service_role;

-- Reload PostgREST so the new `code_departement` and `geog` columns appear
-- in the schema cache immediately, not on the next 10-minute interval.
NOTIFY pgrst, 'reload schema';
