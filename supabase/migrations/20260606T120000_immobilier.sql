-- Migration : domaine Immobilier — DVF mutations, cache commune, sitadel logements.
-- ⚠️ NE PAS APPLIQUER AUTOMATIQUEMENT — validation humaine requise avant apply prod.
-- Miroir exact de l'idiome geometry/geography du RPC finess_in_radius (migration
-- 20260508000004_rpc_finess_query.sql) : cast `::geography` pour ST_DWithin en mètres.

-- ---------------------------------------------------------------------------
-- 1. Table dvf_mutations
-- ---------------------------------------------------------------------------

-- `geom` est une colonne GENERATED STORED : Postgres la calcule depuis
-- longitude/latitude (ST_MakePoint/ST_SetSRID sont IMMUTABLE → autorisées dans
-- une colonne générée). Aucun trigger requis, aucune écriture possible côté
-- INSERT/UPDATE. `type_local` est NOT NULL DEFAULT '' pour permettre une vraie
-- PRIMARY KEY composite (pas de NULL, pas d'expression coalesce).
CREATE TABLE IF NOT EXISTS dvf_mutations (
  id_mutation      TEXT        NOT NULL,
  date_mutation    DATE        NOT NULL,
  nature_mutation  TEXT,
  valeur_fonciere  NUMERIC,
  code_commune     TEXT        NOT NULL,
  type_local       TEXT        NOT NULL DEFAULT '',
  surface_reelle_bati NUMERIC,
  surface_terrain  NUMERIC,
  prix_m2          NUMERIC,
  longitude        DOUBLE PRECISION,
  latitude         DOUBLE PRECISION,
  geom geometry(Point, 4326) GENERATED ALWAYS AS (
    CASE WHEN longitude IS NOT NULL AND latitude IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint(longitude, latitude), 4326) END
  ) STORED,
  PRIMARY KEY (id_mutation, code_commune, date_mutation, type_local)
);

CREATE INDEX IF NOT EXISTS dvf_mutations_geom_idx
  ON dvf_mutations USING GIST (geom);

CREATE INDEX IF NOT EXISTS dvf_mutations_code_commune_idx
  ON dvf_mutations (code_commune);

-- ---------------------------------------------------------------------------
-- 2. Table dvf_commune_cache (registre des communes déjà ingérées)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dvf_commune_cache (
  code_commune TEXT        PRIMARY KEY,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_year  INT,
  row_count    INT         NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 3. Table sitadel_logements (Sit@del2 autorisations/commencements)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sitadel_logements (
  code_commune         TEXT NOT NULL,
  periode              TEXT NOT NULL,
  logements_autorises  INT,
  logements_commences  INT,
  PRIMARY KEY (code_commune, periode)
);

CREATE INDEX IF NOT EXISTS sitadel_logements_code_commune_idx
  ON sitadel_logements (code_commune);

-- ---------------------------------------------------------------------------
-- 4. RPC dvf_in_radius — même idiome que finess_in_radius :
--    geometry(Point,4326) → cast ::geography pour ST_DWithin (distance en mètres)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION dvf_in_radius(
  p_lat            DOUBLE PRECISION,
  p_lon            DOUBLE PRECISION,
  p_radius_meters  DOUBLE PRECISION,
  p_limit          INT DEFAULT 500
) RETURNS SETOF dvf_mutations
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
BEGIN
  RETURN QUERY
  SELECT m.*
  FROM dvf_mutations m
  WHERE m.geom IS NOT NULL
    AND ST_DWithin(m.geom::geography, v_point, p_radius_meters)
  ORDER BY m.date_mutation DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION dvf_in_radius TO anon;
