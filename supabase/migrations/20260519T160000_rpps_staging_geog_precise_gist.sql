-- DURABILITÉ 2026-05-19 — `rpps_in_radius` 57014 en commune dense (RÉGRESSION
-- prouvée prod, post-mortem ci-dessous). Rend le fix d'index DURABLE au swap.
--
-- CONTEXTE. La prod servait `rpps_in_radius` HYBRIDE (déployée via le delta
-- feat `20260516T050000`) dont la CTE `precise` filtre
-- `geom_source IN ('finess_join','ban_address')` et fait
-- `ST_DWithin(r.geog, v_point)`. Ce filtre exige un GiST PARTIEL
-- (`rpps_geog_precise_gist`, créé par `20260516T050000` sur la table `rpps`,
-- qui DROP en même temps le GiST GLOBAL `rpps_geog_gist`). Sans le partiel,
-- le seul index spatial est le GiST GLOBAL : en commune dense le planner
-- prend `Index Scan rpps_geog_gist` (`geog && _st_expand(point,r)`) puis
-- relègue `geom_source IN (...)` en Filter post-index → le bbox ramène le
-- cluster co-localisé `commune_centroid` (PROUVÉ prod Paris 1 km : 77 381
-- lignes dans le bbox dont 76 940 `commune_centroid` au centroïde
-- `POINT(2.347 48.8589)` jetées une à une après recheck géodésique) →
-- O(lignes/commune) → SQLSTATE 57014. Marche en rural / petit rayon
-- (< ~459 m, cluster exclu) / spécialité fine sélective (autre index) —
-- d'où le faux sentiment d'intermittence.
--
-- CAUSE-RACINE (prouvée, pas inférée). Le désamorçage `20260518T140000`
-- (firefight du timeout 57014 de l'enrichment FINESS du cron) a recopié
-- VERBATIM la def `main` de `ingest_create_rpps_staging` (gist GLOBAL,
-- l.123), en actant explicitement (son header §35-46) qu'au 1er swap réussi
-- `rpps_geog_gist` global reviendrait et `rpps_geog_precise_gist`
-- disparaîtrait — « retour VOULU à l'état main ». Mais la fonction hybride
-- `rpps_in_radius` (aussi déployée) DÉPEND du partiel : les deux firefights
-- (BAN rearm vs désamorçage cron) ont DÉCOUPLÉ la fonction de son index
-- compagnon. Le hotfix prod (DROP global + CREATE partiel sur `rpps`, appliqué
-- 2026-05-19) a rétabli le tool, mais serait reverté au prochain swap tant
-- que cette staging-create crée le GLOBAL. Cette migration ferme la boucle.
--
-- CORRECTION. Corps = recopie VERBATIM de `20260518T140000` (dernière def,
-- elle-même verbatim de `20260516T020000_drop_rpps_insee_idx.sql:32-117`,
-- dette #3) — recopie verbatim et NON « version prod ± N lignes » (gotcha
-- CLAUDE.md : un patch chirurgical ré-introduit silencieusement un objet
-- retiré par une migration ultérieure). SEULE différence : la l.123 crée
-- désormais le GiST PARTIEL `rpps_staging_geog_precise_gist` (prédicat
-- byte-identique au WHERE de la branche `precise` / `20260516T050000` /
-- garde-fou `staging-parity.test.ts`) AU LIEU du GiST GLOBAL
-- `rpps_staging_geog_gist`. Au prochain swap, `ingest_atomic_swap` renomme
-- `rpps_staging_geog_precise_gist` → `rpps_geog_precise_gist`
-- (`substring(indexname FROM length('rpps_staging')+1)`,
-- `20260508000010:84-94`) : la prod conserve le partiel, plus AUCUN GiST
-- global ne renaît. Aucun consommateur ne dépend d'un GiST GLOBAL sur `rpps`
-- (revue : `rpps_in_radius` route partiel/matview ; build matview = seq
-- scan+agrégat ; enrich FINESS = `num_finess` ; swap = RENAME).
--
-- APPLICATION. Naming `YYYYMMDDThhmmss` → la CLI Supabase saute ce fichier
-- (`db reset` ne l'applique pas) : appliqué MANUELLEMENT en prod via le
-- canal psql pooler. `CREATE OR REPLACE` (signature `RETURNS VOID`
-- inchangée → pas de `DROP FUNCTION`), idempotent, rejouable. Garde-fou :
-- `scripts/ingest/staging-parity.test.ts` (« le GiST geog de staging-create
-- est le PARTIEL precise, jamais le global »).

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

  ALTER TABLE rpps_staging ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "anon read rpps" ON rpps_staging FOR SELECT TO anon USING (true);

  NOTIFY pgrst, 'reload schema';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_create_rpps_staging FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_create_rpps_staging TO service_role;

COMMENT ON FUNCTION ingest_create_rpps_staging IS
  'Durabilite 2026-05-19 : corps = recopie verbatim de 20260518T140000 (elle-meme verbatim de 20260516T020000, dette #3). SEULE difference vs 20260518T140000 : cree le GiST PARTIEL rpps_staging_geog_precise_gist (WHERE geom_source IN (finess_join,ban_address)) au lieu du GiST GLOBAL rpps_staging_geog_gist. Pourquoi : la fonction hybride rpps_in_radius (CTE precise) regresse en 57014 sur commune dense si le GiST est global (le bbox ramene le cluster co-localise commune_centroid, prouve prod Paris : 76940 lignes jetees en Filter). Au swap, ingest_atomic_swap renomme rpps_staging_geog_precise_gist -> rpps_geog_precise_gist : le fix d index est DURABLE. Toujours SANS les 2 index BAN Unicode-lourds (timeout 57014 enrichment FINESS, cf 20260518T140000). Garde-fou staging-parity.test.ts.';
