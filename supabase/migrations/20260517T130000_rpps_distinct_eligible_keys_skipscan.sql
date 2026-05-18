-- Phase 2 (RPPS BAN-geocoding) — CORRECTIVE G5 (defaut PROD prouve) :
-- `rpps_distinct_eligible_keys` reecrite en SKIP-SCAN O(cles distinctes),
-- IMMUNE aux groupes d'adresses GEANTS. Ne touche PAS
-- rpps_address_key_for_index / rpps_count_ban_eligible_rows /
-- ingest_analyze_rpps_staging (proprietes de 20260517T120000).
--
-- REFONTE 2026-05-18 (cf. docs/plans/2026-05-18-ban-rearm-postenrichment-index-step.md) :
-- l'ancien index BAN autonome COMPOSITE `rpps_ban_eligible_normkey_id_idx`
-- posé sur la table `rpps` ET le SUPERSET BAN de `ingest_create_rpps_staging` (qui
-- mirrorait les 2 index BAN) ont été RETIRES — ils reintroduisaient la bombe
-- 57014 (index BAN maintenus par row pendant l'INSERT 2,24 M + l'UPDATE
-- d'enrichment). `ingest_create_rpps_staging` est restauré a la def canonique
-- BAN-free de `main` (20260518T140000). Les 2 index BAN sont desormais crees
-- EXCLUSIVEMENT par `ingest_build_rpps_staging_ban_indexes()` (migration
-- 20260519T100000), post-enrichment / pre-swap, et voyagent dans `rpps` via le
-- RENAME du swap. Cette migration conserve UNIQUEMENT la reecriture skip-scan
-- de la RPC `rpps_distinct_eligible_keys`.
--
-- ┌─ POURQUOI (ROOT CAUSE PROUVEE — ne PAS re-deriver) ────────────────────────┐
-- │ L'ancienne RPC (20260517T120000) faisait `DISTINCT ON (keyexpr) ...        │
-- │ ORDER BY keyexpr, id LIMIT $2` au-dessus de l'index FONCTIONNEL PARTIEL    │
-- │ `keyexpr`-SEUL `rpps_ban_eligible_normkey_idx`. EXPLAIN prod a PROUVE :    │
-- │ le keyset `> $1` EST deja un Index Cond (le `OR $1 IS NULL` n'est PAS le   │
-- │ probleme). Le DEFAUT : `DISTINCT ON + ORDER BY keyexpr,id` force un        │
-- │ Incremental Sort qui trie INTEGRALEMENT chaque groupe keyexpr par id ;     │
-- │ les adresses massivement dupliquees (clusters centroide commune denses,    │
-- │ hotspot documente « Paris ~77k lignes ») font qu'UNE page couvrant un      │
-- │ groupe geant depasse le statement_timeout ~60 s du pooler Supabase         │
-- │ pendant que les autres pages tournent en 2-4 s. `ban-backfill.mjs --max   │
-- │ 5000` reel a enumere 20k→300k cles puis est mort `canceling statement     │
-- │ due to statement timeout`. (Mesure locale N=8000 : Index Scan ≈8033       │
-- │ lignes + Incremental Sort, ~1000 Shared Hit Blocks, ~1080 ms pour 10      │
-- │ lignes ; a N=77k prod → milliers de blocs → timeout.)                      │
-- │                                                                            │
-- │ FIX = LOOSE INDEX SKIP-SCAN : enumerer les cles DISTINCTES en O(cles),     │
-- │ en sautant un groupe duplique geant en UNE descente B-tree                 │
-- │ (`keyexpr > prev ORDER BY keyexpr LIMIT 1`). Le representant MIN(id) par   │
-- │ cle est resolu par un SEEK CORRELE sur un NOUVEL index COMPOSITE PARTIEL   │
-- │ `(keyexpr, id)` (`keyexpr = $1 ORDER BY keyexpr, id LIMIT 1`). Cout =      │
-- │ O(p_limit) descentes B-tree, INVARIANT de la taille du groupe geant.       │
-- │                                                                            │
-- │ HARDENING (surclasse la forme CTE recursive proposee) : la boucle          │
-- │ d'enumeration est une boucle PL/pgSQL EXPLICITE BORNEE `FOR i IN           │
-- │ 1..p_limit`, PAS une CTE recursive. Raison : une CTE recursive depend de   │
-- │ Postgres poussant le LIMIT externe DANS la recursion (dependant du plan ;  │
-- │ s'il ne le pousse pas, elle calcule TOUTES les ~339k cles distinctes →     │
-- │ regression O(total) SILENCIEUSE). Un `FOR i IN 1..p_limit LOOP` est        │
-- │ STRUCTURELLEMENT borne a ≤ p_limit descentes d'index PAR CONSTRUCTION —    │
-- │ zero pari sur l'optimiseur. C'est un chemin a POINT UNIQUE DE PANNE        │
-- │ TOTALE SILENCIEUSE : garantie structurelle > habilete.                     │
-- │                                                                            │
-- │ DELEGATION — JAMAIS DUPLIQUER LA NORMALISATION : la cle reste calculee     │
-- │ EXCLUSIVEMENT via `rpps_address_key_for_index(...)` (twin d'indexation     │
-- │ delegant STRICTEMENT au jumeau `rpps_normalize_address_key`, defini        │
-- │ 20260517T120000). MEME expression a TOUS les sites (saut + representant +  │
-- │ les 2 index + les 2 mirrors staging) — sinon le planner juge l'index       │
-- │ inapplicable → full-scan + timeout. Parite octet-a-octet JS↔SQL garantie  │
-- │ PAR TRANSITIVITE via le HARD GATE existant                                │
-- │ (`ban-geocode-parity.integration.test.ts`). Ne JAMAIS appeler le jumeau    │
-- │ NU ni l'inliner ici (HARD GATE par transitivite).                          │
-- │                                                                            │
-- │ ANTI-INJECTION : table source resolue par CASE whitelist EXPLICITE         │
-- │ ('rpps' | 'rpps_staging') — JAMAIS `format(%I, p_param)` sur entree        │
-- │ libre ; hors whitelist ⇒ EXCEPTION 22023 (jamais de lignes silencieuses). │
-- │ Pagination KEYSET CAP-AGNOSTIQUE preservee : `keyexpr > $1` strict +       │
-- │ terminaison caller sur page VIDE (pattern `ban-backfill.mjs`).             │
-- │ Representant MIN(id) DETERMINISTE inchange (`= $1 ORDER BY keyexpr, id`).  │
-- │ Cf. CLAUDE.md gotcha « Une fonction SQL IMMUTABLE SANS SET search_path »   │
-- │ + gotcha « Coords = centroide commune + recherche rayon = piege           │
-- │ O(lignes/commune) » (meme classe de cluster co-localise dense).            │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ PROCEDURE PROD (REFONTE 2026-05-18 — plus de DUAL-INDEX GATE ici) ─────────┐
-- │ Les 2 index fonctionnels BAN (cle-seule pour les sauts skip-scan +         │
-- │ composite (keyexpr, id) pour le representant MIN(id)) NE sont PLUS crees   │
-- │ par cette migration. Ils sont construits par la RPC                        │
-- │ `ingest_build_rpps_staging_ban_indexes()` (migration 20260519T100000) sur │
-- │ `rpps_staging` APRES l'enrichment FINESS et AVANT le swap atomique, en     │
-- │ `CREATE INDEX` bloquant classique (rpps_staging ne sert AUCUNE lecture     │
-- │ prod) ; ils voyagent dans `rpps` via le RENAME du swap. La RPC skip-scan   │
-- │ ci-dessous DEPEND donc de ces 2 index — l'orchestration cron               │
-- │ (`scripts/ingest/rpps.ts`) appelle la RPC de build PUIS re-ANALYZE AVANT   │
-- │ l'enumeration BAN (sinon full-scan + timeout 60 s). Cf. plan §1/§2.        │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- Migration idempotente (CREATE OR REPLACE FUNCTION, GRANT/REVOKE idempotents ;
-- meme RETURNS TABLE ⇒ CREATE OR REPLACE legal, pas de DROP). Appliquee en PROD
-- par le mainteneur via le canal psql pooler ; en
-- CI/local via psql / docker exec (la CLI supabase SKIPPE les migrations
-- `YYYYMMDDThhmmss_` — contrainte projet connue).

-- 2026-05-18 refonte : staging-create BAN-free (cf. docs/plans/2026-05-18-ban-rearm-postenrichment-index-step.md ; la bombe 57014 ne doit jamais revenir — index BAN créés par ingest_build_rpps_staging_ban_indexes, jamais ici)
--
-- ───────────────────────────────────────────────────────────────────────────
-- (1) [SUPPRIMÉ — refonte 2026-05-18] L'ancien index BAN autonome COMPOSITE
--     `rpps_ban_eligible_normkey_id_idx` posé sur la table `rpps`
--     (forme CI/local + procédure prod CONCURRENTLY / DUAL-INDEX GATE) a été
--     RETIRÉ. Les 2 index fonctionnels BAN (clé-seule pour les sauts skip-scan
--     + composite (keyexpr, id) pour le représentant MIN(id)) sont désormais
--     créés EXCLUSIVEMENT par la RPC `ingest_build_rpps_staging_ban_indexes()`
--     (migration 20260519T100000), sur `rpps_staging` APRÈS l'enrichment
--     FINESS et AVANT le swap atomique : ils voyagent dans `rpps` via le
--     RENAME du swap. Les créer ici (ou dans `ingest_create_rpps_staging`
--     ci-dessous) les ferait maintenir pendant l'INSERT 2,24 M + l'UPDATE
--     d'enrichment = l'AGGRAVANT prouvé du timeout 57014 (cf. plan §0/§1 +
--     20260518T140000). La RPC skip-scan `rpps_distinct_eligible_keys`
--     ci-dessous (section 2) reste réécrite ici — son corps consomme le
--     wrapper `rpps_address_key_for_index` (défini 20260517T120000 section 0),
--     MÊME expression que les 2 index posés par la RPC de build.
-- ───────────────────────────────────────────────────────────────────────────

-- ───────────────────────────────────────────────────────────────────────────
-- (2) RPC d'enumeration SKIP-SCAN : cles d'adresse DISTINCTES eligibles,
--     enumerees en O(cles distinctes) par une boucle PL/pgSQL BORNEE
--     `FOR i IN 1..p_limit` (PAS de CTE recursive — zero pari sur le push-down
--     du LIMIT, cf. HARDENING en-tete). Chaque iteration : (a) UNE descente
--     B-tree saute au PROCHAIN keyexpr eligible > prev (franchit un groupe
--     duplique geant en 1 seek) ; (b) un SEEK CORRELE sur l'index composite
--     resout le representant MIN(id) de ce keyexpr. RETURNS les cles brutes
--     SANS LEFT JOIN au cache geocoded_addresses : la logique 3-cas (jamais
--     tente / retente jusqu'au cap / accepte fige) reste cote JS (separation
--     des responsabilites). Whitelist par CASE EXPLICITE (anti-injection).
--     `btrim` sur les colonnes retournees miroite JS `.trim()` et neutralise
--     le blank-pad CHAR(5) symetriquement (invariant inchange). Meme RETURNS
--     TABLE shape ⇒ CREATE OR REPLACE legal (pas de DROP).
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
  v_tbl       TEXT;
  v_sql_skip  TEXT;
  v_sql_seek  TEXT;
  v_prev      TEXT := p_after;
  v_key       TEXT;
  v_adr       TEXT;
  v_cp        TEXT;
  v_insee     TEXT;
BEGIN
  -- Whitelist par CASE EXPLICITE — JAMAIS format(%I, p_source_table) sur une
  -- entree libre (injection). Hors whitelist ⇒ EXCEPTION (jamais de lignes
  -- silencieuses : un appel mal cable doit etre BRUYANT, pas vide).
  v_tbl := CASE p_source_table
             WHEN 'rpps'         THEN 'rpps'
             WHEN 'rpps_staging' THEN 'rpps_staging'
             ELSE NULL
           END;
  IF v_tbl IS NULL THEN
    RAISE EXCEPTION 'rpps_distinct_eligible_keys: invalid source table %', p_source_table
      USING ERRCODE = '22023';
  END IF;

  -- Garde p_limit : `FOR i IN 1..p_limit` avec p_limit <= 0 execute le corps
  -- ZERO fois et retourne un set VIDE SANS erreur. Le caller cap-agnostique
  -- (ban-backfill.mjs / cron) interprete une page vide comme « enumeration
  -- terminee » -> il s'arreterait en rapportant un succes avec 0 travail =
  -- panne TOTALE silencieuse de classe S-1. Meme doctrine « jamais de lignes
  -- silencieuses sur un appel mal cable » que la whitelist ci-dessus.
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'rpps_distinct_eligible_keys: p_limit must be >= 1 (got %)', p_limit
      USING ERRCODE = '22023';
  END IF;

  -- Les 2 requetes du skip-scan sont INVARIANTES de la boucle (seul %I = v_tbl,
  -- deja whiteliste ci-dessus, est interpole). On les materialise UNE fois ici :
  -- sinon format() reconstruit + re-parse la MEME chaine a CHAQUE iteration
  -- (p_limit re-parses inutiles sur le hot-path cron mensuel + backfill). Le
  -- seul parametre variable ($1) passe par USING, JAMAIS par interpolation.
  --
  -- Expression de cle = `rpps_address_key_for_index`, IDENTIQUE aux 2 index
  -- partiels (requis pour applicabilite planner ; sinon full-scan + timeout
  -- 60 s). Justification parite/transitivite : voir bloc DELEGATION en-tete.
  --
  -- (a) SAUT : prochaine cle eligible STRICTEMENT > $1. Une descente B-tree sur
  --     rpps_ban_eligible_normkey_idx franchit TOUT un groupe duplique geant en
  --     1 seek (vs Incremental Sort O(taille du groupe)). Le
  --     `($1 IS NULL OR keyexpr > $1)` n'est vrai que sur le tout premier appel
  --     quand p_after etait NULL (1re page cap-agnostique : global-min
  --     eligible) ; sinon v_prev est non-NULL ⇒ pur `keyexpr > v_prev`.
  v_sql_skip := format($q$
      SELECT rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)
      FROM %I t
      WHERE ( t.geom_source = 'commune_centroid'
              OR (t.geom IS NULL AND t.adresse IS NOT NULL) )
        AND ( $1 IS NULL
              OR rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) > $1 )
      ORDER BY rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)
      LIMIT 1
    $q$, v_tbl);
  -- (b) REPRESENTANT MIN(id) DETERMINISTE de la cle — seek correle sur l'index
  --     COMPOSITE partiel rpps_ban_eligible_normkey_id_idx
  --     (`keyexpr = $1 ORDER BY keyexpr, t.id LIMIT 1`) en O(1) par cle.
  v_sql_seek := format($q$
      SELECT btrim(t.adresse), btrim(t.code_postal), btrim(t.code_insee)
      FROM %I t
      WHERE ( t.geom_source = 'commune_centroid'
              OR (t.geom IS NULL AND t.adresse IS NOT NULL) )
        AND rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) = $1
      ORDER BY rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee), t.id
      LIMIT 1
    $q$, v_tbl);

  -- Boucle BORNEE STRUCTURELLEMENT a ≤ p_limit descentes d'index (HARDENING :
  -- PAS de CTE recursive — zero dependance au push-down du LIMIT).
  FOR i IN 1..p_limit LOOP
    EXECUTE v_sql_skip INTO v_key USING v_prev;
    EXIT WHEN v_key IS NULL;
    EXECUTE v_sql_seek INTO v_adr, v_cp, v_insee USING v_key;

    address_key := v_key;
    adresse     := v_adr;
    code_postal := v_cp;
    code_insee  := v_insee;
    RETURN NEXT;

    v_prev := v_key;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION rpps_distinct_eligible_keys(TEXT, TEXT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION rpps_distinct_eligible_keys(TEXT, TEXT, INT) TO service_role;

COMMENT ON FUNCTION rpps_distinct_eligible_keys(TEXT, TEXT, INT) IS
  'Phase 2 RPPS BAN CORRECTIVE G5 — enumere cote SERVEUR les cles d''adresse DISTINCTES eligibles au geocodage BAN en SKIP-SCAN O(cles distinctes) : boucle PL/pgSQL BORNEE FOR i IN 1..p_limit (≤ p_limit descentes B-tree PAR CONSTRUCTION — PAS de CTE recursive, zero pari sur le push-down du LIMIT). Saute un groupe duplique geant (cluster centroide commune dense, hotspot Paris ~77k) en UNE descente (keyexpr > prev ORDER BY keyexpr LIMIT 1 sur rpps_ban_eligible_normkey_idx) ; representant MIN(id) DETERMINISTE par seek correle sur l''index COMPOSITE partiel rpps_ban_eligible_normkey_id_idx (keyexpr = $1 ORDER BY keyexpr, id LIMIT 1). Remplace l''ancienne forme DISTINCT ON + ORDER BY keyexpr,id LIMIT (Incremental Sort O(taille du groupe) → timeout 60 s pooler sur la page d''un groupe geant — defaut PROD prouve). DELEGUE la cle au twin d''indexation rpps_address_key_for_index → jumeau rpps_normalize_address_key (UNIQUE source de verite, HARD GATE de parite PAR TRANSITIVITE — aucune re-implementation/inlining). MEME expression que les 2 index partiels (sinon planner inapplicable). Whitelist par CASE (rpps|rpps_staging ; hors whitelist ⇒ EXCEPTION 22023, jamais de lignes silencieuses). RETURNS cles BRUTES SANS LEFT JOIN cache (logique 3-cas en JS). Keyset > $1 strict + terminaison caller page VIDE = cap-agnostique. SECURITY DEFINER, EXECUTE service_role only.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2026-05-18 refonte : staging-create BAN-free (cf. docs/plans/2026-05-18-ban-rearm-postenrichment-index-step.md ; la bombe 57014 ne doit jamais revenir — index BAN créés par ingest_build_rpps_staging_ban_indexes, jamais ici)
--
-- (3) ingest_create_rpps_staging : def canonique BAN-FREE de `main`
--     (20260518T140000, recopie verbatim de 20260516T020000:32-117). Le
--     SUPERSET BAN précédent (qui ajoutait rpps_staging_ban_eligible_normkey_idx
--     ET rpps_staging_ban_eligible_normkey_id_idx dans cette fonction)
--     RÉINTRODUISAIT la bombe 57014 : les 2 index fonctionnels BAN
--     Unicode-lourds étaient maintenus par row pendant l'INSERT 2,24 M +
--     l'UPDATE d'enrichment FINESS du cron mensuel. Les 2 index BAN sont
--     désormais créés EXCLUSIVEMENT par la RPC
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
