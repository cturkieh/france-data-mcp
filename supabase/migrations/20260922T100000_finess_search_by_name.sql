-- Recherche FINESS par NOM d'établissement (plan docs/plans/finess-recherche-par-nom.md).
--
-- Pourquoi : « le nouveau quartier derrière l'IGR » — geo-intel envoyait le nom
-- à la BAN, qui ne connaît que des rues (→ « rue Gustave » n'importe où).
-- FINESS se cherchait par numéro, catégorie ou rayon, jamais par nom.
--
-- 1. `finess_nom_normalise(text)` : IMMUTABLE, jumeau SQL de
--    `normalizeForCompare` (src/core/text-match.ts) — minuscules, accents
--    français retirés (5,8 % des raisons sociales en portent, ex.
--    « RÉSIDENCE »), ponctuation → espace. Indexable ; `unaccent` n'est pas
--    IMMUTABLE et n'est pas installée.
-- 2. Index GIN trigramme sur cette expression, recopié VERBATIM dans
--    `ingest_create_finess_staging` (parité prod ↔ staging,
--    `staging-parity.test.ts`) — sinon perdu en silence au swap du 1er/15.
--    Mesuré avant index : seq scan, ~1 s par recherche.
-- 3. RPC `finess_search_by_name` : `word_similarity` (le nom cherché est un
--    SOUS-ENSEMBLE de la raison sociale : « gustave roussy » ⊂ « INSTITUT
--    GUSTAVE ROUSSY SITE VILLE JUIF » → 1.0), opérateur `<%` indexé, seuil GUC
--    posé sur la fonction. Territoire = HINT optionnel, casté CHAR(n) comme
--    les RPC jumelles (index utilisable). Tri similarité puis libellé le plus
--    court ; le rang par famille (hôpitaux avant pharmacies) vit en TS, source
--    unique `finess-categories.ts`.
--
-- Migration T-format : PROD-ONLY, appliquée via MCP Supabase `apply_migration`.

CREATE OR REPLACE FUNCTION finess_nom_normalise(p TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
SET search_path = public, extensions
AS $$
  SELECT btrim(
    regexp_replace(
      translate(
        lower(replace(replace(p, 'œ', 'oe'), 'æ', 'ae')),
        'àáâäãåçèéêëìíîïñòóôöõùúûüýÿ',
        'aaaaaaceeeeiiiinooooouuuuyy'
      ),
      '[.,''’\-\s]+', ' ', 'g'
    )
  )
$$;

-- Non CONCURRENTLY (105 K lignes, quelques secondes) : appliquer hors des
-- fenêtres du cron FINESS (1er et 15). Opclass qualifiée : ne dépend pas du
-- search_path de la session qui applique.
CREATE INDEX IF NOT EXISTS finess_nom_trgm_idx
  ON finess USING GIN (finess_nom_normalise(raison_sociale) extensions.gin_trgm_ops);

-- Staging-create : recopie VERBATIM de 20260906T170000 + l'index trigramme.
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
  CREATE INDEX finess_staging_nom_trgm_idx        ON finess_staging USING GIN (finess_nom_normalise(raison_sociale) extensions.gin_trgm_ops);

  ALTER TABLE finess_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read finess" ON finess_staging FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_finess_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_finess_staging TO service_role;

-- `p_insee_min/max` : plage INSEE (bornes incluses) — une commune ordinaire
-- passe `[code, code]`, Paris/Lyon/Marseille la plage de ses arrondissements
-- (`communeInseeRange`, source unique PLM du repo). Portée par la RPC, AVANT
-- son LIMIT : un post-filtre TS perdrait du rappel sur Lyon/Marseille (le
-- département 69 couvre tout le Rhône).
-- Le nom cherché est normalisé PAR LA MÊME fonction que la colonne : une seule
-- normalisation fait foi pour le match (le TS n'en fait qu'une validation).
CREATE OR REPLACE FUNCTION finess_search_by_name(
  p_query       TEXT,
  p_insee_min   TEXT,
  p_insee_max   TEXT,
  p_departement TEXT,
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
  siret             CHAR(14),
  geom_source       TEXT,
  similarite        REAL
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
SET statement_timeout = '15s'
-- Seuil du `<%` indexé. 0.5 = rappel large ; le seuil de DÉCISION (candidats
-- retenus, commune prouvée) vit en TS, mesuré sur des noms réels.
SET pg_trgm.word_similarity_threshold = 0.5
AS $$
BEGIN
  -- Une borne seule rendrait 0 ligne SANS erreur (BETWEEN x AND NULL) : refus.
  IF (p_insee_min IS NULL) <> (p_insee_max IS NULL) THEN
    RAISE EXCEPTION 'finess_search_by_name: p_insee_min et p_insee_max vont ensemble'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT
    f.num_finess, f.raison_sociale, f.categorie_code, f.categorie_libelle,
    f.voie, f.code_postal, f.code_departement, f.code_insee, f.ville,
    f.telephone, f.email,
    ST_AsGeoJSON(f.geom)::jsonb AS geom,
    f.siret, f.geom_source,
    word_similarity(finess_nom_normalise(p_query), finess_nom_normalise(f.raison_sociale))::REAL AS similarite
  FROM finess f
  WHERE finess_nom_normalise(p_query) <% finess_nom_normalise(f.raison_sociale)
    AND (p_insee_min IS NULL OR f.code_insee BETWEEN p_insee_min::CHAR(5) AND p_insee_max::CHAR(5))
    AND (p_departement IS NULL OR f.code_departement = p_departement::CHAR(3))
  -- Position 15 = similarite : le nom nu serait ambigu en plpgsql (paramètre OUT
  -- vs alias de colonne → 42702).
  ORDER BY 15 DESC, length(f.raison_sociale) ASC, f.num_finess
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION finess_search_by_name TO anon;

NOTIFY pgrst, 'reload schema';
