-- V0.5.3 — Index composite couvrant pour `rpps_par_specialite_dept` dept dense.
--
-- Sans cet index, le planner choisit `rpps_insee_idx` (Presorted Key sur
-- code_insee) → Index Scan stream qui filtre 100K+ rows sur dept dense
-- (75 ~120K, 13 ~80K) avant d'atteindre LIMIT 50 → timeout 57014.
-- L'index couvrant `(code_departement, code_insee, nom, prenom, id)`
-- permet Index Scan + early termination sur LIMIT (~13 ms en bench).
--
-- ⚠️ `CREATE INDEX` bloquant (pas CONCURRENTLY) — Supabase migrations en
-- transaction interdit CONCURRENTLY (cf mig 000015, 000019). Lock posé
-- `ShareUpdateExclusiveLock` ~30-60 s sur 2,2 M rows : SELECT continuent,
-- seuls les writes bloquent. `rpps` n'est écrite qu'au cron mensuel du
-- 5 → fenêtre acceptable hors ingest.

-- ──────────────────────────────────────────────────────────────────────────
-- (1) Index sur la table prod actuelle (effet immédiat)
-- ──────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS rpps_dept_insee_sort_idx
  ON rpps (code_departement, code_insee, nom, prenom, id);

COMMENT ON INDEX rpps_dept_insee_sort_idx IS
  'Couvre rpps_par_specialite_dept : filter dept + ORDER BY insee/nom/prenom/id + LIMIT. Index Scan early-term, sinon timeout dept dense (V0.5.3).';

-- ──────────────────────────────────────────────────────────────────────────
-- (2) Recréer ingest_create_rpps_staging — superset strict de mig V0.5.1
--     + nouvel index rpps_staging_dept_insee_sort_idx
--
-- Sans cette redéfinition, le prochain cron RPPS recrée rpps_staging SANS
-- l'index, swap atomic le renomme en rpps_previous_dept_insee_sort_idx
-- → l'index est perdu côté prod et le timeout revient.
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
  CREATE INDEX rpps_staging_dept_insee_sort_idx   ON rpps_staging (code_departement, code_insee, nom, prenom, id);
  CREATE INDEX rpps_staging_pending_enrichment_idx ON rpps_staging (id)
    WHERE geom IS NULL AND num_finess IS NOT NULL AND geom_source IS NULL;
  CREATE INDEX rpps_staging_geom_source_idx       ON rpps_staging (geom_source);

  ALTER TABLE rpps_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read rpps" ON rpps_staging FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_rpps_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_rpps_staging TO service_role;
