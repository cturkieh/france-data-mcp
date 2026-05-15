-- V0.10.2 — Fix P0 prod : `rpps_in_radius` timeout 57014 systématique dans
-- les communes denses.
--
-- Root cause PROUVÉE (EXPLAIN ANALYZE prod 2026-05-15, transaction ROLLBACK) :
-- les coordonnées RPPS sont des centroïdes commune. Les communes denses
-- empilent des dizaines de milliers de lignes au POINT géographique
-- identique (Paris/75056 = 76 798 lignes, Marseille/13055 = 29 993,
-- Toulouse/31555 = 21 695, Lyon/69123 = 17 276). Tout point de recherche
-- proche d'un tel centroïde rend l'index GiST `rpps_geog_gist` incapable
-- d'élaguer (tous les points identiques passent le `&&` bbox) → recalcul
-- exact `ST_DWithin`/`ST_Distance` géographique par-ligne sur les ~77 k
-- lignes co-localisées → 15 913 ms mesurés (74 245 buffers) → dépasse le
-- `statement_timeout=3s` du rôle `anon` → 57014. Ce N'EST PAS une régression
-- de code, ni un index perdu (`rpps_geog_gist` présent 163 MB), ni des stats
-- périmées (analyze 2026-05-13), ni un generic plan (custom plan littéral
-- AUSSI à 15,9 s). Bug latent de scaling O(lignes/commune) : un point rural
-- (Guéret) résout en 198 ms — le pattern est sain hors commune dense.
--
-- Fix : pré-résoudre les communes dont le centroïde est dans le rayon via
-- une matview de centroïdes communaux distincts (~quelques milliers de
-- lignes, KNN instantané sur sa propre GiST), puis pour chaque commune
-- récupérer au plus `p_limit` lignes en early-stop déterministe via
-- l'index composite `rpps_insee_id_idx (code_insee, id)` (section 1b) avec
-- un CROSS JOIN LATERAL. On supprime tout calcul géo par-ligne sur le
-- cluster co-localisé. Mesuré end-to-end en prod (ROLLBACK, Paris, limit
-- 100) : 15 913 ms → 63 ms (~250×).
--
-- Trade-off assumé : le filtrage rayon est résolu à la granularité commune
-- (le centroïde représentatif de la commune est dans le rayon, ou non). La
-- minorité de lignes `geom_source='finess_join'` à coordonnées précises est
-- sur-/sous-incluse de ≤ la taille de la commune — strictement dans la
-- tolérance déjà documentée du tool ("précision = centroïde commune ~3 km,
-- adapté à l'analyse de densité, pas au géocodage adresse"). Vérifié en
-- prod : 0 ligne `geog IS NOT NULL AND code_insee IS NULL` → la résolution
-- par commune est COMPLÈTE, aucune ligne cherchable n'est silencieusement
-- exclue.
--
-- Pattern cohérent avec les matviews refresh-post-swap existantes
-- (`rpps_savoir_faire_stats` V0.8.2, `rpps_count_stats` V0.8.3,
-- `ameli_nomenclature_stats` V0.10.1) via `ingest_refresh_matview`.
--
-- ⚠️ Apply : `CREATE MATERIALIZED VIEW` peuple immédiatement (WITH DATA par
-- défaut) → scan `rpps` ~1,66 M lignes + ST_Collect/ST_Centroid GROUP BY.
-- Observé ~60-120 s (ordre de grandeur d'un refresh `rpps_count_stats`).
-- Appliquer via Dashboard SQL Editor ou Management API avec un
-- statement_timeout généreux. Idempotent (IF NOT EXISTS / OR REPLACE),
-- re-run unique safe.

-- ──────────────────────────────────────────────────────────────────────────
-- (1) Matview des centroïdes communaux distincts présents en RPPS.
--     1 ligne par code_insee. ST_Centroid(ST_Collect(geom)) = point
--     représentatif de la commune (dans les communes denses tous les points
--     sont identiques → centroïde = ce point exact ; dans les communes
--     éparses, moyenne des quelques points précis, écart ≤ taille commune).
--     UNIQUE INDEX sur code_insee requis pour REFRESH ... CONCURRENTLY.
-- ──────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS rpps_commune_centroids AS
SELECT
  r.code_insee,
  ST_Centroid(ST_Collect(r.geom))::geography AS geog
FROM rpps r
WHERE r.geog IS NOT NULL
  AND r.code_insee IS NOT NULL
GROUP BY r.code_insee;

CREATE UNIQUE INDEX IF NOT EXISTS rpps_commune_centroids_pk
  ON rpps_commune_centroids (code_insee);

CREATE INDEX IF NOT EXISTS rpps_commune_centroids_geog_gist
  ON rpps_commune_centroids USING GIST (geog);

GRANT SELECT ON rpps_commune_centroids TO anon;

COMMENT ON MATERIALIZED VIEW rpps_commune_centroids IS
  'V0.10.2 — 1 centroïde géographique par commune présente en RPPS (~milliers de lignes). Pré-résolution rayon pour rpps_in_radius (évite le recalcul géo par-ligne sur les clusters centroïde des communes denses). REFRESH CONCURRENTLY après chaque ingest RPPS.';

-- ──────────────────────────────────────────────────────────────────────────
-- (1b) Index composite `(code_insee, id)` — REQUIS par le early-stop
--      déterministe du LATERAL de rpps_in_radius. Mesuré en prod (ROLLBACK,
--      Paris/75056 = 76 798 lignes, limit 100) : sans cet index le planner
--      choisit `rpps_insee_idx` + Sort des 76 780 lignes = 2 575 ms (sous
--      les 3 s anon mais marge nulle — tip-over en prod sous charge/cache
--      froid) ; AVEC `(code_insee, id)` l'`Index Scan` est ordonné par id
--      → early-stop à 100 lignes = **63 ms end-to-end**. Le `rpps_insee_idx`
--      mono-colonne reste (redondant mais inoffensif ; nettoyage futur
--      hors P0). `CREATE INDEX` bloquant (Supabase migrations en
--      transaction interdit CONCURRENTLY) : ShareUpdateExclusiveLock
--      ~30-60 s sur 2,23 M lignes, SELECT continuent, seuls les writes
--      bloquent — `rpps` n'est écrite qu'au cron mensuel, fenêtre OK.
-- ──────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS rpps_insee_id_idx ON rpps (code_insee, id);

COMMENT ON INDEX rpps_insee_id_idx IS
  'V0.10.2 — early-stop déterministe du LATERAL rpps_in_radius (WHERE code_insee = X ORDER BY id LIMIT n). Sans lui, P0 57014 régresse sur commune dense. Doit être mirroré dans ingest_create_rpps_staging (superset, sinon perdu au swap mensuel).';

-- ──────────────────────────────────────────────────────────────────────────
-- (2) RPC `rpps_in_radius` réécrite. Signature, colonnes RETURNS TABLE,
--     LANGUAGE, search_path, GRANT : STRICTEMENT INCHANGÉS (contrat MCP
--     identique — la lib `src/sante/rpps-db.ts` et le tool ne changent pas).
--     Seule la stratégie d'accès change.
-- ──────────────────────────────────────────────────────────────────────────
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
  v_centroid_total BIGINT;
BEGIN
  -- Sentinelle matview vide (même doctrine anti-"0 silencieux" que
  -- count_rpps V0.8.3, SQLSTATE P0002). Sans elle, une matview
  -- rpps_commune_centroids vide (créée WITH NO DATA, REFRESH jamais joué
  -- ou échoué, GRANT cassé) ferait retourner 0 ligne pour TOUT point —
  -- indistinguable d'un légitime "aucun PS dans le rayon" → un audit
  -- territorial conclurait à tort à un désert médical. COUNT(*) sur PK,
  -- sous-ms. getRppsInRadius propage l'erreur → -32603 + Sentry endpoint.
  SELECT COUNT(*) INTO v_centroid_total FROM rpps_commune_centroids;
  IF v_centroid_total = 0 THEN
    RAISE EXCEPTION 'rpps_commune_centroids matview is empty (cardinality 0). Refusing to return zero rows silently — run REFRESH MATERIALIZED VIEW rpps_commune_centroids.'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  -- (a) Communes dont le centroïde représentatif est dans le rayon. Scan
  --     GiST sur la petite matview (~milliers de lignes) → quelques ms.
  --     cdist = distance commune→point, sert le tri "plus proche d'abord".
  WITH communes AS (
    SELECT
      c.code_insee AS cc_insee,
      ST_Distance(c.geog, v_point) AS cdist
    FROM rpps_commune_centroids c
    WHERE ST_DWithin(c.geog, v_point, p_radius_meters)
  )
  -- (b) Pour CHAQUE commune retenue, au plus p_limit lignes en EARLY-STOP
  --     via `rpps_insee_id_idx (code_insee, id)` : Index Cond code_insee=X,
  --     lignes déjà ordonnées par id → arrêt à p_limit (JAMAIS les ~77 k
  --     du cluster). `ORDER BY r.id` rend le sous-ensemble intra-commune
  --     DÉTERMINISTE (repro d'appel en appel, cache-safe) ET satisfait par
  --     l'index sans tri matérialisé. Mesuré end-to-end prod (Paris,
  --     limit 100) : 63 ms (vs 15 913 ms avant fix, 2 575 ms sans cet
  --     index). Le tri global se fait sur cdist (1 valeur par commune) —
  --     aucun calcul géo par-ligne sur le cluster co-localisé.
  SELECT
    x.id, x.rpps_id, x.civilite, x.nom, x.prenom,
    x.profession_code, x.profession_libelle,
    x.savoir_faire_code, x.savoir_faire_libelle,
    x.mode_exercice_code, x.mode_exercice_libelle,
    x.categorie_code, x.categorie_libelle,
    x.num_finess, x.num_finess_ej, x.siret, x.raison_sociale,
    x.adresse, x.code_postal, x.ville,
    x.code_departement, x.code_insee, x.telephone,
    x.geom, x.distance_meters
  FROM communes cm
  CROSS JOIN LATERAL (
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
    WHERE r.code_insee = cm.cc_insee
      AND (cardinality(p_profession_codes)    = 0 OR r.profession_code    = ANY(p_profession_codes))
      AND (cardinality(p_savoir_faire_codes)  = 0 OR r.savoir_faire_code  = ANY(p_savoir_faire_codes))
      AND (cardinality(p_mode_exercice_codes) = 0 OR r.mode_exercice_code = ANY(p_mode_exercice_codes))
      AND rpps_categorie_match(r.categorie_code, p_categorie_codes)
    ORDER BY r.id
    LIMIT p_limit
  ) x
  -- Tri "commune la plus proche d'abord", x.id en tie-breaker. NB : si la
  -- commune la plus proche compte > p_limit lignes correspondantes, le
  -- résultat est intégralement puisé dans CETTE commune (cap par-commune)
  -- — les communes plus lointaines sont alors évincées du même `limit`.
  -- Comportement assumé pour un outil de densité à précision centroïde
  -- (~3 km) ; documenté dans la description du tool MCP.
  ORDER BY cm.cdist, x.id
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION rpps_in_radius(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  TEXT[], TEXT[], TEXT[], TEXT[], INT
) TO anon;

-- ──────────────────────────────────────────────────────────────────────────
-- (3) Étend la whitelist de `ingest_refresh_matview` (V0.10.1) avec
--     `rpps_commune_centroids`. Discipline : toute matview refresh par un
--     script ingest DOIT être whitelistée (sinon 22023 silencieux à chaque
--     ingest → centroïdes figés au mois précédent). Garde-fou :
--     `scripts/ingest/staging-parity.test.ts`.
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
-- (4) Recréer `ingest_create_rpps_staging` en SUPERSET STRICT (règle NON
--     NÉGOCIABLE). Bug latent pré-existant découvert via la généralisation
--     du garde-fou staging-parity à la table rpps (V0.10.2) : 3 index prod
--     `rpps` créés APRÈS la dernière staging-create (20260510T020000) n'y
--     ont jamais été répliqués → PERDUS à chaque swap mensuel :
--       - `rpps_nom_trgm_idx`    (20260511) → `rpps_search_by_name` casse
--       - `rpps_prenom_trgm_idx` (20260511) → idem
--       - `rpps_profession_savoir_faire_partial_idx` (20260514T030000)
--     Reproduction verbatim de la staging-create 20260510T020000 + ces 3
--     index sur `rpps_staging` (mêmes clé/clause que prod → mirror exact,
--     le swap atomique les renomme correctement).
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
