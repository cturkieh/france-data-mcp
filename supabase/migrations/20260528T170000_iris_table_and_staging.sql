-- Phase B — IRIS infracommunal (démographie au quartier).
-- Cf. docs/plans/iris-infracommunal.md. Étape 1/6 : table pivot `iris`
-- (contours IGN « CONTOURS-IRIS » édition 2024, géo 01/01/2024) + staging-create.
--
-- GÉOMÉTRIE = NOUVEAU pour ce projet (points uniquement jusqu'ici). Les polygones
-- IRIS sont en Lambert-93 (EPSG:2154) à la source ; le cron (scripts/ingest/iris.ts)
-- les reprojette 2154→4326 via ogr2ogr et les insère en EWKT (`SRID=4326;MULTIPOLYGON…`)
-- → PostGIS caste sur la colonne typée `geometry(MultiPolygon, 4326)`.
--
-- geog/centroid_geog = GENERATED ALWAYS … STORED + GiST (gotcha CLAUDE.md : un cast
-- runtime tue le plan). DDL validé prod (ST_Centroid(geom)::geography en STORED OK).
--   • geog          : requêtes point-in-polygon / rayon sur le contour.
--   • centroid_geog : inclusion d'un IRIS dans un bassin PAR CENTROÏDE (profil_iris,
--     règle R2) — ~16K centroïdes distincts, pas le piège de cluster co-localisé
--     V0.10.2 (chaque IRIS = 1 centroïde unique).
--
-- PARITÉ PROD ↔ STAGING (gotcha prouvé prod RPPS/Ameli) : tout index / colonne / RLS
-- présent sur la table prod DOIT être recréé À L'IDENTIQUE par
-- ingest_create_iris_staging() — sinon le RENAME du swap atomique le perd
-- SILENCIEUSEMENT. Garde-fou : scripts/ingest/staging-parity.test.ts.
--
-- PAS DE MATVIEW `FROM iris` : les blocs stats (RP/FILOSOFI, étapes 2-3) seront des
-- tables jointes sur code_iris au query-time → pas de bombe OID matview à gérer ici.
--
-- APPLICATION : appliqué en prod via MCP Supabase apply_migration (le CLI
-- `supabase db push` rejette le format `YYYYMMDDThhmmss`). Naming T-format pour
-- rester cohérent avec les 52 migrations existantes du repo.

-- ── Table prod ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS iris (
  code_iris      CHAR(9)  PRIMARY KEY,                 -- code_commune(5) + n° IRIS(4)
  code_commune   CHAR(5)  NOT NULL,                    -- clé de raccord au reste du MCP
  libelle        TEXT,                                 -- nom du quartier (NOM_IRIS)
  type_iris      TEXT,                                 -- TYP_IRIS : H/A/D (irisée) ou Z (commune non irisée)
  geom           geometry(MultiPolygon, 4326) NOT NULL,
  geog           GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
  centroid_geog  GEOGRAPHY GENERATED ALWAYS AS ((ST_Centroid(geom)::geography)) STORED,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS iris_geog_gist          ON iris USING GIST (geog);
CREATE INDEX IF NOT EXISTS iris_centroid_geog_gist ON iris USING GIST (centroid_geog);
CREATE INDEX IF NOT EXISTS iris_commune_idx        ON iris (code_commune);

ALTER TABLE iris ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon read iris" ON iris;
CREATE POLICY "anon read iris" ON iris FOR SELECT TO anon USING (true);

-- ── Staging-create (recopie VERBATIM de la disposition prod ci-dessus) ────────
-- L'héritage par patch « prod − N lignes » est INTERDIT (PostgreSQL n'a pas
-- d'héritage de corps de fonction) : recopier la dernière def à l'identique.
CREATE OR REPLACE FUNCTION ingest_create_iris_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  DROP TABLE IF EXISTS iris_staging CASCADE;
  CREATE TABLE iris_staging (
    code_iris      CHAR(9)  PRIMARY KEY,
    code_commune   CHAR(5)  NOT NULL,
    libelle        TEXT,
    type_iris      TEXT,
    geom           geometry(MultiPolygon, 4326) NOT NULL,
    geog           GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
    centroid_geog  GEOGRAPHY GENERATED ALWAYS AS ((ST_Centroid(geom)::geography)) STORED,
    created_at     TIMESTAMPTZ DEFAULT now()
  );

  -- Mirror des 3 index prod — voyagent dans `iris` via le RENAME du swap.
  CREATE INDEX iris_staging_geog_gist          ON iris_staging USING GIST (geog);
  CREATE INDEX iris_staging_centroid_geog_gist ON iris_staging USING GIST (centroid_geog);
  CREATE INDEX iris_staging_commune_idx        ON iris_staging (code_commune);

  ALTER TABLE iris_staging ENABLE ROW LEVEL SECURITY;
  -- Nom de policy IDENTIQUE à la prod : le RENAME du swap doit préserver
  -- l'accès SELECT anon (gotcha Ameli). service_role bypass RLS pour l'ingest.
  CREATE POLICY "anon read iris" ON iris_staging FOR SELECT TO anon USING (true);

  -- Prévenir PostgREST du nouveau staging pour que le 1er INSERT ne race pas
  -- le schema-cache reload (leçon FINESS V0.2).
  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_iris_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_iris_staging TO service_role;

COMMENT ON FUNCTION ingest_create_iris_staging IS
  'Phase B étape 1 — (re)crée iris_staging à l''identique de la table prod iris (3 index GiST/btree + RLS anon read). Recopie VERBATIM (héritage par patch interdit). Les index voyagent dans iris via le RENAME du swap atomique. SECURITY DEFINER pour le DDL au service_role.';

NOTIFY pgrst, 'reload schema';
