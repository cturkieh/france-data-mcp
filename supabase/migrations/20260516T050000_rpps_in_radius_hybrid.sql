-- V0.11.0 — rpps_in_radius HYBRIDE : branche précise (finess_join + ban_address,
-- index GiST PARTIEL) UNION ALL branche centroïde résiduelle (commune_centroid
-- uniquement, mécanique V0.10.2 conservée). Corrige F1/F2/F3/F4 (spec rév.2 §4.6).
-- Idempotent (IF NOT EXISTS / OR REPLACE). Apply : SQL Editor (statement_timeout
-- généreux : recrée matview + CREATE INDEX partiel full-scan 2,23M).

-- (0) F3 (renforcé, GATE prod 2026-05-16) — DROP du GiST GLOBAL `rpps_geog_gist`.
--     Diagnostic prod : avec le GiST global présent, le planner préférait
--     `BitmapAnd(rpps_geog_gist global + rpps_geom_source_idx)` au lieu du
--     partiel → le bbox du GiST global ramenait le cluster co-localisé
--     commune_centroid (76 798 lignes) dans la branche précise → P0 57014
--     latent après Phase 2 (~1,27 M ban_address). ANALYZE n'y change rien :
--     c'est un choix de coût, pas de stats. Preuves : EXPLAIN ANALYZE prod
--     (BitmapAnd, 90 634 lignes geog bbox) ; pg_stat_user_indexes
--     (rpps_geog_gist = 24 scans, ~uniquement nos tests) ; revue code-explorer
--     (AUCUN consommateur spatial de `rpps` hors rpps_in_radius, lui-même
--     routé partiel/matview ; build matview = seq scan+agrégat ; enrich FINESS
--     = num_finess ; swap = RENAME). Dans le design hybride plus AUCUNE requête
--     n'a besoin d'un index spatial GLOBAL sur `rpps`. DROP explicite requis
--     (pas juste retrait du mirror) pour que staging-parity recalcule le set
--     prod-vivant = creates − drops. Lock ACCESS EXCLUSIVE bref sur `rpps`
--     (catalogue + unlink, ~ms-s) : appliquer hors trafic.
DROP INDEX IF EXISTS rpps_geog_gist;

-- (1) F3 — Index GiST PARTIEL : la branche précise ne doit JAMAIS toucher le
--     cluster co-localisé commune_centroid. Prédicat IDENTIQUE au WHERE de la
--     branche précise (sinon planner ne juge pas le partiel utilisable — réserve
--     agent archi, critère de sortie cas 2).
CREATE INDEX IF NOT EXISTS rpps_geog_precise_gist
  ON rpps USING GIST (geog)
  WHERE geom_source IN ('finess_join','ban_address');

COMMENT ON INDEX rpps_geog_precise_gist IS
  'V0.11.0 — GiST partiel des lignes à coords précises (finess_join|ban_address). Sert la branche précise de rpps_in_radius sans jamais scanner le cluster co-localisé commune_centroid (anti re-P0 57014). Prédicat à matcher EXACTEMENT par le WHERE de la branche précise. Mirroré dans ingest_create_rpps_staging (sinon perdu au swap).';

-- (2) F4 — Matview RESTREINTE commune_centroid (sinon barycentre mouvant au fil
--     du géocodage BAN). DROP + recreate (la définition change).
DROP MATERIALIZED VIEW IF EXISTS rpps_commune_centroids;
CREATE MATERIALIZED VIEW rpps_commune_centroids AS
SELECT r.code_insee,
       ST_Centroid(ST_Collect(r.geom))::geography AS geog
FROM rpps r
WHERE r.geom_source = 'commune_centroid'
  AND r.geog IS NOT NULL
  AND r.code_insee IS NOT NULL
GROUP BY r.code_insee;

CREATE UNIQUE INDEX rpps_commune_centroids_pk ON rpps_commune_centroids (code_insee);
CREATE INDEX rpps_commune_centroids_geog_gist ON rpps_commune_centroids USING GIST (geog);
GRANT SELECT ON rpps_commune_centroids TO anon;

COMMENT ON MATERIALIZED VIEW rpps_commune_centroids IS
  'V0.11.0 — 1 centroïde par code_insee (= arrondissement pour PLM) calculé UNIQUEMENT sur les lignes geom_source=commune_centroid. Sert la branche centroïde RÉSIDUELLE de rpps_in_radius. REFRESH CONCURRENTLY post-swap.';

-- (3) RPC hybride. Paramètres + GRANT INCHANGÉS. RETURNS TABLE : +1 colonne
--     additive `geo_precision` (§4.7). Le reste du contrat strictement préservé.
--     ⚠️ Postgres INTERDIT `CREATE OR REPLACE FUNCTION` quand le type de retour
--     change (ici +1 colonne OUT au RETURNS TABLE) : ERROR 42P13 "cannot change
--     return type of existing function". DROP FUNCTION explicite obligatoire
--     AVANT le CREATE (le DROP révoque les GRANT → re-GRANT après le CREATE,
--     déjà présent plus bas). Signature exacte = celle du GRANT/contrat V0.10.2.
DROP FUNCTION IF EXISTS rpps_in_radius(
  double precision, double precision, double precision,
  text[], text[], text[], text[], integer
);

CREATE OR REPLACE FUNCTION rpps_in_radius(
  p_lat DOUBLE PRECISION, p_lon DOUBLE PRECISION, p_radius_meters DOUBLE PRECISION,
  p_profession_codes TEXT[], p_savoir_faire_codes TEXT[], p_mode_exercice_codes TEXT[],
  p_categorie_codes TEXT[], p_limit INT
) RETURNS TABLE (
  id BIGINT, rpps_id TEXT, civilite TEXT, nom TEXT, prenom TEXT,
  profession_code TEXT, profession_libelle TEXT,
  savoir_faire_code TEXT, savoir_faire_libelle TEXT,
  mode_exercice_code TEXT, mode_exercice_libelle TEXT,
  categorie_code TEXT, categorie_libelle TEXT,
  num_finess TEXT, num_finess_ej TEXT, siret TEXT, raison_sociale TEXT,
  adresse TEXT, code_postal CHAR(5), ville TEXT,
  code_departement CHAR(3), code_insee CHAR(5), telephone TEXT,
  geom JSONB, distance_meters DOUBLE PRECISION,
  geo_precision TEXT
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
  v_centroid_total BIGINT;
BEGIN
  -- Sentinelle P0002 anti-"0 silencieux" (matview vide). Conservée V0.10.2.
  SELECT COUNT(*) INTO v_centroid_total FROM rpps_commune_centroids;
  IF v_centroid_total = 0 THEN
    RAISE EXCEPTION 'rpps_commune_centroids matview is empty (cardinality 0). Refusing to return zero rows silently — run REFRESH MATERIALIZED VIEW rpps_commune_centroids.'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  WITH
  -- F2 : branche précise sur-fetch p_limit, distance EXACTE, index PARTIEL.
  precise AS (
    SELECT r.id, r.rpps_id, r.civilite, r.nom, r.prenom,
           r.profession_code, r.profession_libelle,
           r.savoir_faire_code, r.savoir_faire_libelle,
           r.mode_exercice_code, r.mode_exercice_libelle,
           r.categorie_code, r.categorie_libelle,
           r.num_finess, r.num_finess_ej, r.siret, r.raison_sociale,
           r.adresse, r.code_postal, r.ville,
           r.code_departement, r.code_insee, r.telephone,
           ST_AsGeoJSON(r.geom)::jsonb AS geom,
           ST_Distance(r.geog, v_point) AS distance_meters,
           CASE r.geom_source
             WHEN 'ban_address' THEN 'adresse'
             WHEN 'finess_join' THEN 'etablissement_finess'
           END::text AS geo_precision
    FROM rpps r
    WHERE r.geom_source IN ('finess_join','ban_address')          -- match exact index partiel
      AND ST_DWithin(r.geog, v_point, p_radius_meters)
      AND (cardinality(p_profession_codes)    = 0 OR r.profession_code    = ANY(p_profession_codes))
      AND (cardinality(p_savoir_faire_codes)  = 0 OR r.savoir_faire_code  = ANY(p_savoir_faire_codes))
      AND (cardinality(p_mode_exercice_codes) = 0 OR r.mode_exercice_code = ANY(p_mode_exercice_codes))
      AND rpps_categorie_match(r.categorie_code, p_categorie_codes)
    ORDER BY distance_meters
    LIMIT p_limit
  ),
  -- F1 : branche centroïde RÉSIDUELLE — geom_source='commune_centroid' AJOUTÉ
  -- au LATERAL (sinon double-comptage des ban_address). Mécanique V0.10.2.
  communes AS (
    SELECT c.code_insee AS cc_insee, ST_Distance(c.geog, v_point) AS cdist
    FROM rpps_commune_centroids c
    WHERE ST_DWithin(c.geog, v_point, p_radius_meters)
  ),
  centroid AS (
    SELECT x.id, x.rpps_id, x.civilite, x.nom, x.prenom,
           x.profession_code, x.profession_libelle,
           x.savoir_faire_code, x.savoir_faire_libelle,
           x.mode_exercice_code, x.mode_exercice_libelle,
           x.categorie_code, x.categorie_libelle,
           x.num_finess, x.num_finess_ej, x.siret, x.raison_sociale,
           x.adresse, x.code_postal, x.ville,
           x.code_departement, x.code_insee, x.telephone,
           x.geom, x.distance_meters, 'centroide_commune'::text AS geo_precision
    FROM communes cm
    CROSS JOIN LATERAL (
      SELECT r.id, r.rpps_id, r.civilite, r.nom, r.prenom,
             r.profession_code, r.profession_libelle,
             r.savoir_faire_code, r.savoir_faire_libelle,
             r.mode_exercice_code, r.mode_exercice_libelle,
             r.categorie_code, r.categorie_libelle,
             r.num_finess, r.num_finess_ej, r.siret, r.raison_sociale,
             r.adresse, r.code_postal, r.ville,
             r.code_departement, r.code_insee, r.telephone,
             ST_AsGeoJSON(r.geom)::jsonb AS geom,
             cm.cdist AS distance_meters
      FROM rpps r
      WHERE r.code_insee = cm.cc_insee
        AND r.geom_source = 'commune_centroid'                     -- F1 disjonction
        AND (cardinality(p_profession_codes)    = 0 OR r.profession_code    = ANY(p_profession_codes))
        AND (cardinality(p_savoir_faire_codes)  = 0 OR r.savoir_faire_code  = ANY(p_savoir_faire_codes))
        AND (cardinality(p_mode_exercice_codes) = 0 OR r.mode_exercice_code = ANY(p_mode_exercice_codes))
        AND rpps_categorie_match(r.categorie_code, p_categorie_codes)
      ORDER BY r.id
      LIMIT p_limit
    ) x
  )
  -- UNION ALL : ensembles disjoints par construction (precise = finess_join|
  -- ban_address ; centroid = commune_centroid). Tri global F2.
  SELECT * FROM precise
  UNION ALL
  SELECT * FROM centroid
  ORDER BY distance_meters, id
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION rpps_in_radius(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  TEXT[], TEXT[], TEXT[], TEXT[], INT
) TO anon;

-- ──────────────────────────────────────────────────────────────────────────
-- (4) ingest_refresh_matview : whitelist INCHANGÉE (rpps_commune_centroids déjà
--     présente V0.10.2). Reproduction VERBATIM de la définition V0.10.2
--     (20260515T030000) — superset strict, idempotent OR REPLACE.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ingest_refresh_matview(p_matview TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10min'
AS $$
BEGIN
  IF p_matview NOT IN (
    'rpps_savoir_faire_stats',
    'rpps_count_stats',
    'ameli_nomenclature_stats',
    'rpps_commune_centroids'
  ) THEN
    RAISE EXCEPTION 'ingest_refresh_matview: matview % not in whitelist', p_matview
      USING ERRCODE = '22023';
  END IF;

  EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY %I', p_matview);
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_refresh_matview(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_refresh_matview(TEXT) TO service_role;

COMMENT ON FUNCTION ingest_refresh_matview IS
  'V0.10.2 — REFRESH MATERIALIZED VIEW CONCURRENTLY avec whitelist (rpps_savoir_faire_stats, rpps_count_stats, ameli_nomenclature_stats, rpps_commune_centroids). Appelé par scripts/ingest/{rpps,ameli}.ts post-swap.';

-- ──────────────────────────────────────────────────────────────────────────
-- (5) ingest_create_rpps_staging : SUPERSET STRICT (règle NON NÉGOCIABLE).
--     Reproduction VERBATIM de 20260515T030000:274-358 + AJOUT UNIQUE du
--     mirror de l'index GiST partiel sur rpps_staging
--     (`rpps_staging_geog_precise_gist`, clause WHERE identique à l'index
--     prod `rpps_geog_precise_gist` — gardée par staging-parity étendu Task 3).
--     Aucun index existant retiré.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ingest_create_rpps_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  DROP TABLE IF EXISTS rpps_staging CASCADE;
  CREATE TABLE rpps_staging (
    id                       BIGSERIAL PRIMARY KEY,
    rpps_id                  TEXT         NOT NULL,
    identifiant_pp           TEXT,
    civilite                 TEXT,
    nom                      TEXT         NOT NULL,
    prenom                   TEXT         NOT NULL,
    profession_code          TEXT,
    profession_libelle       TEXT,
    categorie_code           TEXT,
    categorie_libelle        TEXT,
    savoir_faire_code        TEXT,
    savoir_faire_libelle     TEXT,
    mode_exercice_code       TEXT,
    mode_exercice_libelle    TEXT,
    num_finess               TEXT,
    num_finess_ej            TEXT,
    siret                    TEXT,
    siren                    TEXT,
    raison_sociale           TEXT,
    enseigne_commerciale     TEXT,
    secteur_activite_libelle TEXT,
    adresse                  TEXT,
    code_postal              CHAR(5),
    ville                    TEXT,
    code_departement         CHAR(3),
    code_insee               CHAR(5),
    telephone                TEXT,
    email                    TEXT,
    geom                     geometry(Point, 4326),
    geog                     GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
    geom_source              TEXT,
    raw                      JSONB,
    created_at               TIMESTAMPTZ  DEFAULT now()
  );
  -- V0.11.0 — PAS de mirror `rpps_staging_geog_gist` (GiST GLOBAL) : son
  -- équivalent prod `rpps_geog_gist` est DROPPÉ section (0). Le recréer ici
  -- le réintroduirait au prochain swap mensuel (= P0 latent post-Phase 2).
  -- staging-parity reste cohérent : prod-vivant = creates − drops, et le
  -- DROP INDEX rpps_geog_gist; section (0) le sort du set exigé.
  CREATE INDEX rpps_staging_rpps_id_idx          ON rpps_staging (rpps_id);
  CREATE INDEX rpps_staging_dept_idx             ON rpps_staging (code_departement);
  CREATE INDEX rpps_staging_profession_idx       ON rpps_staging (profession_code);
  CREATE INDEX rpps_staging_mode_idx             ON rpps_staging (mode_exercice_code);
  CREATE INDEX rpps_staging_num_finess_idx       ON rpps_staging (num_finess);
  CREATE INDEX rpps_staging_savoir_faire_idx     ON rpps_staging (savoir_faire_code);
  CREATE INDEX rpps_staging_insee_idx            ON rpps_staging (code_insee);
  CREATE INDEX rpps_staging_categorie_idx        ON rpps_staging (categorie_code);
  -- Composite indexes — must mirror prod so swap rename preserves them.
  CREATE INDEX rpps_staging_dept_profession_idx   ON rpps_staging (code_departement, profession_code);
  CREATE INDEX rpps_staging_dept_savoir_faire_idx ON rpps_staging (code_departement, savoir_faire_code);
  CREATE INDEX rpps_staging_dept_mode_idx         ON rpps_staging (code_departement, mode_exercice_code);
  CREATE INDEX rpps_staging_dept_categorie_idx    ON rpps_staging (code_departement, categorie_code);
  CREATE INDEX rpps_staging_dept_insee_sort_idx   ON rpps_staging (code_departement, code_insee, nom, prenom, id);
  CREATE INDEX rpps_staging_pending_enrichment_idx ON rpps_staging (id)
    WHERE geom IS NULL AND num_finess IS NOT NULL AND geom_source IS NULL;
  CREATE INDEX rpps_staging_geom_source_idx       ON rpps_staging (geom_source);
  -- V0.10.2 — mirror des index prod ajoutés après 20260510T020000 (sinon
  -- perdus au swap mensuel). Trigram : `rpps_search_by_name`. Partiel :
  -- `lister_specialites_medicales` / `rpps_par_specialite_dept`. Composite
  -- (code_insee, id) : early-stop déterministe du LATERAL rpps_in_radius
  -- (sans lui, P0 57014 régresse sur commune dense au prochain swap).
  CREATE INDEX rpps_staging_nom_trgm_idx
    ON rpps_staging USING GIN (lower(nom) extensions.gin_trgm_ops);
  CREATE INDEX rpps_staging_prenom_trgm_idx
    ON rpps_staging USING GIN (lower(prenom) extensions.gin_trgm_ops);
  CREATE INDEX rpps_staging_profession_savoir_faire_partial_idx
    ON rpps_staging (profession_code, savoir_faire_code)
    WHERE savoir_faire_code IS NOT NULL;
  CREATE INDEX rpps_staging_insee_id_idx
    ON rpps_staging (code_insee, id);
  -- V0.11.0 — mirror de l'index GiST PARTIEL prod `rpps_geog_precise_gist`
  -- (sinon perdu/clause perdue au swap mensuel — P6). Clause WHERE IDENTIQUE
  -- à l'index prod (gardée par scripts/ingest/staging-parity.test.ts étendu).
  CREATE INDEX rpps_staging_geog_precise_gist
    ON rpps_staging USING GIST (geog)
    WHERE geom_source IN ('finess_join','ban_address');

  ALTER TABLE rpps_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read rpps" ON rpps_staging FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_rpps_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_rpps_staging TO service_role;

-- (6) ANALYZE post-DROP : sans le GiST global concurrent, le planner doit
--     router la branche précise vers `rpps_geog_precise_gist`. Stats à
--     rafraîchir après le DROP section (0) (sinon plan figé). Le swap mensuel
--     doit AUSSI ANALYZE la table post-swap (voir scripts/ingest/rpps.ts —
--     wiring traité en Phase 2 pour que le correctif soit durable au cron).
ANALYZE rpps;
