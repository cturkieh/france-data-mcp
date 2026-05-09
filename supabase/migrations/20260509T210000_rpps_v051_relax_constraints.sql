-- V0.5.1 — RPPS : relax NOT NULL sur code_departement, ajout geom_source,
-- enrichissement post-INSERT via JOIN FINESS, filtre catégorie professionnelle.
--
-- Contexte : le 1er run V0.5.0 a skippé 43 % des PS (970 K / 2,23 M) car le
-- parser exigeait une adresse de structure matchée. Régression métier majeure :
-- les salariés CH/CHU, étudiants, retraités, remplaçants à domicile sont
-- exactement ce que RPPS apporte vs Ameli. On stocke désormais TOUS les PS
-- (skip uniquement no_identity), avec geom NULL si pas de match commune,
-- puis on enrichit post-INSERT via JOIN avec la table `finess` sur num_finess.
--
-- Migration additive, idempotente. La table `rpps` prod est vide (aucune
-- ingestion n'a réussi en V0.5.0), donc le DROP NOT NULL sur prod ne touche
-- aucune ligne. Le DDL de `ingest_create_rpps_staging` est recréé pour rester
-- un superset strict du schéma prod (toute colonne/index manquant côté staging
-- serait silencieusement perdu au swap atomic).

-- ──────────────────────────────────────────────────────────────────────────
-- (1) rpps prod — additif, idempotent
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE rpps ALTER COLUMN code_departement DROP NOT NULL;

ALTER TABLE rpps
  ADD COLUMN IF NOT EXISTS geom_source TEXT;

-- Index catégorie + composite dept,categorie. Sans le composite, le filtre
-- default `categorie_code IN ('C','M') OR categorie_code IS NULL` couplé au
-- WHERE code_departement = ... sur un dept dense (75, 13, ~150-200 K rows)
-- ne peut pas planifier proprement et flirte avec le timeout 57014 PostgREST.
CREATE INDEX IF NOT EXISTS rpps_categorie_idx       ON rpps (categorie_code);
CREATE INDEX IF NOT EXISTS rpps_dept_categorie_idx  ON rpps (code_departement, categorie_code);

-- ──────────────────────────────────────────────────────────────────────────
-- (2) Recréer ingest_create_rpps_staging — superset strict de mig 20260509T200000
--     + code_departement nullable, + geom_source, + 2 indexes catégorie
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
    -- V0.5.1 : NULL autorisé. Les PS sans adresse de structure (étudiants,
    -- retraités, libéraux à domicile) sont insérés avec dept dérivé du CP
    -- quand possible, NULL sinon. Le post-enrichissement FINESS comble une
    -- partie de ces NULL en joignant sur num_finess.
    code_departement         CHAR(3),
    code_insee               CHAR(5),
    telephone                TEXT,
    email                    TEXT,
    geom                     geometry(Point, 4326),
    geog                     GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
    -- V0.5.1 : trace la provenance du geom pour observabilité.
    -- 'commune_centroid' = match CP+ville → centroïde commune INSEE (~3 km moyenne)
    -- 'finess_join'      = enrichi post-INSERT via JOIN finess sur num_finess (précision adresse)
    -- NULL              = pas de geom (PS sans adresse exploitable, non géolocalisable)
    geom_source              TEXT,
    raw                      JSONB,
    created_at               TIMESTAMPTZ  DEFAULT now()
  );
  CREATE INDEX rpps_staging_geog_gist            ON rpps_staging USING GIST (geog);
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
  -- Index partiel pour la phase d'enrichissement FINESS : restreint le scan
  -- de la CTE batch (`WHERE geom IS NULL AND num_finess IS NOT NULL AND
  -- geom_source IS NULL`) aux rows éligibles plutôt qu'aux 2,2 M. À chaque
  -- batch, les rows updatées sortent du predicate (geom_source devient
  -- 'finess_join' ou 'finess_unmatched') donc le scan rétrécit naturellement.
  CREATE INDEX rpps_staging_pending_enrichment_idx ON rpps_staging (id)
    WHERE geom IS NULL AND num_finess IS NOT NULL AND geom_source IS NULL;
  -- Index pour le count post-enrichissement (`WHERE geom_source = 'finess_join'`)
  -- qui sinon ferait un seq scan ~5s sur 2,2 M rows. Staging-only (jamais lu
  -- côté tools MCP — la prod utilise les indexes de query, pas geom_source).
  CREATE INDEX rpps_staging_geom_source_idx       ON rpps_staging (geom_source);

  ALTER TABLE rpps_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read rpps" ON rpps_staging FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_rpps_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_rpps_staging TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- (3) ingest_apply_rpps_finess_enrichment_batch
--     Opère sur rpps_staging avant le swap atomic. Single UPDATE avec
--     LEFT JOIN finess + CASE WHEN : la row de la batch est toujours touchée,
--     mais geom_source distingue 'finess_join' (match avec coords) de
--     'finess_unmatched' (visited, sans match exploitable). La sentinelle
--     'finess_unmatched' sort la row du predicate `geom_source IS NULL` du
--     prochain scan — sans ça, les rows non-matchables collent en tête de
--     batch (ORDER BY id stable) et saturent les itérations suivantes, ce
--     qui ferait sortir runBatchedRpc sur ROW_COUNT=0 alors que des rows
--     matchables à plus haut id n'ont jamais été visitées.
--     Retour = nombre de rows visitées (matched + unmatched) ; 0 = plus rien
--     dans la file → la boucle TS sort proprement.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ingest_apply_rpps_finess_enrichment_batch(p_limit INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_updated INT;
BEGIN
  WITH batch AS (
    SELECT id, num_finess
    FROM rpps_staging
    WHERE geom IS NULL
      AND num_finess IS NOT NULL
      AND geom_source IS NULL
    ORDER BY id
    LIMIT p_limit
  )
  UPDATE rpps_staging r
  SET
    geom             = CASE WHEN f.geom IS NOT NULL THEN f.geom             ELSE r.geom END,
    code_insee       = CASE WHEN f.geom IS NOT NULL THEN f.code_insee       ELSE r.code_insee END,
    code_departement = CASE WHEN f.geom IS NOT NULL THEN f.code_departement ELSE r.code_departement END,
    geom_source      = CASE WHEN f.geom IS NOT NULL THEN 'finess_join'      ELSE 'finess_unmatched' END
  FROM batch b
  LEFT JOIN finess f ON f.num_finess = b.num_finess
  WHERE r.id = b.id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_apply_rpps_finess_enrichment_batch FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_apply_rpps_finess_enrichment_batch TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- (4) Helper rpps_categorie_match — source unique pour la sémantique du
--     filtre catégorie. cardinality = 0 → default actifs (`C`/`M`/NULL pour
--     ne pas exclure silencieusement les rows à code catégorie absent, cf.
--     valider empiriquement la distribution post-1er-run et étendre la
--     liste si un code actif attendu apparaît). cardinality > 0 → filtre
--     exact ANY. IMMUTABLE pour permettre l'inlining par le planner.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION rpps_categorie_match(
  p_code  TEXT,
  p_codes TEXT[]
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
  -- IS NULL inclus dans LES DEUX branches : un caller MCP qui passe la
  -- sentinelle exhaustive `CATEGORIE_CODES_TOUS_STATUTS` (via `include_inactifs:true`)
  -- attend strictement plus de rows que le default actifs — sans ce OR
  -- les rows à categorie_code IS NULL seraient silencieusement exclues,
  -- soit l'inverse de l'intention. Convention de cette API : NULL est
  -- toujours considéré comme « actif inconnu » (cf. valider la distribution
  -- post-1er-run et étendre la liste si un code actif attendu apparaît).
  SELECT
    CASE
      WHEN cardinality(p_codes) = 0 THEN p_code IN ('C', 'M') OR p_code IS NULL
      ELSE p_code = ANY(p_codes) OR p_code IS NULL
    END;
$$;

GRANT EXECUTE ON FUNCTION rpps_categorie_match TO anon;

-- ──────────────────────────────────────────────────────────────────────────
-- (5) RPCs de query — ajoute p_categorie_codes TEXT[] aux 3 query RPCs.
--     DROP FUNCTION nécessaire : ajout d'un param change la signature, sinon
--     CREATE OR REPLACE échoue avec "cannot change return type".
-- ──────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS rpps_in_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], TEXT[], TEXT[], INT);
DROP FUNCTION IF EXISTS rpps_par_specialite_dept(TEXT, TEXT, TEXT, TEXT, INT, INT);
DROP FUNCTION IF EXISTS rpps_dans_etablissement(TEXT, INT);

CREATE OR REPLACE FUNCTION rpps_in_radius(
  p_lat                 DOUBLE PRECISION,
  p_lon                 DOUBLE PRECISION,
  p_radius_meters       DOUBLE PRECISION,
  p_profession_codes    TEXT[],
  p_savoir_faire_codes  TEXT[],
  p_mode_exercice_codes TEXT[],
  p_categorie_codes     TEXT[],
  p_limit               INT
) RETURNS TABLE (
  id                       BIGINT,
  rpps_id                  TEXT,
  civilite                 TEXT,
  nom                      TEXT,
  prenom                   TEXT,
  profession_code          TEXT,
  profession_libelle       TEXT,
  savoir_faire_code        TEXT,
  savoir_faire_libelle     TEXT,
  mode_exercice_code       TEXT,
  mode_exercice_libelle    TEXT,
  categorie_code           TEXT,
  categorie_libelle        TEXT,
  num_finess               TEXT,
  num_finess_ej            TEXT,
  siret                    TEXT,
  raison_sociale           TEXT,
  adresse                  TEXT,
  code_postal              CHAR(5),
  ville                    TEXT,
  code_departement         CHAR(3),
  code_insee               CHAR(5),
  telephone                TEXT,
  geom                     JSONB,
  distance_meters          DOUBLE PRECISION
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_point geography := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
BEGIN
  RETURN QUERY
  SELECT
    r.id, r.rpps_id, r.civilite, r.nom, r.prenom,
    r.profession_code, r.profession_libelle,
    r.savoir_faire_code, r.savoir_faire_libelle,
    r.mode_exercice_code, r.mode_exercice_libelle,
    r.categorie_code, r.categorie_libelle,
    r.num_finess, r.num_finess_ej, r.siret, r.raison_sociale,
    r.adresse, r.code_postal, r.ville,
    r.code_departement, r.code_insee, r.telephone,
    ST_AsGeoJSON(r.geom)::jsonb AS geom,
    ST_Distance(r.geog, v_point) AS distance_meters
  FROM rpps r
  WHERE r.geog IS NOT NULL
    AND ST_DWithin(r.geog, v_point, p_radius_meters)
    AND (cardinality(p_profession_codes)    = 0 OR r.profession_code    = ANY(p_profession_codes))
    AND (cardinality(p_savoir_faire_codes)  = 0 OR r.savoir_faire_code  = ANY(p_savoir_faire_codes))
    AND (cardinality(p_mode_exercice_codes) = 0 OR r.mode_exercice_code = ANY(p_mode_exercice_codes))
    AND rpps_categorie_match(r.categorie_code, p_categorie_codes)
  ORDER BY r.geog <-> v_point
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION rpps_par_specialite_dept(
  p_departement        TEXT,
  p_profession_code    TEXT,
  p_savoir_faire_code  TEXT,
  p_mode_exercice_code TEXT,
  p_categorie_codes    TEXT[],
  p_limit              INT,
  p_offset             INT
) RETURNS TABLE (
  id                       BIGINT,
  rpps_id                  TEXT,
  civilite                 TEXT,
  nom                      TEXT,
  prenom                   TEXT,
  profession_code          TEXT,
  profession_libelle       TEXT,
  savoir_faire_code        TEXT,
  savoir_faire_libelle     TEXT,
  mode_exercice_code       TEXT,
  mode_exercice_libelle    TEXT,
  categorie_code           TEXT,
  categorie_libelle        TEXT,
  num_finess               TEXT,
  num_finess_ej            TEXT,
  siret                    TEXT,
  raison_sociale           TEXT,
  adresse                  TEXT,
  code_postal              CHAR(5),
  ville                    TEXT,
  code_departement         CHAR(3),
  code_insee               CHAR(5),
  telephone                TEXT,
  geom                     JSONB
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id, r.rpps_id, r.civilite, r.nom, r.prenom,
    r.profession_code, r.profession_libelle,
    r.savoir_faire_code, r.savoir_faire_libelle,
    r.mode_exercice_code, r.mode_exercice_libelle,
    r.categorie_code, r.categorie_libelle,
    r.num_finess, r.num_finess_ej, r.siret, r.raison_sociale,
    r.adresse, r.code_postal, r.ville,
    r.code_departement, r.code_insee, r.telephone,
    ST_AsGeoJSON(r.geom)::jsonb AS geom
  FROM rpps r
  WHERE r.code_departement = p_departement
    AND (p_profession_code    IS NULL OR r.profession_code    = p_profession_code)
    AND (p_savoir_faire_code  IS NULL OR r.savoir_faire_code  = p_savoir_faire_code)
    AND (p_mode_exercice_code IS NULL OR r.mode_exercice_code = p_mode_exercice_code)
    AND rpps_categorie_match(r.categorie_code, p_categorie_codes)
  ORDER BY r.code_insee NULLS LAST, r.nom, r.prenom, r.id
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION rpps_dans_etablissement(
  p_num_finess      TEXT,
  p_categorie_codes TEXT[],
  p_limit           INT
) RETURNS TABLE (
  id                       BIGINT,
  rpps_id                  TEXT,
  civilite                 TEXT,
  nom                      TEXT,
  prenom                   TEXT,
  profession_code          TEXT,
  profession_libelle       TEXT,
  savoir_faire_code        TEXT,
  savoir_faire_libelle     TEXT,
  mode_exercice_code       TEXT,
  mode_exercice_libelle    TEXT,
  categorie_code           TEXT,
  categorie_libelle        TEXT,
  num_finess               TEXT,
  num_finess_ej            TEXT,
  raison_sociale           TEXT,
  telephone                TEXT
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id, r.rpps_id, r.civilite, r.nom, r.prenom,
    r.profession_code, r.profession_libelle,
    r.savoir_faire_code, r.savoir_faire_libelle,
    r.mode_exercice_code, r.mode_exercice_libelle,
    r.categorie_code, r.categorie_libelle,
    r.num_finess, r.num_finess_ej,
    r.raison_sociale, r.telephone
  FROM rpps r
  WHERE r.num_finess = p_num_finess
    AND rpps_categorie_match(r.categorie_code, p_categorie_codes)
  ORDER BY r.profession_libelle, r.nom, r.prenom
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION rpps_in_radius           TO anon;
GRANT EXECUTE ON FUNCTION rpps_par_specialite_dept TO anon;
GRANT EXECUTE ON FUNCTION rpps_dans_etablissement  TO anon;

NOTIFY pgrst, 'reload schema';
