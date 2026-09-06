-- Suite de 20260906T160000 (revue efficiency du même jour, mesures prod).
--
-- (1) RPC de lecture FINESS : paramètres TEXT castés vers le type CHAR(n) de la
--     colonne. `WHERE f.num_finess = p_num_finess` compare CHAR(9) à TEXT →
--     Postgres caste la COLONNE ((num_finess)::text = $1), la PK devient
--     inutilisable, Filter sur 104 734 lignes. Post-mortem V0.10.1 (skill
--     db-gotchas) recopié verbatim depuis 20260508000014 puis 20260906T160000.
--     Mesuré prod 2026-09-06 : finess_by_num_finess 369-623 ms → 0,11 ms /
--     4 buffers ; finess_by_categorie (611, dept 75) 29,5 ms / 820 buffers →
--     2,0 ms / 40 buffers. `finess_code_insee_idx` avait idx_scan = 0 pour la
--     même raison. Le `SET statement_timeout = '15s'` de 20260528T130000 était
--     le symptôme de ce défaut ; conservé (filet cold-start). Cast côté
--     PARAMÈTRE (jamais la colonne) ; `::CHAR(n)` tronquerait en silence une
--     entrée trop longue — impossible ici : `requireFinessId` (9 chiffres) et
--     `assertValidDept`/`assertValidCodeInsee` gardent le boundary en amont.
--     `finess_in_radius` : `categorie_code VARCHAR = ANY(TEXT[])` est
--     binaire-compatible, pas de cast à ajouter ; inchangée.
-- (2) `finess_siret_idx` (prod + staging) RETIRÉ : aucun consommateur (les RPC
--     projettent `siret`, aucune ne filtre dessus ; le resolver part du
--     num_finess), 2 688 kB, idx_scan = 0, et un index de plus à maintenir sur
--     105 K INSERT par run. À recréer AVEC sa requête cible le jour où une
--     résolution SIRET → FINESS existe. `ingest_create_finess_staging`
--     recréée en recopie VERBATIM de 20260906T160000 moins cet index (parité
--     `staging-parity.test.ts`, plancher 7 index inchangé).
--
-- Migration T-format : PROD-ONLY, appliquée via MCP Supabase `apply_migration`.

DROP INDEX IF EXISTS finess_siret_idx;

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

  ALTER TABLE finess_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read finess" ON finess_staging FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_finess_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_finess_staging TO service_role;

-- Signatures inchangées → CREATE OR REPLACE suffit ; corps = 20260906T160000 + cast.
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
    AND (p_departement IS NULL OR f.code_departement = p_departement::CHAR(3))
    AND (p_code_insee IS NULL OR f.code_insee = p_code_insee::CHAR(5))
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
  WHERE f.num_finess = p_num_finess::CHAR(9)
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION finess_by_categorie  TO anon;
GRANT EXECUTE ON FUNCTION finess_by_num_finess TO anon;

NOTIFY pgrst, 'reload schema';
