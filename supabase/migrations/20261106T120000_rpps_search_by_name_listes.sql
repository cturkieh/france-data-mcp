-- rpps_search_by_name : le trigramme ne parcourt plus les 2,3 M de lignes de rpps.
--
-- Mesures et variantes écartées : docs/experiences/2026-11-06-rpps-noms-distincts.md.
-- Avant : HTTP 500 (57014, coupure à 10 s) sur les noms courts à froid, et un plafond
-- de 2 000 candidats appliqué avant le tri, qui perdait des personnes.
-- Après : le trigramme cherche dans 2 petites listes de valeurs distinctes, puis les
-- lignes se lisent par égalité (rpps_nom_prenom_id_idx ou rpps_dept_insee_sort_idx).
--
-- Déploiement : appliquer ce fichier, prouver en prod, puis 20261106T130000. Les index
-- trigrammes de rpps restent jusque-là, pour pouvoir revenir à l'ancienne RPC sans
-- reconstruire d'index. La staging ne les crée plus : le prochain swap les retire.

SET LOCAL statement_timeout = '10min';

CREATE INDEX IF NOT EXISTS rpps_nom_prenom_id_idx ON rpps (nom, prenom, id);

-- ORDER BY : les noms proches tombent sur les mêmes pages, ce qui divise environ par 2
-- les lectures à froid (médiane de 2 129 à 1 087 sur l'échantillon).
CREATE MATERIALIZED VIEW rpps_noms AS
SELECT nom, lower(nom) AS nom_lower
FROM rpps
GROUP BY nom
ORDER BY nom_lower;
CREATE UNIQUE INDEX rpps_noms_pk ON rpps_noms (nom);
CREATE INDEX rpps_noms_trgm ON rpps_noms USING GIN (nom_lower extensions.gin_trgm_ops);
ANALYZE rpps_noms;
GRANT SELECT ON rpps_noms TO anon;

CREATE MATERIALIZED VIEW rpps_prenoms AS
SELECT prenom, lower(prenom) AS prenom_lower
FROM rpps
GROUP BY prenom
ORDER BY prenom_lower;
CREATE UNIQUE INDEX rpps_prenoms_pk ON rpps_prenoms (prenom);
CREATE INDEX rpps_prenoms_trgm ON rpps_prenoms USING GIN (prenom_lower extensions.gin_trgm_ops);
ANALYZE rpps_prenoms;
GRANT SELECT ON rpps_prenoms TO anon;

-- Appel séparé de ingest_rebuild_rpps_matviews : celle-ci prend 21,6 s et ces listes
-- 22 s (mesures prod), pour une passerelle PostgREST coupée à 60 s. Un échec ici ne
-- doit pas annuler les 3 autres matviews, et l'ancienne liste reste servie.
CREATE OR REPLACE FUNCTION ingest_rebuild_rpps_search_lists()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
BEGIN
  DROP MATERIALIZED VIEW IF EXISTS rpps_noms_rebuild CASCADE;
  CREATE MATERIALIZED VIEW rpps_noms_rebuild AS
SELECT nom, lower(nom) AS nom_lower
FROM rpps
GROUP BY nom
ORDER BY nom_lower;
  CREATE UNIQUE INDEX rpps_noms_rebuild_pk ON rpps_noms_rebuild (nom);
  CREATE INDEX rpps_noms_rebuild_trgm ON rpps_noms_rebuild USING GIN (nom_lower extensions.gin_trgm_ops);
  ANALYZE rpps_noms_rebuild;
  GRANT SELECT ON rpps_noms_rebuild TO anon;

  DROP MATERIALIZED VIEW IF EXISTS rpps_prenoms_rebuild CASCADE;
  CREATE MATERIALIZED VIEW rpps_prenoms_rebuild AS
SELECT prenom, lower(prenom) AS prenom_lower
FROM rpps
GROUP BY prenom
ORDER BY prenom_lower;
  CREATE UNIQUE INDEX rpps_prenoms_rebuild_pk ON rpps_prenoms_rebuild (prenom);
  CREATE INDEX rpps_prenoms_rebuild_trgm ON rpps_prenoms_rebuild USING GIN (prenom_lower extensions.gin_trgm_ops);
  ANALYZE rpps_prenoms_rebuild;
  GRANT SELECT ON rpps_prenoms_rebuild TO anon;

  -- Bascule à la fin seulement : le verrou du DROP tient jusqu'au commit et bloquerait
  -- les recherches pendant toute construction placée après lui. Même ordre que la RPC.
  DROP MATERIALIZED VIEW IF EXISTS rpps_noms;
  ALTER MATERIALIZED VIEW rpps_noms_rebuild RENAME TO rpps_noms;
  ALTER INDEX rpps_noms_rebuild_pk RENAME TO rpps_noms_pk;
  ALTER INDEX rpps_noms_rebuild_trgm RENAME TO rpps_noms_trgm;
  DROP MATERIALIZED VIEW IF EXISTS rpps_prenoms;
  ALTER MATERIALIZED VIEW rpps_prenoms_rebuild RENAME TO rpps_prenoms;
  ALTER INDEX rpps_prenoms_rebuild_pk RENAME TO rpps_prenoms_pk;
  ALTER INDEX rpps_prenoms_rebuild_trgm RENAME TO rpps_prenoms_trgm;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_rebuild_rpps_search_lists FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION ingest_rebuild_rpps_search_lists TO service_role;

-- Recopie VERBATIM de 20260519T160000, seuls les 2 index trigrammes sont remplacés.
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
  -- GiST PARTIEL (et NON global) : la branche `precise` de rpps_in_radius ne
  -- doit JAMAIS toucher le cluster co-localisé `commune_centroid`. Prédicat
  -- byte-identique au WHERE de `precise` / migration 20260516T050000 / guard
  -- staging-parity. Au swap → renommé `rpps_geog_precise_gist`. JAMAIS de
  -- GiST global `(geog);` ici (re-régression 57014, post-mortem 2026-05-19).
  CREATE INDEX rpps_staging_geog_precise_gist     ON rpps_staging USING GIST (geog)
    WHERE geom_source IN ('finess_join','ban_address');
  CREATE INDEX rpps_staging_rpps_id_idx          ON rpps_staging (rpps_id);
  CREATE INDEX rpps_staging_dept_idx             ON rpps_staging (code_departement);
  CREATE INDEX rpps_staging_profession_idx       ON rpps_staging (profession_code);
  CREATE INDEX rpps_staging_mode_idx             ON rpps_staging (mode_exercice_code);
  CREATE INDEX rpps_staging_num_finess_idx       ON rpps_staging (num_finess);
  CREATE INDEX rpps_staging_savoir_faire_idx     ON rpps_staging (savoir_faire_code);
  -- `rpps_staging_insee_idx (code_insee)` SUPPRIMÉ — redondant avec le
  -- composite `rpps_staging_insee_id_idx (code_insee, id)` plus bas.
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
  -- perdus au swap mensuel). (nom, prenom, id) : `rpps_search_by_name`. Partiel :
  -- `lister_specialites_medicales` / `rpps_par_specialite_dept`. Composite
  -- (code_insee, id) : early-stop déterministe du LATERAL rpps_in_radius
  -- (sans lui, P0 57014 régresse sur commune dense au prochain swap).
  CREATE INDEX rpps_staging_nom_prenom_id_idx
    ON rpps_staging (nom, prenom, id);
  CREATE INDEX rpps_staging_profession_savoir_faire_partial_idx
    ON rpps_staging (profession_code, savoir_faire_code)
    WHERE savoir_faire_code IS NOT NULL;
  CREATE INDEX rpps_staging_insee_id_idx
    ON rpps_staging (code_insee, id);

  ALTER TABLE rpps_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read rpps" ON rpps_staging FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

-- Même signature : pas de DROP, les droits sont conservés. Les deux SET sont portés ici :
-- CREATE OR REPLACE les efface sinon.
CREATE OR REPLACE FUNCTION rpps_search_by_name(
  p_nom              TEXT,
  p_prenom           TEXT,
  p_departement      TEXT,
  p_categorie_codes  TEXT[],
  p_limit            INT
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
  geo_precision            TEXT,
  match_score              REAL
)
LANGUAGE plpgsql STABLE
SET statement_timeout = '10s'
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_nom    TEXT    := lower(trim(p_nom));
  v_prenom TEXT    := lower(trim(coalesce(p_prenom, '')));
  v_categorie_codes TEXT[] := COALESCE(NULLIF(p_categorie_codes, ARRAY[]::TEXT[]), ARRAY['C']);
  v_noms    TEXT[];
  v_prenoms TEXT[];
  v_n       RECORD;
  v_reste   INT := LEAST(COALESCE(p_limit, 501), 501);  -- MAX_LIMIT + 1 côté lib
  v_lues    INT;
BEGIN
  IF v_nom IS NULL OR v_nom = '' THEN
    RAISE EXCEPTION 'p_nom is required (non empty)' USING ERRCODE = '22023';
  END IF;
  IF p_departement IS NOT NULL AND p_departement !~ '^(\d{2,3}|2A|2B)$' THEN
    RAISE EXCEPTION 'p_departement must match ^(\d{2,3}|2A|2B)$ (got: %)', p_departement
      USING ERRCODE = '22023';
  END IF;

  -- Presque toutes les lignes conviennent : on parcourt les noms du plus proche au
  -- plus lointain, lignes déjà triées par l'index, et on s'arrête à la limite.
  IF v_prenom = '' AND p_departement IS NULL AND v_categorie_codes @> ARRAY['C'] THEN
    FOR v_n IN
      SELECT n.nom, extensions.similarity(n.nom_lower, v_nom)::REAL AS score
      FROM rpps_noms n
      WHERE n.nom_lower % v_nom
      ORDER BY score DESC, n.nom
    LOOP
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
        CASE r.geom_source
          WHEN 'ban_address'      THEN 'adresse'
          WHEN 'finess_join'      THEN 'etablissement_finess'
          WHEN 'commune_centroid' THEN 'centroide_commune'
        END::text AS geo_precision,
        v_n.score
      FROM rpps r
      WHERE r.nom = v_n.nom
        AND (r.categorie_code = ANY(v_categorie_codes) OR r.categorie_code IS NULL)
      ORDER BY r.prenom, r.id
      LIMIT v_reste;
      GET DIAGNOSTICS v_lues = ROW_COUNT;
      v_reste := v_reste - v_lues;
      EXIT WHEN v_reste <= 0;
    END LOOP;
    RETURN;
  END IF;

  -- Filtre sélectif : une seule requête, le planificateur choisit l'index
  -- (département, catégorie, ou nom + prénom).
  SELECT array_agg(n.nom) INTO v_noms
  FROM rpps_noms n
  WHERE n.nom_lower % v_nom;
  IF v_noms IS NULL THEN
    RETURN;
  END IF;

  IF v_prenom <> '' THEN
    SELECT array_agg(n.prenom) INTO v_prenoms
    FROM rpps_prenoms n
    WHERE n.prenom_lower % v_prenom;
    IF v_prenoms IS NULL THEN
      RETURN;
    END IF;
  END IF;

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
    CASE r.geom_source
      WHEN 'ban_address'      THEN 'adresse'
      WHEN 'finess_join'      THEN 'etablissement_finess'
      WHEN 'commune_centroid' THEN 'centroide_commune'
    END::text AS geo_precision,
    (CASE WHEN v_prenom <> ''
      THEN (extensions.similarity(lower(r.nom), v_nom) + extensions.similarity(lower(r.prenom), v_prenom)) / 2.0
      ELSE extensions.similarity(lower(r.nom), v_nom)
    END)::REAL AS match_score
  FROM rpps r
  WHERE r.nom = ANY(v_noms)
    AND (v_prenoms IS NULL OR r.prenom = ANY(v_prenoms))
    AND (p_departement IS NULL OR r.code_departement = p_departement::CHAR(3))
    AND (r.categorie_code = ANY(v_categorie_codes) OR r.categorie_code IS NULL)
  ORDER BY match_score DESC, r.nom, r.prenom, r.id
  LIMIT v_reste;
END;
$$;

GRANT EXECUTE ON FUNCTION rpps_search_by_name TO anon;

NOTIFY pgrst, 'reload schema';
