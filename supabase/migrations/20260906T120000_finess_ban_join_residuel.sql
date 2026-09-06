-- FINESS phase 2 (item 1) — géocoder le résiduel sans point via le cache BAN.
-- Mesure prod du 2026-09-06 (finess = 104 734 EGE) : 5 269 sans point, dont
-- 4 622 avec une voie (4 251 clés d'adresse distinctes), 168 déjà dans
-- `geocoded_addresses` en précision rue/bâtiment, 4 296 jamais soumises à la
-- BAN, 647 sans voie (non géocodables autrement que par centroïde : REFUSÉ,
-- cf. 20260905T210000 — un centroïde dans finess.geom contaminerait le RPPS
-- sous l'étiquette `finess_join`). L'ANS ne fournit `cleInInteropBAN` que
-- pour les EGE déjà géolocalisés : 0 clé BAN sur le résiduel. Après le drain
-- du 2026-09-06 : 4 251/4 251 clés en cache, 2 520 acceptées précises → la
-- pose écrit 2 720 lignes (dry-run), couverture 94,97 % → 97,57 %.
--
-- Même mécanisme que RPPS/Ameli (`docs/plans/ban-join.md`) : le cron POSE
-- depuis le cache, le drain `ban-backfill.mjs --source finess` REMPLIT le
-- cache hors cron. Clé d'adresse = `rpps_address_key_for_index(voie,
-- code_postal, code_insee)` — le MÊME wrapper des deux côtés (pose et
-- énumération), jamais le jumeau nu (doctrine `ban-eligibility-index-expr-parity`).
-- `voie` porte DÉJÀ numéro + type + libellé (« 10 R D'ESTIENNES D'ORVES ») :
-- ne PAS le préfixer de num_voie/type_voie (mesuré : la clé concaténée ne
-- retrouve que 39 lignes en cache contre 168).
--
-- (0) finess_is_ban_eligible / finess_resolve_source_table — le prédicat
--     d'éligibilité et la whitelist de table, écrits UNE fois (les 3 sites
--     visent la même source : une fonction inlinée, pas trois copies à garder
--     en parité).
-- (1) ingest_apply_finess_ban_join — pose cache → finess_staging, appelée
--     APRÈS `ingest_apply_finess_geom_previous` (le point hérité prime : il
--     est la continuité de la donnée servie ; la BAN ne comble que le VIDE).
--     Un seul UPDATE : mesuré 454 ms (Nested Loop + Memoize sur la clé, sonde
--     `geocoded_addresses_pkey`, 20 K buffers) — pas de keyset. Acceptation
--     par PRÉCISION (mémoire `ban-acceptance-precision-tier`) : `accepted`
--     porte déjà le gate score ≥ 0,5 ∧ type ∈ ACCEPTED_PRECISION_TYPES
--     (`src/core/ban-bulk-client.ts`, parité testée) ; le filtre `result_type`
--     est répété ici pour que « jamais municipality dans finess.geom » soit
--     lisible dans la RPC, pas seulement dans le TS qui remplit le cache.
-- (2) finess_eligible_rows_after_id / finess_count_ban_eligible_rows — les 2
--     RPC jumelles que `ban-backfill.mjs` attend par source. Curseur =
--     `num_finess` (PK CHAR(9), pas de bigint) → curseur TEXTE renvoyé sous
--     son nom, sentinelle NULL (contrat `assertSourcesValid` : seul un curseur
--     nommé `id` est numérique). Plan mesuré : Bitmap Index Scan sur
--     `finess_geom_gist` (`geom IS NULL`) puis top-N, ~0,5 s/page de 1 000 —
--     le poste dominant est la clé Unicode projetée, pas le scan ; un index
--     partiel serait négatif (parité staging + maintenance pendant 105 K
--     inserts, l'aggravant du post-mortem RPPS).
-- (3) ingest_apply_finess_geom_previous — PROPAGE la provenance `ban_address`
--     d'un point hérité (sinon la pose BAN serait réétiquetée `previous_ingest`
--     au cron suivant et la feature deviendrait invisible en SQL).
-- (4) ingest_finess_staging_diff — expose `staging_no_voie` (résiduel JAMAIS
--     géocodable) pour que le reste-à-drainer soit lisible : 647 mesurés.
--
-- Droits : REVOKE FROM PUBLIC/anon/authenticated + GRANT service_role, comme
-- les 47 autres migrations (revue 2026-09-06 : le premier apply laissait un
-- UPDATE SECURITY DEFINER exécutable par PUBLIC).

CREATE OR REPLACE FUNCTION finess_is_ban_eligible(p_geom geometry, p_voie text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_geom IS NULL AND p_voie IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION finess_resolve_source_table(p_source_table TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  -- Whitelist par CASE EXPLICITE — JAMAIS format(%I, p_source_table) sur une
  -- entrée libre. Hors whitelist ⇒ EXCEPTION (jamais de lignes silencieuses).
  RETURN CASE p_source_table
           WHEN 'finess'         THEN 'finess'
           WHEN 'finess_staging' THEN 'finess_staging'
         END;
END;
$$;

CREATE OR REPLACE FUNCTION ingest_apply_finess_ban_join()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE finess_staging s
     SET geom = ST_SetSRID(ST_MakePoint(g.lon, g.lat), 4326),
         raw  = COALESCE(s.raw, '{}'::jsonb)
                || jsonb_build_object('geom_source', 'ban_address')
    FROM geocoded_addresses g
   WHERE finess_is_ban_eligible(s.geom, s.voie)
     AND g.address_key = rpps_address_key_for_index(s.voie, s.code_postal::text, s.code_insee::text)
     AND g.accepted = true
     AND g.result_type IN ('housenumber', 'street', 'locality');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

CREATE OR REPLACE FUNCTION finess_count_ban_eligible_rows(p_source_table TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v_tbl TEXT := finess_resolve_source_table(p_source_table);
  v_cnt BIGINT;
BEGIN
  IF v_tbl IS NULL THEN
    RAISE EXCEPTION 'finess_count_ban_eligible_rows: invalid source table %', p_source_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  EXECUTE format('SELECT count(*) FROM %I t WHERE finess_is_ban_eligible(t.geom, t.voie)', v_tbl)
    INTO v_cnt;
  RETURN v_cnt;
END;
$$;

CREATE OR REPLACE FUNCTION finess_eligible_rows_after_id(
  p_source_table TEXT DEFAULT 'finess',
  p_after_id     TEXT DEFAULT NULL,
  p_limit        INTEGER DEFAULT 5000
)
RETURNS TABLE(num_finess TEXT, address_key TEXT, adresse TEXT, code_postal TEXT, code_insee TEXT)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v_source TEXT := finess_resolve_source_table(p_source_table);
BEGIN
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'finess_eligible_rows_after_id: invalid source_table %, expected ''finess'' | ''finess_staging''',
      p_source_table USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- `FOR`/`LIMIT` avec p_limit <= 0 rendrait un set VIDE sans erreur → le
  -- client cap-agnostique conclurait « énumération terminée » (S-1).
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'finess_eligible_rows_after_id: p_limit must be >= 1 (got %)', p_limit
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Curseur TEXTE : `$1 IS NULL` = 1re page. ORDER BY et prédicat keyset sur
  -- la MÊME expression `num_finess::text` (un ORDER BY bpchar nu ne coïncide
  -- avec la comparaison text que parce que `NUM_FINESS_EGE` impose 9
  -- caractères sans padding — invariant du parseur, pas de la colonne).
  RETURN QUERY EXECUTE format($q$
    SELECT t.num_finess::text AS num_finess,
           rpps_address_key_for_index(t.voie, t.code_postal::text, t.code_insee::text) AS address_key,
           t.voie::text AS adresse, t.code_postal::text, t.code_insee::text
    FROM %I t
    WHERE finess_is_ban_eligible(t.geom, t.voie)
      AND ($1 IS NULL OR t.num_finess::text > $1)
    ORDER BY t.num_finess::text
    LIMIT $2
  $q$, v_source) USING p_after_id, p_limit;
END;
$$;

-- (3) Repli previous_ingest : recopie VERBATIM de 20260905T210000 + propagation
--     de la provenance `ban_address` (un point BAN hérité reste un point BAN).
CREATE OR REPLACE FUNCTION public.ingest_apply_finess_geom_previous()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE finess_staging s
     SET geom             = f.geom,
         coordx_lambert93 = COALESCE(s.coordx_lambert93, f.coordx_lambert93),
         coordy_lambert93 = COALESCE(s.coordy_lambert93, f.coordy_lambert93),
         raw              = COALESCE(s.raw, '{}'::jsonb)
                            || jsonb_build_object('geom_source',
                                 CASE WHEN f.raw->>'geom_source' = 'ban_address'
                                      THEN 'ban_address'
                                      ELSE 'previous_ingest' END)
    FROM finess f
   WHERE f.num_finess = s.num_finess
     AND s.geom IS NULL
     AND f.geom IS NOT NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

-- (4) Diff staging ↔ prod : recopie VERBATIM de 20260905T213000 + `staging_no_voie`.
CREATE OR REPLACE FUNCTION public.ingest_finess_staging_diff()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'staging_rows',      (SELECT count(*) FROM finess_staging),
    'prod_rows',         (SELECT count(*) FROM finess),
    'prod_with_geom',    (SELECT count(*) FROM finess WHERE geom IS NOT NULL),
    'added',             (SELECT count(*) FROM finess_staging s
                           WHERE NOT EXISTS (SELECT 1 FROM finess f WHERE f.num_finess = s.num_finess)),
    'removed',           (SELECT count(*) FROM finess f
                           WHERE NOT EXISTS (SELECT 1 FROM finess_staging s WHERE s.num_finess = f.num_finess)),
    'lost_geom',         (SELECT count(*) FROM finess f
                           JOIN finess_staging s ON s.num_finess = f.num_finess
                          WHERE f.geom IS NOT NULL AND s.geom IS NULL),
    'moved_gt_500m',     (SELECT count(*) FROM finess_staging s
                           JOIN finess f ON f.num_finess = s.num_finess
                          WHERE s.geog IS NOT NULL AND f.geog IS NOT NULL
                            AND NOT ST_DWithin(s.geog, f.geog, 500)),
    'staging_geom_null', (SELECT count(*) FROM finess_staging WHERE geom IS NULL),
    'staging_no_voie',   (SELECT count(*) FROM finess_staging WHERE geom IS NULL AND voie IS NULL),
    'staging_geom_source', (SELECT COALESCE(jsonb_object_agg(src, n), '{}'::jsonb)
                              FROM (SELECT COALESCE(raw->>'geom_source', 'none') AS src, count(*) AS n
                                      FROM finess_staging GROUP BY 1) t)
  ) INTO v;
  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION finess_is_ban_eligible(geometry, text)                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION finess_resolve_source_table(TEXT)                      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ingest_apply_finess_ban_join()                         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION finess_count_ban_eligible_rows(TEXT)                   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION finess_eligible_rows_after_id(TEXT, TEXT, INTEGER)     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ingest_apply_finess_geom_previous()             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ingest_finess_staging_diff()                    FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION finess_is_ban_eligible(geometry, text)                 TO service_role;
GRANT  EXECUTE ON FUNCTION finess_resolve_source_table(TEXT)                      TO service_role;
GRANT  EXECUTE ON FUNCTION ingest_apply_finess_ban_join()                         TO service_role;
GRANT  EXECUTE ON FUNCTION finess_count_ban_eligible_rows(TEXT)                   TO service_role;
GRANT  EXECUTE ON FUNCTION finess_eligible_rows_after_id(TEXT, TEXT, INTEGER)     TO service_role;
GRANT  EXECUTE ON FUNCTION public.ingest_apply_finess_geom_previous()             TO service_role;
GRANT  EXECUTE ON FUNCTION public.ingest_finess_staging_diff()                    TO service_role;
