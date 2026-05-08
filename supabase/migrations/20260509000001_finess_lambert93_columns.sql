-- V0.4.2 — Coords Lambert 93 en colonnes DOUBLE PRECISION typées au lieu de
-- raw->>'coordxet' (JSONB). Économise ~150 MB sur 93K rows. La colonne raw
-- reste dans le schéma pour rétro-compat ; les nouveaux INSERT la laissent vide.
--
-- IMPORTANT — Cette migration RECRÉE ingest_create_finess_staging et DOIT
-- être un SUPERSET STRICT du DDL de la migration 20260508000021 (qui était
-- elle-même un superset de mig 13 — code_departement, geog GENERATED).
-- Le swap atomic remplace ENTIÈREMENT la prod par la staging : toute
-- colonne/index manquant dans la staging est silencieusement perdu post-swap.

-- ──────────────────────────────────────────────────────────────────────────
-- (1) finess prod — additif, idempotent
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE finess
  ADD COLUMN IF NOT EXISTS coordx_lambert93 DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS coordy_lambert93 DOUBLE PRECISION;

-- ──────────────────────────────────────────────────────────────────────────
-- (2) Recréer ingest_create_finess_staging en SUPERSET de mig 21
--     + ajouter coordx_lambert93 / coordy_lambert93
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
    coordx_lambert93    DOUBLE PRECISION,
    coordy_lambert93    DOUBLE PRECISION,
    raw                 JSONB,
    created_at          TIMESTAMPTZ  DEFAULT now()
  );
  CREATE INDEX finess_staging_geom_gist           ON finess_staging USING GIST (geom);
  CREATE INDEX finess_staging_geog_gist           ON finess_staging USING GIST (geog);
  CREATE INDEX finess_staging_categorie_idx       ON finess_staging (categorie_code);
  CREATE INDEX finess_staging_code_dept_idx       ON finess_staging (code_departement);
  CREATE INDEX finess_staging_code_insee_idx      ON finess_staging (code_insee);
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
-- (3) Recréer ingest_apply_finess_geom_batch — lit les colonnes typées
--     au lieu de raw->>'coordxet'.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ingest_apply_finess_geom_batch(p_limit INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_updated INT;
BEGIN
  -- Lecture directe des colonnes typées coordx_lambert93 / coordy_lambert93,
  -- plus de cast string→numeric ni de regex runtime. Le parser TS
  -- (parseLambert93Coord) garantit que ces colonnes sont soit NULL soit un
  -- nombre fini, en rejetant les partial parses ("12 RUE DUMAS" → null).
  WITH batch AS (
    SELECT num_finess
    FROM finess_staging
    WHERE geom IS NULL
      AND coordx_lambert93 IS NOT NULL
      AND coordy_lambert93 IS NOT NULL
    LIMIT p_limit
  )
  UPDATE finess_staging f
  SET geom = ST_Transform(
    ST_SetSRID(ST_MakePoint(f.coordx_lambert93, f.coordy_lambert93), 2154),
    4326
  )
  FROM batch b
  WHERE f.num_finess = b.num_finess;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_apply_finess_geom_batch FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_apply_finess_geom_batch TO service_role;

NOTIFY pgrst, 'reload schema';
