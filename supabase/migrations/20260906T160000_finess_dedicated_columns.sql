-- FINESS phase 2, clôture (items 2 + 10 du backlog, plan
-- docs/plans/finess-phase-2-cloture.md) — colonnes dédiées `siret`, `cle_ban`,
-- `score_ban`, `geom_source` ; la provenance du point sort de `raw` et est
-- exposée par les RPC de lecture (→ `geo_precision` par résultat côté lib).
--
-- Mesure prod du 2026-09-06 (104 734 EGE en service) : geom_source `ans`
-- 78 243, `previous_ingest` 21 222, `ban_address` 2 720, sans point 2 549
-- (= 647 sans voie, jamais géocodables, + 1 902 rejets BAN) ; SIRET ANS
-- présent sur 91 542 lignes, tous bien formés ; 0 point sans provenance,
-- 0 provenance sans point, 0 valeur hors vocabulaire → la contrainte (2)
-- passe sur l'existant sans réécriture.
--
-- (1) ALTER finess + peuplement ONE-SHOT depuis raw (~105 K lignes, < 10 s).
--     Le cron suivant écrit les colonnes directement ; `raw` reste dans le
--     schéma, vide sur les nouveaux INSERT (comme depuis 20260509000001).
-- (2) Deux contraintes : vocabulaire FERMÉ (`ans` | `previous_ingest` |
--     `ban_address` — parité avec `GEOM_SOURCES` TS testée dans
--     `finess-column-rules-parity.test.ts`) et `geom ⇔ geom_source` : un
--     point a toujours une provenance, une ligne sans point n'en a jamais.
--     Toujours PAS de centroïde commune dans finess.geom (20260905T210000 :
--     le cron RPPS le recopierait en `finess_join`, tier précis).
-- (3) `ingest_create_finess_staging` recréée en SUPERSET STRICT de
--     20260509000001 (recopie VERBATIM + 4 colonnes + index siret + les 2
--     contraintes — parité gardée par `staging-parity.test.ts`, bloc finess).
-- (4) RPC d'ingestion réécrites (recopie VERBATIM de 20260906T120000 + la
--     colonne) : repli et pose écrivent `geom_source` (plus de
--     jsonb_build_object dans raw) ; la diff agrège la colonne.
--     `finess_is_ban_eligible`, `finess_count_ban_eligible_rows`,
--     `finess_eligible_rows_after_id`, `finess_count_ban_posable` INCHANGÉES
--     (elles ne touchent pas la provenance).
-- (5) RPC de lecture : DROP + recréation avec `siret` et `geom_source` dans
--     RETURNS TABLE (changement de signature de retour — CREATE OR REPLACE
--     seul échoue). Recopie VERBATIM de 20260508000014 + 2 colonnes, ET le
--     `SET statement_timeout = '15s'` que 20260528T130000 avait posé par
--     ALTER sur `finess_by_categorie` / `finess_by_num_finess` (un DROP le
--     perd ; `lookup-statement-timeout.test.ts` le garde). `finess_in_radius`
--     n'en a jamais eu (proconfig prod vérifié le 2026-09-06) : inchangé.
-- (6) `ingest_apply_finess_geom_batch` (Lambert 93 → WGS84, CSV DREES) :
--     SUPPRIMÉE. Plus câblée depuis la bascule ANS (seule mention restante =
--     un commentaire de shared.ts) et elle poserait un point SANS provenance,
--     ce que (2) interdit désormais — la garantie doit être réelle.
--
-- Migration T-format : PROD-ONLY, appliquée via MCP Supabase `apply_migration`
-- (la CLI la saute ; cf. mémoire migrations-t-format-canal-apply). Une seule
-- transaction : la fenêtre « RPC de lecture droppées » de (5) n'existe pas
-- pour un client.

-- ──────────────────────────────────────────────────────────────────────────
-- (1) finess prod — colonnes + peuplement depuis raw
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE finess
  ADD COLUMN IF NOT EXISTS siret       CHAR(14),
  ADD COLUMN IF NOT EXISTS cle_ban     TEXT,
  ADD COLUMN IF NOT EXISTS score_ban   REAL,
  ADD COLUMN IF NOT EXISTS geom_source TEXT;

UPDATE finess
   SET siret       = CASE WHEN raw->>'siret' ~ '^\d{14}$' THEN raw->>'siret' END,
       cle_ban     = raw->>'cle_ban',
       score_ban   = CASE WHEN raw->>'score_ban' ~ '^[0-9]+(\.[0-9]+)?$'
                          THEN (raw->>'score_ban')::REAL END,
       geom_source = CASE WHEN geom IS NOT NULL THEN raw->>'geom_source' END;

-- ──────────────────────────────────────────────────────────────────────────
-- (2) Contraintes — vocabulaire fermé + geom ⇔ geom_source
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE finess
  ADD CONSTRAINT finess_geom_source_vocab
    CHECK (geom_source IN ('ans', 'previous_ingest', 'ban_address')),
  ADD CONSTRAINT finess_geom_source_iff_geom
    CHECK ((geom IS NULL) = (geom_source IS NULL));

CREATE INDEX IF NOT EXISTS finess_siret_idx ON finess (siret) WHERE siret IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- (3) ingest_create_finess_staging — SUPERSET STRICT de 20260509000001
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
    created_at          TIMESTAMPTZ  DEFAULT now(),
    siret               CHAR(14),
    cle_ban             TEXT,
    score_ban           REAL,
    geom_source         TEXT,
    CONSTRAINT finess_geom_source_vocab
      CHECK (geom_source IN ('ans', 'previous_ingest', 'ban_address')),
    CONSTRAINT finess_geom_source_iff_geom
      CHECK ((geom IS NULL) = (geom_source IS NULL))
  );
  CREATE INDEX finess_staging_geom_gist           ON finess_staging USING GIST (geom);
  CREATE INDEX finess_staging_geog_gist           ON finess_staging USING GIST (geog);
  CREATE INDEX finess_staging_categorie_idx       ON finess_staging (categorie_code);
  CREATE INDEX finess_staging_code_dept_idx       ON finess_staging (code_departement);
  CREATE INDEX finess_staging_code_insee_idx      ON finess_staging (code_insee);
  CREATE INDEX finess_staging_dept_categorie_idx  ON finess_staging (code_departement, categorie_code);
  CREATE INDEX finess_staging_insee_categorie_idx ON finess_staging (code_insee, categorie_code);
  CREATE INDEX finess_staging_siret_idx           ON finess_staging (siret) WHERE siret IS NOT NULL;

  ALTER TABLE finess_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read finess" ON finess_staging FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_finess_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_finess_staging TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- (4) RPC d'ingestion — la provenance vit dans la colonne
-- ──────────────────────────────────────────────────────────────────────────

-- Repli previous_ingest : recopie VERBATIM de 20260906T120000 (3), la
-- provenance lue et écrite en colonne. Un point BAN hérité reste un point BAN.
CREATE OR REPLACE FUNCTION public.ingest_apply_finess_geom_previous()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE finess_staging s
     SET geom             = f.geom,
         coordx_lambert93 = COALESCE(s.coordx_lambert93, f.coordx_lambert93),
         coordy_lambert93 = COALESCE(s.coordy_lambert93, f.coordy_lambert93),
         geom_source      = CASE WHEN f.geom_source = 'ban_address'
                                 THEN 'ban_address'
                                 ELSE 'previous_ingest' END
    FROM finess f
   WHERE f.num_finess = s.num_finess
     AND s.geom IS NULL
     AND f.geom IS NOT NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

-- Pose BAN cache → staging : recopie VERBATIM de 20260906T120000 (1), la
-- provenance écrite en colonne. Acceptation par PRÉCISION (result_type),
-- jamais `municipality` dans finess.geom.
CREATE OR REPLACE FUNCTION ingest_apply_finess_ban_join()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE finess_staging s
     SET geom        = ST_SetSRID(ST_MakePoint(g.lon, g.lat), 4326),
         geom_source = 'ban_address'
    FROM geocoded_addresses g
   WHERE finess_is_ban_eligible(s.geom, s.voie)
     AND g.address_key = rpps_address_key_for_index(s.voie, s.code_postal::text, s.code_insee::text)
     AND g.accepted = true
     AND g.result_type IN ('housenumber', 'street', 'locality');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

-- Diff staging ↔ prod : recopie VERBATIM de 20260906T120000 (4), l'agrégat de
-- provenance lu sur la colonne (`none` = sans point, comme avant).
CREATE OR REPLACE FUNCTION public.ingest_finess_staging_diff()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'staging_rows',      (SELECT count(*) FROM finess_staging),
    'prod_rows',         (SELECT count(*) FROM finess),
    'prod_with_geom',    (SELECT count(*) FROM finess WHERE geom IS NOT NULL),
    'added',             (SELECT count(*) FROM finess_staging s
                           WHERE NOT EXISTS (SELECT 1 FROM finess f WHERE f.num_finess = s.num_finess)),
    'removed',           (SELECT count(*) FROM finess f
                           WHERE NOT EXISTS (SELECT 1 FROM finess_staging s WHERE s.num_finess = f.num_finess)),
    'lost_geom',         (SELECT count(*) FROM finess f
                           JOIN finess_staging s ON s.num_finess = f.num_finess
                          WHERE f.geom IS NOT NULL AND s.geom IS NULL),
    'moved_gt_500m',     (SELECT count(*) FROM finess_staging s
                           JOIN finess f ON f.num_finess = s.num_finess
                          WHERE s.geog IS NOT NULL AND f.geog IS NOT NULL
                            AND NOT ST_DWithin(s.geog, f.geog, 500)),
    'staging_geom_null', (SELECT count(*) FROM finess_staging WHERE geom IS NULL),
    'staging_no_voie',   (SELECT count(*) FROM finess_staging WHERE geom IS NULL AND voie IS NULL),
    'staging_geom_source', (SELECT COALESCE(jsonb_object_agg(src, n), '{}'::jsonb)
                              FROM (SELECT COALESCE(geom_source, 'none') AS src, count(*) AS n
                                      FROM finess_staging GROUP BY 1) t)
  ) INTO v;
  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ingest_apply_finess_geom_previous() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_apply_finess_ban_join()             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ingest_finess_staging_diff()        FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.ingest_apply_finess_geom_previous() TO service_role;
GRANT  EXECUTE ON FUNCTION ingest_apply_finess_ban_join()             TO service_role;
GRANT  EXECUTE ON FUNCTION public.ingest_finess_staging_diff()        TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- (5) RPC de lecture — siret + geom_source exposés
-- ──────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS finess_in_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], INT);
DROP FUNCTION IF EXISTS finess_by_categorie(TEXT[], TEXT, TEXT, INT);
DROP FUNCTION IF EXISTS finess_by_num_finess(TEXT);

CREATE OR REPLACE FUNCTION finess_in_radius(
  p_lat            DOUBLE PRECISION,
  p_lon            DOUBLE PRECISION,
  p_radius_meters  DOUBLE PRECISION,
  p_codes          TEXT[],
  p_limit          INT
) RETURNS TABLE (
  num_finess        CHAR(9),
  raison_sociale    TEXT,
  categorie_code    VARCHAR(4),
  categorie_libelle TEXT,
  voie              TEXT,
  code_postal       CHAR(5),
  code_departement  CHAR(3),
  code_insee        CHAR(5),
  ville             TEXT,
  telephone         VARCHAR(20),
  email             TEXT,
  geom              JSONB,
  distance_meters   DOUBLE PRECISION,
  siret             CHAR(14),
  geom_source       TEXT
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
BEGIN
  RETURN QUERY
  SELECT
    f.num_finess, f.raison_sociale, f.categorie_code, f.categorie_libelle,
    f.voie, f.code_postal, f.code_departement, f.code_insee, f.ville,
    f.telephone, f.email,
    ST_AsGeoJSON(f.geom)::jsonb AS geom,
    ST_Distance(f.geog, v_point) AS distance_meters,
    f.siret, f.geom_source
  FROM finess f
  WHERE f.geog IS NOT NULL
    AND ST_DWithin(f.geog, v_point, p_radius_meters)
    AND (cardinality(p_codes) = 0 OR f.categorie_code = ANY(p_codes))
  ORDER BY f.geog <-> v_point
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION finess_by_categorie(
  p_codes       TEXT[],
  p_departement TEXT,
  p_code_insee  TEXT,
  p_limit       INT
) RETURNS TABLE (
  num_finess        CHAR(9),
  raison_sociale    TEXT,
  categorie_code    VARCHAR(4),
  categorie_libelle TEXT,
  voie              TEXT,
  code_postal       CHAR(5),
  code_departement  CHAR(3),
  code_insee        CHAR(5),
  ville             TEXT,
  telephone         VARCHAR(20),
  email             TEXT,
  geom              JSONB,
  distance_meters   DOUBLE PRECISION,
  siret             CHAR(14),
  geom_source       TEXT
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
SET statement_timeout = '15s'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    f.num_finess, f.raison_sociale, f.categorie_code, f.categorie_libelle,
    f.voie, f.code_postal, f.code_departement, f.code_insee, f.ville,
    f.telephone, f.email,
    ST_AsGeoJSON(f.geom)::jsonb AS geom,
    NULL::DOUBLE PRECISION AS distance_meters,
    f.siret, f.geom_source
  FROM finess f
  WHERE f.categorie_code = ANY(p_codes)
    AND (p_departement IS NULL OR f.code_departement = p_departement)
    AND (p_code_insee IS NULL OR f.code_insee = p_code_insee)
  ORDER BY f.code_insee, f.num_finess
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION finess_by_num_finess(
  p_num_finess TEXT
) RETURNS TABLE (
  num_finess        CHAR(9),
  raison_sociale    TEXT,
  categorie_code    VARCHAR(4),
  categorie_libelle TEXT,
  voie              TEXT,
  code_postal       CHAR(5),
  code_departement  CHAR(3),
  code_insee        CHAR(5),
  ville             TEXT,
  telephone         VARCHAR(20),
  email             TEXT,
  geom              JSONB,
  distance_meters   DOUBLE PRECISION,
  siret             CHAR(14),
  geom_source       TEXT
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
SET statement_timeout = '15s'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    f.num_finess, f.raison_sociale, f.categorie_code, f.categorie_libelle,
    f.voie, f.code_postal, f.code_departement, f.code_insee, f.ville,
    f.telephone, f.email,
    ST_AsGeoJSON(f.geom)::jsonb AS geom,
    NULL::DOUBLE PRECISION AS distance_meters,
    f.siret, f.geom_source
  FROM finess f
  WHERE f.num_finess = p_num_finess
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION finess_in_radius     TO anon;
GRANT EXECUTE ON FUNCTION finess_by_categorie  TO anon;
GRANT EXECUTE ON FUNCTION finess_by_num_finess TO anon;

-- ──────────────────────────────────────────────────────────────────────────
-- (6) Ancienne pose Lambert 93 (CSV DREES) — retirée
-- ──────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS ingest_apply_finess_geom_batch(INT);

NOTIFY pgrst, 'reload schema';
