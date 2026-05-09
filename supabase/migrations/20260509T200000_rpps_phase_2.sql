-- V0.5 phase 2 — RPPS / Annuaire Santé ANS (libre accès, Licence Ouverte v2.0).
-- Source : data.gouv `annuaire-sante-extractions-...-rpps`, fichier
-- `ps-libreacces-personne-activite.txt` ~803 Mo, MAJ mensuelle.
--
-- Rationale : RPPS couvre TOUS les PS (libéraux + salariés + retraités),
-- là où Ameli ne couvre que les conventionnés libéraux. Apporte aussi un
-- ID national stable (IDNPS) qui permet le matching cross-source et le
-- pivot PS↔FINESS via `num_finess` (colonne `Numéro FINESS site` du CSV).
--
-- Ressemble à `annuaire_ameli` (centroïde commune comme géocodage,
-- BIGSERIAL PK, raw JSONB vide). Diffère par :
--   - `rpps_id` non-NULL et indexé (lookup individuel + dédup logique)
--   - colonnes structure (num_finess, siret, siren, ej_finess) pour les pivots
--   - `mode_exercice` (libéral / salarié / mixte) — la dimension qui débloque
--     les salariés vs Ameli
--   - `savoir_faire_*` = spécialité fine (DES/DESC) — granularité supérieure
--     à la spécialité Ameli, sans remplacer la nomenclature Ameli simple

CREATE TABLE IF NOT EXISTS rpps (
  id                       BIGSERIAL PRIMARY KEY,
  -- Identifiants
  rpps_id                  TEXT         NOT NULL,
  identifiant_pp           TEXT,
  -- Identité (au moment de l'exercice)
  civilite                 TEXT,
  nom                      TEXT         NOT NULL,
  prenom                   TEXT         NOT NULL,
  -- Profession (nomenclature ANS, distincte de la nomenclature Ameli)
  profession_code          TEXT,
  profession_libelle       TEXT,
  categorie_code           TEXT,
  categorie_libelle        TEXT,
  -- Spécialité fine (savoir-faire = DES/DESC/capacités)
  savoir_faire_code        TEXT,
  savoir_faire_libelle     TEXT,
  -- Mode d'exercice (libéral / salarié / mixte / volontariat)
  mode_exercice_code       TEXT,
  mode_exercice_libelle    TEXT,
  -- Structure d'exercice (le pivot PS ↔ FINESS)
  num_finess               TEXT,
  num_finess_ej            TEXT,
  siret                    TEXT,
  siren                    TEXT,
  raison_sociale           TEXT,
  enseigne_commerciale     TEXT,
  secteur_activite_libelle TEXT,
  -- Adresse de la structure
  adresse                  TEXT,
  code_postal              CHAR(5),
  ville                    TEXT,
  code_departement         CHAR(3)      NOT NULL,
  code_insee               CHAR(5),
  -- Contact (souvent vide en pratique, exposé pour la complétude)
  telephone                TEXT,
  email                    TEXT,
  -- Géo : centroïde commune comme Ameli. Le caller peut enrichir en
  -- joignant FINESS via `num_finess` quand il a besoin de précision.
  geom                     geometry(Point, 4326),
  geog                     GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
  raw                      JSONB,
  created_at               TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rpps_geog_gist        ON rpps USING GIST (geog);
CREATE INDEX IF NOT EXISTS rpps_rpps_id_idx      ON rpps (rpps_id);
CREATE INDEX IF NOT EXISTS rpps_dept_idx         ON rpps (code_departement);
CREATE INDEX IF NOT EXISTS rpps_profession_idx   ON rpps (profession_code);
CREATE INDEX IF NOT EXISTS rpps_mode_idx         ON rpps (mode_exercice_code);
CREATE INDEX IF NOT EXISTS rpps_num_finess_idx   ON rpps (num_finess);
CREATE INDEX IF NOT EXISTS rpps_savoir_faire_idx ON rpps (savoir_faire_code);
CREATE INDEX IF NOT EXISTS rpps_insee_idx        ON rpps (code_insee);
-- Composite indexes pour `rpps_par_specialite_dept` — sans ces composites, un
-- département dense (75, 13) en RPPS = ~150-200K rows, le tri sur 4 colonnes
-- déclenche timeout 57014 (PostgREST 60s). Bug Ameli déjà résolu en V0.4 via
-- la migration `composite_indexes` ; on l'évite dès le shipping côté RPPS.
CREATE INDEX IF NOT EXISTS rpps_dept_profession_idx   ON rpps (code_departement, profession_code);
CREATE INDEX IF NOT EXISTS rpps_dept_savoir_faire_idx ON rpps (code_departement, savoir_faire_code);
CREATE INDEX IF NOT EXISTS rpps_dept_mode_idx         ON rpps (code_departement, mode_exercice_code);

ALTER TABLE rpps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon read rpps" ON rpps;
CREATE POLICY "anon read rpps" ON rpps FOR SELECT TO anon USING (true);

-- Staging RPC. Schema identique à prod ; le swap rename préserve indexes,
-- policies, grants. SECURITY DEFINER car CREATE TABLE bloqué pour
-- service_role sur public schema (Supabase recent restriction).
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
    code_departement         CHAR(3)      NOT NULL,
    code_insee               CHAR(5),
    telephone                TEXT,
    email                    TEXT,
    geom                     geometry(Point, 4326),
    geog                     GEOGRAPHY GENERATED ALWAYS AS ((geom::geography)) STORED,
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
  -- Composite indexes — must mirror prod so swap rename preserves them.
  CREATE INDEX rpps_staging_dept_profession_idx   ON rpps_staging (code_departement, profession_code);
  CREATE INDEX rpps_staging_dept_savoir_faire_idx ON rpps_staging (code_departement, savoir_faire_code);
  CREATE INDEX rpps_staging_dept_mode_idx         ON rpps_staging (code_departement, mode_exercice_code);

  ALTER TABLE rpps_staging ENABLE ROW LEVEL SECURITY;
  -- Nom + USING clause MUST mirror prod policy so swap rename keeps anon SELECT.
  CREATE POLICY "anon read rpps" ON rpps_staging FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_rpps_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_rpps_staging TO service_role;

-- Query RPCs ---------------------------------------------------------------

DROP FUNCTION IF EXISTS rpps_in_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], TEXT[], TEXT[], INT);
DROP FUNCTION IF EXISTS rpps_par_specialite_dept(TEXT, TEXT, TEXT, TEXT, INT, INT);
DROP FUNCTION IF EXISTS rpps_dans_etablissement(TEXT, INT);
DROP FUNCTION IF EXISTS rpps_lookup_by_id(TEXT);

CREATE OR REPLACE FUNCTION rpps_in_radius(
  p_lat                 DOUBLE PRECISION,
  p_lon                 DOUBLE PRECISION,
  p_radius_meters       DOUBLE PRECISION,
  p_profession_codes    TEXT[],
  p_savoir_faire_codes  TEXT[],
  p_mode_exercice_codes TEXT[],
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
  ORDER BY r.geog <-> v_point
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION rpps_par_specialite_dept(
  p_departement       TEXT,
  p_profession_code   TEXT,
  p_savoir_faire_code TEXT,
  p_mode_exercice_code TEXT,
  p_limit             INT,
  p_offset            INT
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
    r.num_finess, r.num_finess_ej, r.siret, r.raison_sociale,
    r.adresse, r.code_postal, r.ville,
    r.code_departement, r.code_insee, r.telephone,
    ST_AsGeoJSON(r.geom)::jsonb AS geom
  FROM rpps r
  WHERE r.code_departement = p_departement
    AND (p_profession_code    IS NULL OR r.profession_code    = p_profession_code)
    AND (p_savoir_faire_code  IS NULL OR r.savoir_faire_code  = p_savoir_faire_code)
    AND (p_mode_exercice_code IS NULL OR r.mode_exercice_code = p_mode_exercice_code)
  ORDER BY r.code_insee NULLS LAST, r.nom, r.prenom, r.id
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- Killer feature : "qui travaille dans ce FINESS ?". Un seul WHERE indexé.
CREATE OR REPLACE FUNCTION rpps_dans_etablissement(
  p_num_finess TEXT,
  p_limit      INT
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
    r.num_finess, r.num_finess_ej,
    r.raison_sociale, r.telephone
  FROM rpps r
  WHERE r.num_finess = p_num_finess
  ORDER BY r.profession_libelle, r.nom, r.prenom
  LIMIT p_limit;
END;
$$;

-- Lookup individuel par ID RPPS (peut retourner N rows si multi-sites).
-- Le caller TS aplatit ensuite sur (rpps_id, sites[]).
CREATE OR REPLACE FUNCTION rpps_lookup_by_id(p_rpps_id TEXT)
RETURNS TABLE (
  id                       BIGINT,
  rpps_id                  TEXT,
  identifiant_pp           TEXT,
  civilite                 TEXT,
  nom                      TEXT,
  prenom                   TEXT,
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
  adresse                  TEXT,
  code_postal              CHAR(5),
  ville                    TEXT,
  code_departement         CHAR(3),
  code_insee               CHAR(5),
  telephone                TEXT,
  email                    TEXT,
  geom                     JSONB
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id, r.rpps_id, r.identifiant_pp, r.civilite, r.nom, r.prenom,
    r.profession_code, r.profession_libelle,
    r.categorie_code, r.categorie_libelle,
    r.savoir_faire_code, r.savoir_faire_libelle,
    r.mode_exercice_code, r.mode_exercice_libelle,
    r.num_finess, r.num_finess_ej, r.siret, r.siren,
    r.raison_sociale, r.adresse, r.code_postal, r.ville,
    r.code_departement, r.code_insee, r.telephone, r.email,
    ST_AsGeoJSON(r.geom)::jsonb AS geom
  FROM rpps r
  WHERE r.rpps_id = p_rpps_id
  ORDER BY r.id;
END;
$$;

GRANT EXECUTE ON FUNCTION rpps_in_radius           TO anon;
GRANT EXECUTE ON FUNCTION rpps_par_specialite_dept TO anon;
GRANT EXECUTE ON FUNCTION rpps_dans_etablissement  TO anon;
GRANT EXECUTE ON FUNCTION rpps_lookup_by_id        TO anon;

NOTIFY pgrst, 'reload schema';
