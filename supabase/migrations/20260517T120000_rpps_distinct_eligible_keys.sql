-- Phase 2 (RPPS BAN-geocoding) — Task 1 : énumération SERVEUR des clés
-- d'adresse ÉLIGIBLES au géocodage BAN (`rpps_distinct_eligible_keys`),
-- comptage des LIGNES éligibles (`rpps_count_ban_eligible_rows`), et
-- rafraîchissement des stats planner (`ingest_analyze_rpps_staging`).
--
-- REFONTE 2026-05-18 (cf. docs/plans/2026-05-18-ban-rearm-postenrichment-index-step.md) :
-- l'ancien index BAN autonome `rpps_ban_eligible_normkey_idx` posé sur la table
-- `rpps` ET le SUPERSET BAN de `ingest_create_rpps_staging` (qui le mirrorait)
-- ont été RETIRÉS — ils réintroduisaient la bombe 57014 (index BAN maintenus
-- par row pendant l'INSERT 2,24 M + l'UPDATE d'enrichment). `ingest_create_
-- rpps_staging` est restauré à la def canonique BAN-free de `main`
-- (20260518T140000). Les 2 index BAN sont désormais créés EXCLUSIVEMENT par
-- `ingest_build_rpps_staging_ban_indexes()` (migration 20260519T100000),
-- post-enrichment / pré-swap, et voyagent dans `rpps` via le RENAME du swap.
-- CETTE migration conserve le wrapper `rpps_address_key_for_index` (section 0),
-- la RPC d'énumération, le count et `ingest_analyze_rpps_staging`.
--
-- ┌─ POURQUOI ─────────────────────────────────────────────────────────────────┐
-- │ ROOT CAUSE : la boucle d'éligibilité BAN rapatriait ~1,29 M lignes        │
-- │ éligibles en RAM JS (paginé 1000) UNIQUEMENT pour les dédupliquer en      │
-- │ ~339 k clés distinctes : 30 min, AUCUN timeout, AUCUN log, et la MÊME     │
-- │ boucle tourne dans le cron mensuel (pathologique). La RPC ci-dessous      │
-- │ rend directement les clés DISTINCTES éligibles, côté serveur, en          │
-- │ pagination keyset cap-agnostique (pas de rapatriement massif).            │
-- │                                                                            │
-- │ DÉLÉGATION — JAMAIS DUPLIQUER LA NORMALISATION : la clé est calculée       │
-- │ EXCLUSIVEMENT via `rpps_normalize_address_key(adresse, code_postal,       │
-- │ code_insee)` (jumeau SQL 3-arg, défini migration 20260516T060000, UNIQUE  │
-- │ source de vérité côté SQL, byte-exact-parité avec JS normalizeAddressKey).│
-- │ Toute ré-implémentation/inlining recréerait le POINT UNIQUE DE PANNE      │
-- │ TOTALE SILENCIEUSE (1 octet de divergence ⇒ jointure cache nulle ⇒ 0     │
-- │ ligne géocodée en rapportant un succès). En déléguant, le HARD GATE de    │
-- │ parité octet-à-octet existant                                            │
-- │ (`scripts/ingest/ban-geocode-parity.integration.test.ts`) couvre CES     │
-- │ RPC PAR TRANSITIVITÉ — ne JAMAIS dupliquer la logique de clé ici.         │
-- │                                                                            │
-- │ ANTI-INJECTION : la table source est résolue par un CASE whitelist        │
-- │ EXPLICITE ('rpps' | 'rpps_staging') — JAMAIS `format(%I, p_param)` sur    │
-- │ une entrée libre. Toute valeur hors whitelist lève une EXCEPTION (jamais  │
-- │ de lignes silencieuses).                                                  │
-- │                                                                            │
-- │ PAGINATION KEYSET CAP-AGNOSTIQUE : `keyexpr > $1` strict + `ORDER BY      │
-- │ keyexpr` + `LIMIT $2` → robuste à tout `max_rows` PostgREST serveur, quel │
-- │ que soit p_limit ; la terminaison côté caller est une page VIDE (pattern  │
-- │ de référence `ban-backfill.mjs`, cf. CLAUDE.md « max_rows plafonne »).    │
-- │                                                                            │
-- │ DÉPEND DE L'INDEX FONCTIONNEL PARTIEL `rpps_ban_eligible_normkey_idx`     │
-- │ (B-tree sur `rpps_normalize_address_key(...)`, IMMUTABLE donc indexable). │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ PROCÉDURE PROD (REFONTE 2026-05-18 — plus d'index autonome ici) ────────────┐
-- │ L'index fonctionnel BAN n'est PLUS créé par cette migration. Il est       │
-- │ construit (avec le composite) par la RPC                                  │
-- │ `ingest_build_rpps_staging_ban_indexes()` (migration 20260519T100000) sur │
-- │ `rpps_staging` APRÈS l'enrichment FINESS et AVANT le swap, en CREATE      │
-- │ INDEX bloquant classique (rpps_staging ne sert AUCUNE lecture prod, donc  │
-- │ pas besoin de CONCURRENTLY ni de connexion directe) ; il voyage dans      │
-- │ `rpps` via le RENAME du swap. La RPC d'énumération ci-dessous DÉPEND de   │
-- │ cet index — l'orchestration cron (`scripts/ingest/rpps.ts`) build puis    │
-- │ re-ANALYZE AVANT l'énumération. Cf. plan §1/§2.                            │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- Migration idempotente (CREATE OR REPLACE FUNCTION, GRANT/REVOKE idempotents).
-- Appliquée en PROD par le mainteneur via le canal psql pooler ; en CI/local
-- via psql (la CLI supabase SKIPPE les migrations
-- `YYYYMMDDThhmmss_` — contrainte projet connue).

-- ───────────────────────────────────────────────────────────────────────────
-- (0) Twin d'INDEXATION — délègue STRICTEMENT à rpps_normalize_address_key.
--
-- POURQUOI CE WRAPPER (et non un index direct sur le jumeau) :
-- `rpps_normalize_address_key` est `LANGUAGE sql IMMUTABLE` SANS `SET
-- search_path` : Postgres l'INLINE. À la construction d'un index FONCTIONNEL,
-- l'expression est planifiée avec un search_path ASSAINI (sécurité) ; l'appel
-- IMBRIQUÉ NON qualifié `rpps_norm_field(...)` (schéma `public`) devient alors
-- IRRÉSOLVABLE → `CREATE INDEX ... (rpps_normalize_address_key(...))` échoue
-- (`function rpps_norm_field(text,text) does not exist ... during inlining`),
-- PROUVÉ localement ET donc en prod (même CONCURRENTLY). Les autres helpers du
-- jumeau sont `pg_catalog` (toujours résolvables) — seul `rpps_norm_field` ne
-- l'est pas. Modifier le jumeau pour le qualifier/anti-inliner = TOUCHER du
-- code SOUS HARD GATE de parité (interdit, risque de panne totale silencieuse).
--
-- Un wrapper SQL IMMUTABLE AVEC `SET search_path = public, extensions` N'EST
-- PAS inliné : son corps s'exécute avec SON search_path → `rpps_norm_field`
-- résout. Il DÉLÈGUE strictement au jumeau (ZÉRO logique propre — exactement
-- le pattern établi `rpps_normalize_address_key_probe` de 20260516T060000), si
-- bien que la parité octet-à-octet JS↔SQL reste garantie PAR TRANSITIVITÉ par
-- le HARD GATE existant (ban-geocode-parity.integration.test.ts) : il N'Y A
-- AUCUNE ré-implémentation ici. La MÊME expression `rpps_address_key_for_index`
-- est utilisée à l'identique dans l'index, le `DISTINCT ON`/`ORDER BY` de la
-- RPC (sinon le planner jugerait l'index inapplicable) et reste byte-exacte.
-- IMMUTABLE légitime (pure : délègue à une fonction pure) → indexable.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION rpps_address_key_for_index(
  p_adresse     TEXT,
  p_code_postal TEXT,
  p_code_insee  TEXT
) RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT rpps_normalize_address_key(p_adresse, p_code_postal, p_code_insee);
$$;

COMMENT ON FUNCTION rpps_address_key_for_index(TEXT, TEXT, TEXT) IS
  'Phase 2 RPPS BAN Task 1 — twin d''INDEXATION : délègue STRICTEMENT à rpps_normalize_address_key (UNIQUE source de vérité ; ZÉRO logique propre, pattern rpps_normalize_address_key_probe). Raison d''être : le jumeau, inliné car SQL IMMUTABLE sans SET search_path, rend son appel imbriqué non qualifié rpps_norm_field IRRÉSOLVABLE à la construction d''un index fonctionnel (search_path assaini) — modifier le jumeau toucherait du code sous HARD GATE de parité. Ce wrapper AVEC SET search_path n''est PAS inliné → indexable. Parité octet-à-octet JS↔SQL garantie PAR TRANSITIVITÉ via le HARD GATE ban-geocode-parity.integration.test.ts (aucune ré-implémentation). MÊME expression utilisée à l''identique dans l''index ET le DISTINCT ON/ORDER BY de rpps_distinct_eligible_keys (sinon index jugé inapplicable).';

-- 2026-05-18 refonte : staging-create BAN-free (cf. docs/plans/2026-05-18-ban-rearm-postenrichment-index-step.md ; la bombe 57014 ne doit jamais revenir — index BAN créés par ingest_build_rpps_staging_ban_indexes, jamais ici)
--
-- ───────────────────────────────────────────────────────────────────────────
-- (1) [SUPPRIMÉ — refonte 2026-05-18] L'ancien index BAN autonome
--     `rpps_ban_eligible_normkey_idx` posé sur la table `rpps` (forme CI/local
--     + procédure prod CONCURRENTLY) a été RETIRÉ. Toute création des 2 index
--     fonctionnels BAN passe désormais EXCLUSIVEMENT par la nouvelle RPC
--     `ingest_build_rpps_staging_ban_indexes()` (migration
--     20260519T100000), exécutée sur `rpps_staging` APRÈS l'enrichment FINESS
--     et AVANT le swap atomique : les 2 index voyagent dans `rpps` via le
--     RENAME du swap. Les créer ici (ou dans `ingest_create_rpps_staging`
--     ci-dessous) les ferait maintenir pendant l'INSERT 2,24 M + l'UPDATE
--     d'enrichment = l'AGGRAVANT prouvé du timeout 57014 (cf. plan §0/§1 +
--     20260518T140000). Le wrapper `rpps_address_key_for_index` (section 0
--     ci-dessus) reste défini ici — il est consommé par cette RPC, par
--     `rpps_distinct_eligible_keys` et par la RPC de build d'index.
-- ───────────────────────────────────────────────────────────────────────────

-- ───────────────────────────────────────────────────────────────────────────
-- (2) RPC d'énumération : clés d'adresse DISTINCTES éligibles, keyset paginé.
--     RETURNS les clés brutes SANS LEFT JOIN au cache geocoded_addresses : la
--     logique des 3 cas de tentative (jamais tenté / retenté jusqu'au cap /
--     accepté figé) reste côté JS (séparation des responsabilités). Whitelist
--     par CASE EXPLICITE (anti-injection) ; DISTINCT ON (keyexpr) ... ORDER BY
--     keyexpr, t.id → représentant MIN(id) DÉTERMINISTE par clé. `btrim` sur
--     les colonnes retournées miroite JS `.trim()` et neutralise le blank-pad
--     CHAR(5) symétriquement (même invariant prouvé par
--     rpps_normalize_address_key_probe_char5). Keyset `> $1` strict + ORDER BY
--     keyexpr + LIMIT $2 = pagination cap-agnostique.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION rpps_distinct_eligible_keys(
  p_source_table TEXT,
  p_after        TEXT,
  p_limit        INT
) RETURNS TABLE (
  address_key TEXT,
  adresse     TEXT,
  code_postal TEXT,
  code_insee  TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_tbl TEXT;
BEGIN
  -- Whitelist par CASE EXPLICITE — JAMAIS format(%I, p_source_table) sur une
  -- entrée libre (injection). Hors whitelist ⇒ EXCEPTION (jamais de lignes
  -- silencieuses : un appel mal câblé doit être BRUYANT, pas vide).
  v_tbl := CASE p_source_table
             WHEN 'rpps'         THEN 'rpps'
             WHEN 'rpps_staging' THEN 'rpps_staging'
             ELSE NULL
           END;
  IF v_tbl IS NULL THEN
    RAISE EXCEPTION 'rpps_distinct_eligible_keys: invalid source table %', p_source_table
      USING ERRCODE = '22023';
  END IF;

  -- L'expression de clé = rpps_address_key_for_index (twin d'indexation
  -- délégant au jumeau, parité par transitivité) — IDENTIQUE à l'expression
  -- de l'index partiel `rpps_ban_eligible_normkey_idx`. C'est REQUIS pour que
  -- le planner juge l'index applicable (DISTINCT ON + keyset + ORDER BY) : une
  -- expression syntaxiquement différente (même si sémantiquement égale) ferait
  -- ignorer l'index → full-scan + timeout 60 s sur le cron mensuel.
  RETURN QUERY EXECUTE format($q$
    SELECT DISTINCT ON (rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee))
           rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) AS address_key,
           btrim(t.adresse)     AS adresse,
           btrim(t.code_postal) AS code_postal,
           btrim(t.code_insee)  AS code_insee
    FROM %I t
    WHERE ( t.geom_source = 'commune_centroid'
            OR (t.geom IS NULL AND t.adresse IS NOT NULL) )
      AND ( $1 IS NULL
            OR rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) > $1 )
    ORDER BY rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee), t.id
    LIMIT $2
  $q$, v_tbl)
  USING p_after, p_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION rpps_distinct_eligible_keys(TEXT, TEXT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION rpps_distinct_eligible_keys(TEXT, TEXT, INT) TO service_role;

COMMENT ON FUNCTION rpps_distinct_eligible_keys(TEXT, TEXT, INT) IS
  'Phase 2 RPPS BAN Task 1 — énumère côté SERVEUR les clés d''adresse DISTINCTES éligibles au géocodage BAN (geom_source=commune_centroid OR (geom NULL AND adresse NOT NULL), byte-identique à ingest_apply_rpps_ban_geocoding_batch). DÉLÈGUE la clé au twin d''indexation rpps_address_key_for_index qui délègue lui-même STRICTEMENT au jumeau rpps_normalize_address_key (UNIQUE source de vérité, couvert par le HARD GATE de parité PAR TRANSITIVITÉ — aucune ré-implémentation/inlining). MÊME expression que l''index partiel rpps_ban_eligible_normkey_idx (sinon planner juge l''index inapplicable). Whitelist par CASE (rpps|rpps_staging ; hors whitelist ⇒ EXCEPTION 22023, jamais de lignes silencieuses). DISTINCT ON keyexpr + ORDER BY keyexpr, id ⇒ représentant MIN(id) déterministe. RETURNS les clés BRUTES SANS LEFT JOIN au cache geocoded_addresses (la logique 3-cas jamais-tenté/retenté/accepté reste en JS). Keyset > $1 strict + ORDER BY keyexpr + LIMIT $2 = pagination cap-agnostique. SECURITY DEFINER, EXECUTE service_role only.';

-- ───────────────────────────────────────────────────────────────────────────
-- (3) Comptage des LIGNES éligibles (PAS clés distinctes) — alimente
--     l'expectedTotal de runBatchedRpc côté JS. Même whitelist CASE.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION rpps_count_ban_eligible_rows(
  p_source_table TEXT
) RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_tbl TEXT;
  v_cnt BIGINT;
BEGIN
  v_tbl := CASE p_source_table
             WHEN 'rpps'         THEN 'rpps'
             WHEN 'rpps_staging' THEN 'rpps_staging'
             ELSE NULL
           END;
  IF v_tbl IS NULL THEN
    RAISE EXCEPTION 'rpps_count_ban_eligible_rows: invalid source table %', p_source_table
      USING ERRCODE = '22023';
  END IF;

  EXECUTE format(
    'SELECT count(*) FROM %I t WHERE (t.geom_source = ''commune_centroid'' OR (t.geom IS NULL AND t.adresse IS NOT NULL))',
    v_tbl
  ) INTO v_cnt;
  RETURN v_cnt;
END;
$$;

REVOKE EXECUTE ON FUNCTION rpps_count_ban_eligible_rows(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION rpps_count_ban_eligible_rows(TEXT) TO service_role;

COMMENT ON FUNCTION rpps_count_ban_eligible_rows(TEXT) IS
  'Phase 2 RPPS BAN Task 1 — compte les LIGNES éligibles au géocodage BAN (prédicat byte-identique à rpps_distinct_eligible_keys / ingest_apply_rpps_ban_geocoding_batch). C''est un count de LIGNES (NOT distinct keys) — alimente runBatchedRpc expectedTotal ; NE JAMAIS confondre avec distinctKeys.length (les lignes se dédoublonnent en moins de clés). Whitelist par CASE (rpps|rpps_staging ; hors whitelist ⇒ EXCEPTION 22023). SECURITY DEFINER, EXECUTE service_role only.';

-- ───────────────────────────────────────────────────────────────────────────
-- (4) ANALYZE rpps_staging — rafraîchit les stats planner (dont l'index
--     fonctionnel partiel) AVANT l'énumération d'éligibilité. Sans stats
--     fraîches, le planner ignore rpps_ban_eligible_normkey_idx → la RPC
--     full-scanne et timeoute à 60 s sur le cron mensuel. ANALYZE est autorisé
--     DANS une transaction (≠ VACUUM). Appelée depuis rpps.ts (tâche
--     ultérieure) — ici on ne crée que la RPC.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ingest_analyze_rpps_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  EXECUTE 'ANALYZE rpps_staging';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_analyze_rpps_staging() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_analyze_rpps_staging() TO service_role;

COMMENT ON FUNCTION ingest_analyze_rpps_staging() IS
  'Phase 2 RPPS BAN Task 1 — rafraîchit les stats planner sur rpps_staging (incl. l''index fonctionnel partiel rpps_staging_ban_eligible_normkey_idx) AVANT la RPC d''éligibilité BAN. Sans stats fraîches le planner ignore l''index → RPC full-scan + timeout 60 s sur le cron mensuel. ANALYZE est autorisé DANS une transaction (contrairement à VACUUM). Appelée depuis scripts/ingest/rpps.ts (tâche ultérieure). SECURITY DEFINER, EXECUTE service_role only.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2026-05-18 refonte : staging-create BAN-free (cf. docs/plans/2026-05-18-ban-rearm-postenrichment-index-step.md ; la bombe 57014 ne doit jamais revenir — index BAN créés par ingest_build_rpps_staging_ban_indexes, jamais ici)
--
-- (5) ingest_create_rpps_staging : def canonique BAN-FREE de `main`
--     (20260518T140000, recopie verbatim de 20260516T020000:32-117). Le
--     SUPERSET BAN précédent (qui ajoutait rpps_staging_ban_eligible_normkey_idx
--     dans cette fonction) RÉINTRODUISAIT la bombe 57014 : les 2 index
--     fonctionnels BAN Unicode-lourds étaient maintenus par row pendant
--     l'INSERT 2,24 M + l'UPDATE d'enrichment FINESS du cron mensuel. Les 2
--     index BAN sont désormais créés EXCLUSIVEMENT par la RPC
--     `ingest_build_rpps_staging_ban_indexes()` (migration 20260519T100000),
--     APRÈS l'enrichment et AVANT le swap, sur des données stabilisées ; ils
--     voyagent dans `rpps` via le RENAME du swap. NE JAMAIS recréer ces 2
--     index ici (garde-fou scripts/ingest/staging-parity.test.ts).
-- ───────────────────────────────────────────────────────────────────────────
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
  'Desamorcage 2026-05-18 : corps = recopie verbatim de 20260516T020000 (derniere def main, dette #3). Volontairement SANS les 2 index fonctionnels BAN Unicode-lourds (rpps_staging_ban_eligible_normkey_idx / _id_idx) qui, crees par le delta feat non merge, faisaient timeouter (57014) l enrichment FINESS du cron RPPS mensuel (run #26029698016). Cree rpps_staging_geog_gist GLOBAL : au 1er swap post-fix, rpps_geog_precise_gist (cree par le delta feat sur la table rpps) disparait et rpps_geog_gist global revient = retour voulu a l etat main. Les 2 index BAN encore presents sur la table rpps sont droppes hors de ce fichier (CONCURRENTLY, separe).';
