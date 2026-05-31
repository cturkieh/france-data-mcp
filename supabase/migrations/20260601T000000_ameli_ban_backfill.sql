-- Feature « backfill BAN Ameli » — jumeau STRICT du dispositif RPPS, transposé
-- à `annuaire_ameli`. Cf. docs/plans/ameli-ban-backfill.md.
--
-- ┌─ POURQUOI ────────────────────────────────────────────────────────────────┐
-- │ Le cache `geocoded_addresses` est PARTAGÉ RPPS↔Ameli (clé = adresse        │
-- │ normalisée). Il n'était rempli QUE par `ban-backfill.mjs` côté RPPS        │
-- │ (whitelist `rpps`/`rpps_staging`). Les adresses propres à Ameli — celles   │
-- │ qu'AUCUN PS RPPS ne partage — n'avaient donc AUCUN chemin de géocodage :   │
-- │ le `ban_join` Ameli (ingest_apply_ameli_ban_join_batch) joint le cache     │
-- │ mais ne le REMPLIT pas. ~61 k adresses distinctes Ameli restaient au       │
-- │ centroïde commune (mesure prod 2026-05-25, `ban_to_geocode_distinct`).     │
-- │                                                                            │
-- │ Cette migration crée les 3 objets SQL qui rendent ces adresses             │
-- │ énumérables/géocodables par `ban-backfill.mjs --source ameli`, en          │
-- │ RÉPLIQUANT 1:1 le patron RPPS (skip-scan O(clés) + count backstop S-1 +    │
-- │ STEP d'index post-chargement) — patron durci par 3 post-mortems prod.      │
-- │                                                                            │
-- │ FONCTION DE CLÉ : `rpps_address_key_for_index(adresse,code_postal,         │
-- │ code_insee)` (wrapper IMMUTABLE générique 3-arg, défini 20260517T120000),  │
-- │ byte-identique à `rpps_normalize_address_key` qu'utilisent le ban_join +   │
-- │ la mesure Ameli (parité prouvée prod : 0 divergence / 5 000 adresses       │
-- │ Ameli réelles). Donc les clés énumérées+soumises ICI matchent EXACTEMENT   │
-- │ celles que le ban_join Ameli cherche dans le cache. Gardé par              │
-- │ scripts/ingest/ban-eligibility-ameli-parity.test.ts.                       │
-- │                                                                            │
-- │ PRÉDICAT D'ÉLIGIBILITÉ AMELI = `geom_source = 'commune_centroid' AND       │
-- │ adresse IS NOT NULL` — DIFFÉRENT du RPPS (`... OR (geom IS NULL AND        │
-- │ adresse IS NOT NULL)`) : Ameli n'a pas de FINESS-join, son seul état non   │
-- │ précis est le centroïde commune (aucune ligne `geom IS NULL`). Byte-       │
-- │ identique à ingest_apply_ameli_ban_join_batch + ameli_measure_ban_to_      │
-- │ geocode (sinon le count/l'énumération divergent du set réellement posé →   │
-- │ classe S-1). C'est pourquoi des FONCTIONS DÉDIÉES, et non un arm du        │
-- │ whitelist de `rpps_distinct_eligible_keys` (qui porte le prédicat RPPS).   │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- APPLICATION : naming `YYYYMMDDThhmmss_` → la CLI Supabase saute ce fichier
-- (db reset ne l'applique pas) ; appliquée via MCP `apply_migration` ou le
-- canal psql pooler (jamais le SQL Editor pour du DDL lourd). Idempotente
-- (CREATE OR REPLACE + CREATE INDEX IF NOT EXISTS), rejouable sans effet de bord.
--
-- ⚠️ AMORÇAGE de la table SERVIE `annuaire_ameli` (étape OPS, hors migration) :
-- `ingest_build_ameli_staging_ban_indexes()` ci-dessous pose les index sur
-- `annuaire_ameli_staging` (ils voyagent vers `annuaire_ameli` au prochain
-- swap hebdo SI le cron est câblé — follow-up). Pour drainer AVANT ce câblage,
-- créer une fois les 2 index sur la table LIVE en CONCURRENTLY (runbook du
-- cadrage), sinon le skip-scan full-scan + timeout 60 s. Cf. docs/plans.

-- ───────────────────────────────────────────────────────────────────────────
-- (1) COUNT backstop S-1 — count des LIGNES éligibles (≥ clés distinctes).
--     Pilote `eligibleRowCount` + le garde-fou « ZERO distinct keys while
--     count > 0 » de ban-backfill.mjs. Whitelist CASE explicite (anti-injection)
--     {annuaire_ameli | annuaire_ameli_staging}. Prédicat Ameli byte-identique
--     aux sites (1)..(3) ci-dessous + ban_join + mesure.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ameli_count_ban_eligible_rows(p_source_table TEXT)
RETURNS BIGINT
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
             WHEN 'annuaire_ameli'         THEN 'annuaire_ameli'
             WHEN 'annuaire_ameli_staging' THEN 'annuaire_ameli_staging'
             ELSE NULL
           END;
  IF v_tbl IS NULL THEN
    RAISE EXCEPTION 'ameli_count_ban_eligible_rows: invalid source table %', p_source_table
      USING ERRCODE = '22023';
  END IF;

  EXECUTE format(
    'SELECT count(*) FROM %I t WHERE (t.geom_source = ''commune_centroid'' AND t.adresse IS NOT NULL)',
    v_tbl
  ) INTO v_cnt;
  RETURN v_cnt;
END;
$$;

REVOKE EXECUTE ON FUNCTION ameli_count_ban_eligible_rows(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ameli_count_ban_eligible_rows(TEXT) TO service_role;

COMMENT ON FUNCTION ameli_count_ban_eligible_rows(TEXT) IS
  'Backfill BAN Ameli — count des LIGNES éligibles au géocodage BAN (jumeau de rpps_count_ban_eligible_rows). Whitelist CASE (annuaire_ameli | annuaire_ameli_staging ; hors whitelist ⇒ EXCEPTION 22023). Prédicat geom_source=commune_centroid AND adresse IS NOT NULL byte-identique à ameli_distinct_eligible_keys / ingest_build_ameli_staging_ban_indexes / ingest_apply_ameli_ban_join_batch / ameli_measure_ban_to_geocode (gardé par ban-eligibility-ameli-parity.test.ts). Pilote le backstop S-1 de ban-backfill.mjs. SECURITY DEFINER, EXECUTE service_role only.';

-- ───────────────────────────────────────────────────────────────────────────
-- (2) ÉNUMÉRATION SKIP-SCAN O(clés distinctes) — jumeau STRICT de
--     rpps_distinct_eligible_keys (forme corrective G5 : boucle PL/pgSQL BORNÉE
--     FOR i IN 1..p_limit, PAS de CTE récursive — zéro pari sur le push-down du
--     LIMIT). (a) SAUT : prochaine clé éligible > $1 en UNE descente B-tree sur
--     ameli_staging_ban_eligible_normkey_idx ; (b) REPRÉSENTANT MIN(id)
--     déterministe par seek corrélé sur le composite (keyexpr, id). Clé via le
--     WRAPPER (jamais le jumeau nu — inliné → index inapplicable). Whitelist
--     CASE. RETURNS clés BRUTES sans LEFT JOIN cache (logique 3-cas en JS).
--     btrim sur les colonnes retournées (miroir JS .trim() + blank-pad CHAR(5)).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ameli_distinct_eligible_keys(
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
  v_tbl := CASE p_source_table
             WHEN 'annuaire_ameli'         THEN 'annuaire_ameli'
             WHEN 'annuaire_ameli_staging' THEN 'annuaire_ameli_staging'
             ELSE NULL
           END;
  IF v_tbl IS NULL THEN
    RAISE EXCEPTION 'ameli_distinct_eligible_keys: invalid source table %', p_source_table
      USING ERRCODE = '22023';
  END IF;

  -- Garde p_limit : p_limit < 1 (i.e. <= 0) exécuterait le corps `FOR i IN
  -- 1..p_limit` zéro fois → set VIDE SANS erreur → le caller cap-agnostique
  -- l'interprète comme « énumération terminée » → succès à 0 travail = panne
  -- TOTALE silencieuse S-1. (p_limit = 1 est LÉGITIME : 1 ligne.)
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'ameli_distinct_eligible_keys: p_limit must be >= 1 (got %)', p_limit
      USING ERRCODE = '22023';
  END IF;

  -- 2 requêtes INVARIANTES de la boucle (seul %I = v_tbl whitelisté interpolé ;
  -- $1 variable passe par USING). Expression de clé = rpps_address_key_for_index
  -- IDENTIQUE aux 2 index partiels (sinon planner inapplicable → full-scan +
  -- timeout 60 s). Prédicat Ameli = commune_centroid AND adresse NOT NULL.
  v_sql_skip := format($q$
      SELECT rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)
      FROM %I t
      WHERE ( t.geom_source = 'commune_centroid'
              AND t.adresse IS NOT NULL )
        AND ( $1 IS NULL
              OR rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) > $1 )
      ORDER BY rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee)
      LIMIT 1
    $q$, v_tbl);
  v_sql_seek := format($q$
      SELECT btrim(t.adresse), btrim(t.code_postal), btrim(t.code_insee)
      FROM %I t
      WHERE ( t.geom_source = 'commune_centroid'
              AND t.adresse IS NOT NULL )
        AND rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) = $1
      ORDER BY rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee), t.id
      LIMIT 1
    $q$, v_tbl);

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

REVOKE EXECUTE ON FUNCTION ameli_distinct_eligible_keys(TEXT, TEXT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ameli_distinct_eligible_keys(TEXT, TEXT, INT) TO service_role;

COMMENT ON FUNCTION ameli_distinct_eligible_keys(TEXT, TEXT, INT) IS
  'Backfill BAN Ameli — énumère côté SERVEUR les clés d''adresse DISTINCTES éligibles au géocodage BAN en SKIP-SCAN O(clés) (jumeau de rpps_distinct_eligible_keys : boucle PL/pgSQL BORNÉE FOR i IN 1..p_limit, PAS de CTE récursive). Saute un groupe dupliqué (cluster centroïde commune) en UNE descente (keyexpr > prev ORDER BY keyexpr LIMIT 1 sur ameli_staging_ban_eligible_normkey_idx) ; représentant MIN(id) déterministe par seek corrélé sur ameli_staging_ban_eligible_normkey_id_idx. Clé DÉLÉGUÉE au wrapper rpps_address_key_for_index → jumeau rpps_normalize_address_key (parité octet, byte-identique aux clés du cache cherchées par le ban_join Ameli). Prédicat geom_source=commune_centroid AND adresse IS NOT NULL (Ameli : pas de FINESS-join). Whitelist CASE (annuaire_ameli | annuaire_ameli_staging ; hors whitelist ⇒ EXCEPTION 22023). RETURNS clés BRUTES sans LEFT JOIN cache (logique 3-cas en JS). Keyset > $1 strict + terminaison caller page VIDE = cap-agnostique. Gardé par ban-eligibility-ameli-parity.test.ts. SECURITY DEFINER, EXECUTE service_role only.';

-- ───────────────────────────────────────────────────────────────────────────
-- (3) STEP D'INDEX post-chargement — jumeau de ingest_build_rpps_staging_ban_
--     indexes. Construit les 2 index fonctionnels partiels BAN sur
--     `annuaire_ameli_staging` (clé-seule pour les sauts skip-scan + composite
--     (keyexpr, id) pour le représentant MIN(id)). Doctrine PostgreSQL
--     « Populating a Database » : index APRÈS chargement de masse, jamais
--     maintenus pendant l'INSERT/UPDATE. NE JAMAIS créer ces index dans
--     ingest_create_annuaire_ameli_staging (ils seraient maintenus par row
--     pendant le streamCsvToStaging ~462k inserts) — c'est pourquoi ce STEP
--     dédié, à appeler post-ban_join / pré-swap (câblage cron = follow-up).
--     Les index voyagent vers `annuaire_ameli` via le RENAME du swap → ils
--     N'apparaissent JAMAIS comme `CREATE INDEX ON annuaire_ameli` (contourne
--     le garde-fou staging-parity, comme le patron RPPS). CREATE INDEX bloquant
--     classique (annuaire_ameli_staging ne sert aucune lecture prod ;
--     CONCURRENTLY interdit en fonction plpgsql). Prédicat + expression
--     byte-identiques à (1)+(2) + ban_join + mesure.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ingest_build_ameli_staging_ban_indexes()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '10min'
AS $$
BEGIN
  CREATE INDEX IF NOT EXISTS ameli_staging_ban_eligible_normkey_idx
    ON annuaire_ameli_staging (rpps_address_key_for_index(adresse, code_postal, code_insee))
    WHERE geom_source = 'commune_centroid'
          AND adresse IS NOT NULL;

  CREATE INDEX IF NOT EXISTS ameli_staging_ban_eligible_normkey_id_idx
    ON annuaire_ameli_staging (rpps_address_key_for_index(adresse, code_postal, code_insee), id)
    WHERE geom_source = 'commune_centroid'
          AND adresse IS NOT NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_build_ameli_staging_ban_indexes() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_build_ameli_staging_ban_indexes() TO service_role;

COMMENT ON FUNCTION ingest_build_ameli_staging_ban_indexes() IS
  'Backfill BAN Ameli — construit les 2 index fonctionnels partiels BAN (ameli_staging_ban_eligible_normkey_idx clé-seule + ameli_staging_ban_eligible_normkey_id_idx composite (keyexpr, id)) sur annuaire_ameli_staging, jumeau de ingest_build_rpps_staging_ban_indexes. À appeler post-ban_join / pré-swap (câblage scripts/ingest/ameli.ts = follow-up tracé) : les index voyagent dans annuaire_ameli via le RENAME du swap → JAMAIS créés dans ingest_create_annuaire_ameli_staging (maintenus pendant les ~462k inserts = pénalité). CREATE INDEX bloquant (staging non servie ; CONCURRENTLY interdit en plpgsql). Expression rpps_address_key_for_index + prédicat geom_source=commune_centroid AND adresse IS NOT NULL byte-identiques aux autres sites (gardés par ban-eligibility-ameli-parity.test.ts). SECURITY DEFINER, statement_timeout=10min, EXECUTE service_role only. Idempotente (CREATE INDEX IF NOT EXISTS).';
