-- ──────────────────────────────────────────────────────────────────────────
-- Couche d'activités hébergées (Phase 2 chantier Complétude & lentilles).
--
-- Mappe `num_finess → activités[]` pour les sites hébergeant une activité
-- secondaire (biologie / pharmacie / imagerie) sous une catégorie FINESS
-- d'une autre famille. Calculée par jointure RPPS×FINESS, seuil N≥3
-- professionnels (calibré par la mesure prod 2026-05-22 — cf.
-- docs/plans/completude-lentilles-phase2-mesure.md).
--
-- ⚠️ La matview joint deux tables swappées (rpps mensuel, finess bimestriel).
-- Pattern OID rebuild OBLIGATOIRE post-swap des deux côtés (cf. gotcha
-- CLAUDE.md). NE JAMAIS utiliser REFRESH ici — la matview suit l'OID de
-- ses sources, un swap suffit à la désynchroniser silencieusement.
--
-- Filtres d'activité (figés Phase 2, paramètres dans le plan §"Décisions
-- produit figées") :
--   • biologie  : médecins biologistes + anapath + techniciens de labo,
--                 hors catégories labo (610/611/612).
--   • pharmacie : pharmaciens, hors officines (620/627/628/629), hors
--                 labos (610/611/612), hors EFS (132, traités en biologie),
--                 hors écoles (300/330, faux positifs prouvés).
--   • imagerie  : manipulateurs ERM + radiologues, hors code 619 (vide).
--
-- Réf : docs/plans/completude-lentilles-{sources,phase2-mesure,phase2-plan}.md

CREATE MATERIALIZED VIEW IF NOT EXISTS finess_hosted_activities AS
WITH bio AS (
  SELECT r.num_finess
  FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
  WHERE f.categorie_code NOT IN ('610','611','612')
    AND ( r.savoir_faire_libelle ILIKE 'Biologie médicale%'
          OR r.savoir_faire_libelle ILIKE 'Anatomie et cytologie%'
          OR r.profession_libelle = 'Technicien de Laboratoire' )
  GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
),
pharma AS (
  SELECT r.num_finess
  FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
  WHERE f.categorie_code NOT IN ('620','627','628','629','610','611','612','300','330','132')
    AND r.profession_libelle = 'Pharmacien'
  GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
),
img AS (
  SELECT r.num_finess
  FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
  WHERE f.categorie_code IS DISTINCT FROM '619'
    AND ( r.profession_libelle = 'Manipulateur ERM'
          OR r.savoir_faire_libelle ILIKE 'Radio-diagnostic%'
          OR r.savoir_faire_libelle ILIKE 'Radiologie et imagerie%' )
  GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
),
unioned AS (
  SELECT num_finess, 'biologie'::text AS activite FROM bio
  UNION ALL
  SELECT num_finess, 'pharmacie'::text FROM pharma
  UNION ALL
  SELECT num_finess, 'imagerie'::text FROM img
),
grouped AS (
  SELECT num_finess, array_agg(activite ORDER BY activite)::text[] AS activites
  FROM unioned GROUP BY num_finess
)
SELECT
  g.num_finess,
  g.activites,
  f.raison_sociale,
  f.categorie_code,
  f.categorie_libelle,
  f.code_departement,
  f.code_insee,
  f.geom,
  f.geog
FROM grouped g
JOIN finess f ON f.num_finess = g.num_finess;

CREATE UNIQUE INDEX finess_hosted_activities_pkey
  ON finess_hosted_activities (num_finess);
CREATE INDEX finess_hosted_activities_activites_gin
  ON finess_hosted_activities USING GIN (activites);
CREATE INDEX finess_hosted_activities_geog_gist
  ON finess_hosted_activities USING GIST (geog);
CREATE INDEX finess_hosted_activities_code_dept
  ON finess_hosted_activities (code_departement);
CREATE INDEX finess_hosted_activities_code_insee
  ON finess_hosted_activities (code_insee);

GRANT SELECT ON finess_hosted_activities TO anon, authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- RPC 1 — lookup in_radius (PostGIS)
-- ──────────────────────────────────────────────────────────────────────────

-- num_finess + categorie_code en `text` plutôt que `char(9)`/`varchar` :
-- la matview hérite du type `text` de `rpps.num_finess` (CTE grouped), pas
-- du `char(9)` de `finess.num_finess`. Cast `::text` explicite pour stabilité
-- du contrat RETURNS TABLE. Côté TypeScript = string, neutre.
CREATE OR REPLACE FUNCTION finess_hosted_activities_in_radius(
  p_activite text,
  p_lat double precision,
  p_lon double precision,
  p_radius_meters integer,
  p_sample_limit integer DEFAULT 5
)
RETURNS TABLE (
  total_count bigint,
  num_finess text,
  raison_sociale text,
  categorie_code text,
  categorie_libelle text
)
LANGUAGE plpgsql STABLE
SET statement_timeout = '55s'
AS $$
DECLARE
  v_point geography := ST_MakePoint(p_lon, p_lat)::geography;
  v_total bigint;
BEGIN
  SELECT count(*)::bigint INTO v_total
  FROM finess_hosted_activities
  WHERE p_activite = ANY(activites)
    AND ST_DWithin(geog, v_point, p_radius_meters);

  RETURN QUERY
  SELECT
    v_total,
    fha.num_finess::text,
    fha.raison_sociale,
    fha.categorie_code::text,
    fha.categorie_libelle
  FROM finess_hosted_activities fha
  WHERE p_activite = ANY(fha.activites)
    AND ST_DWithin(fha.geog, v_point, p_radius_meters)
  ORDER BY fha.raison_sociale
  LIMIT GREATEST(p_sample_limit, 1);
END;
$$;

REVOKE EXECUTE ON FUNCTION finess_hosted_activities_in_radius FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION finess_hosted_activities_in_radius TO anon, authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- RPC 2 — lookup in_zone (département OU commune)
-- ──────────────────────────────────────────────────────────────────────────

-- Idem RPC in_radius : RETURNS en `text` (la matview hérite `text` via RPPS),
-- cast `::text` explicite.
CREATE OR REPLACE FUNCTION finess_hosted_activities_in_zone(
  p_activite text,
  p_departement text DEFAULT NULL,
  p_code_insee text DEFAULT NULL,
  p_sample_limit integer DEFAULT 5
)
RETURNS TABLE (
  total_count bigint,
  num_finess text,
  raison_sociale text,
  categorie_code text,
  categorie_libelle text
)
LANGUAGE plpgsql STABLE
SET statement_timeout = '55s'
AS $$
DECLARE
  v_total bigint;
BEGIN
  IF p_departement IS NULL AND p_code_insee IS NULL THEN
    RAISE EXCEPTION 'finess_hosted_activities_in_zone: p_departement OR p_code_insee required';
  END IF;

  SELECT count(*)::bigint INTO v_total
  FROM finess_hosted_activities
  WHERE p_activite = ANY(activites)
    AND ( p_departement IS NULL OR code_departement = p_departement )
    AND ( p_code_insee  IS NULL OR code_insee       = p_code_insee );

  RETURN QUERY
  SELECT
    v_total,
    fha.num_finess::text,
    fha.raison_sociale,
    fha.categorie_code::text,
    fha.categorie_libelle
  FROM finess_hosted_activities fha
  WHERE p_activite = ANY(fha.activites)
    AND ( p_departement IS NULL OR fha.code_departement = p_departement )
    AND ( p_code_insee  IS NULL OR fha.code_insee       = p_code_insee )
  ORDER BY fha.raison_sociale
  LIMIT GREATEST(p_sample_limit, 1);
END;
$$;

REVOKE EXECUTE ON FUNCTION finess_hosted_activities_in_zone FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION finess_hosted_activities_in_zone TO anon, authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- Rebuild post-swap (pattern OID — JAMAIS REFRESH, cf. gotcha CLAUDE.md)
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ingest_rebuild_finess_hosted_activities()
RETURNS void
LANGUAGE plpgsql
SET statement_timeout = '10min'
AS $$
BEGIN
  -- DROP la matview obsolète (collée à l'ancien OID des tables swappées)
  DROP MATERIALIZED VIEW IF EXISTS finess_hosted_activities_rebuild;

  -- CREATE la nouvelle (résolue PAR NOM, donc liée aux OIDs actuels).
  -- ⚠️ Corps DOIT être byte-identique au SELECT canonique ci-dessus —
  -- garde-fou : finess-hosted-activities-rebuild.test.ts.
  CREATE MATERIALIZED VIEW finess_hosted_activities_rebuild AS
  WITH bio AS (
    SELECT r.num_finess
    FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
    WHERE f.categorie_code NOT IN ('610','611','612')
      AND ( r.savoir_faire_libelle ILIKE 'Biologie médicale%'
            OR r.savoir_faire_libelle ILIKE 'Anatomie et cytologie%'
            OR r.profession_libelle = 'Technicien de Laboratoire' )
    GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
  ),
  pharma AS (
    SELECT r.num_finess
    FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
    WHERE f.categorie_code NOT IN ('620','627','628','629','610','611','612','300','330','132')
      AND r.profession_libelle = 'Pharmacien'
    GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
  ),
  img AS (
    SELECT r.num_finess
    FROM rpps r JOIN finess f ON f.num_finess = r.num_finess
    WHERE f.categorie_code IS DISTINCT FROM '619'
      AND ( r.profession_libelle = 'Manipulateur ERM'
            OR r.savoir_faire_libelle ILIKE 'Radio-diagnostic%'
            OR r.savoir_faire_libelle ILIKE 'Radiologie et imagerie%' )
    GROUP BY 1 HAVING count(DISTINCT r.id) >= 3
  ),
  unioned AS (
    SELECT num_finess, 'biologie'::text AS activite FROM bio
    UNION ALL
    SELECT num_finess, 'pharmacie'::text FROM pharma
    UNION ALL
    SELECT num_finess, 'imagerie'::text FROM img
  ),
  grouped AS (
    SELECT num_finess, array_agg(activite ORDER BY activite)::text[] AS activites
    FROM unioned GROUP BY num_finess
  )
  SELECT
    g.num_finess,
    g.activites,
    f.raison_sociale,
    f.categorie_code,
    f.categorie_libelle,
    f.code_departement,
    f.code_insee,
    f.geom,
    f.geog
  FROM grouped g
  JOIN finess f ON f.num_finess = g.num_finess;

  -- Indexes sur la _rebuild (avant le rename atomique)
  CREATE UNIQUE INDEX finess_hosted_activities_rebuild_pkey
    ON finess_hosted_activities_rebuild (num_finess);
  CREATE INDEX finess_hosted_activities_rebuild_activites_gin
    ON finess_hosted_activities_rebuild USING GIN (activites);
  CREATE INDEX finess_hosted_activities_rebuild_geog_gist
    ON finess_hosted_activities_rebuild USING GIST (geog);
  CREATE INDEX finess_hosted_activities_rebuild_code_dept
    ON finess_hosted_activities_rebuild (code_departement);
  CREATE INDEX finess_hosted_activities_rebuild_code_insee
    ON finess_hosted_activities_rebuild (code_insee);

  GRANT SELECT ON finess_hosted_activities_rebuild TO anon, authenticated, service_role;

  -- RENAME atomique (1 transaction PL/pgSQL)
  DROP MATERIALIZED VIEW IF EXISTS finess_hosted_activities;
  ALTER MATERIALIZED VIEW finess_hosted_activities_rebuild
    RENAME TO finess_hosted_activities;
  ALTER INDEX finess_hosted_activities_rebuild_pkey
    RENAME TO finess_hosted_activities_pkey;
  ALTER INDEX finess_hosted_activities_rebuild_activites_gin
    RENAME TO finess_hosted_activities_activites_gin;
  ALTER INDEX finess_hosted_activities_rebuild_geog_gist
    RENAME TO finess_hosted_activities_geog_gist;
  ALTER INDEX finess_hosted_activities_rebuild_code_dept
    RENAME TO finess_hosted_activities_code_dept;
  ALTER INDEX finess_hosted_activities_rebuild_code_insee
    RENAME TO finess_hosted_activities_code_insee;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_rebuild_finess_hosted_activities FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_rebuild_finess_hosted_activities TO service_role;

COMMENT ON FUNCTION ingest_rebuild_finess_hosted_activities IS
  'Rebuild post-swap (RPPS ou FINESS) de la matview finess_hosted_activities. Pattern OID — JAMAIS REFRESH. Hooké dans scripts/ingest/{rpps,finess}.ts post-swap.';

COMMENT ON MATERIALIZED VIEW finess_hosted_activities IS
  'Couche d''activités hébergées (biologie/pharmacie/imagerie) calculée par jointure RPPS x FINESS, seuil N>=3 professionnels. Phase 2 chantier Complétude & lentilles. Voir docs/plans/completude-lentilles-{sources,phase2-mesure,phase2-plan}.md.';
