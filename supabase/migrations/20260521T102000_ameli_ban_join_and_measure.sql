-- Chantier C — Géocodage Ameli. Cf. docs/plans/ameli-geocoding.md.
--
-- 3/3 : les 3 RPC du pipeline Ameli BAN.
--   (1) ingest_analyze_ameli_staging       — ANALYZE pré-ban_join
--   (2) ingest_apply_ameli_ban_join_batch  — UPDATE keyset cache → staging
--   (3) ameli_measure_ban_to_geocode       — mesure best-effort delta cache
--
-- Patron : jumeau STRICT du pipeline RPPS prouvé prod 2026-05-19
-- (migrations 20260517T120000 + 20260519T180000 + 20260520T000000). Toute
-- différence avec RPPS est documentée inline.
--
-- DIFFÉRENCE ARCHI MAJEURE avec RPPS : Ameli n'a PAS de branche FINESS join
-- (pas de num_finess côté CSV Ameli). Il n'y a qu'UN seul état non-précis :
-- `commune_centroid` (posé d'office à l'INSERT par parseAmeliRecord depuis
-- l'index commune). Le prédicat d'éligibilité Ameli est donc plus simple
-- que RPPS : pas de branche `(geom IS NULL AND adresse IS NOT NULL)` car
-- toutes les rows Ameli inserées ont déjà un geom (centroïde commune).
--
-- POURQUOI une clé partagée avec RPPS sans nouveau cache : la fonction
-- `rpps_normalize_address_key(adresse, code_postal, code_insee)` est
-- GÉNÉRIQUE (nom historique trompeur — ne dépend de rien de RPPS). Le cache
-- `geocoded_addresses` est agnostique de source (PK = `address_key`). Cf.
-- docs/plans/ameli-geocoding.md « Décision Option A ». Mesure prod
-- 2026-05-21 : hit rate gratuit 33 % sur échantillon, cache déjà rempli
-- 295 K accepted via cycles RPPS — bascule mécanique vers Ameli.
--
-- APPLICATION : naming `YYYYMMDDThhmmss` → CLI Supabase saute, applied
-- MANUELLEMENT en prod via dashboard SQL editor (canal V0.12.3).
-- Idempotente : CREATE OR REPLACE FUNCTION, ALTER TABLE ingest_log SKIPPÉ
-- (les 2 colonnes ban_eligible_distinct / ban_to_geocode_distinct existent
-- déjà depuis 20260520T000000).

-- ───────────────────────────────────────────────────────────────────────────
-- (1) ANALYZE annuaire_ameli_staging — pré-ban_join
-- ───────────────────────────────────────────────────────────────────────────
-- POURQUOI : après le bulk INSERT (~462 K rows, 462 batches de 500 ≈ 2 min),
-- les stats du planner sont vides. La jointure de `ingest_apply_ameli_ban_join_batch`
-- (`staging ⟕ geocoded_addresses ON g.address_key = rpps_normalize_address_key(...)`)
-- repose sur le PK `geocoded_addresses_pkey` côté cache et un ORDER BY id
-- côté staging — sans stats, le planner peut basculer en seq scan plein
-- cache (~331 K rows) par batch → 57014 en zone dense. ANALYZE est autorisé
-- dans une transaction (≠ VACUUM). Symétrique strict de `ingest_analyze_
-- rpps_staging`.
CREATE OR REPLACE FUNCTION ingest_analyze_ameli_staging()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
BEGIN
  -- SET statement_timeout='55s' aligné sur ingest_analyze_rpps_staging (fix C
  -- 2026-05-18) — sans SET fonction, `service_role` hériterait du budget
  -- `authenticator` 8s ; un ANALYZE lent à froid sur ~462 K rows post-bulk
  -- INSERT pourrait dépasser → 57014 silencieux une étape plus tôt que prévu.
  -- Borne ≤55s = sous cap passerelle PostgREST ~60s (gotcha CLAUDE.md).
  EXECUTE 'ANALYZE annuaire_ameli_staging';
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_analyze_ameli_staging() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_analyze_ameli_staging() TO service_role;

COMMENT ON FUNCTION ingest_analyze_ameli_staging() IS
  'Chantier C 2026-05-21 — rafraîchit les stats planner sur annuaire_ameli_staging AVANT ingest_apply_ameli_ban_join_batch. Sans stats fraîches post-bulk INSERT, le planner peut basculer la jointure cache en seq scan plein → 57014 en zone dense. ANALYZE autorisé en transaction (contrairement à VACUUM). Symétrique strict de ingest_analyze_rpps_staging. SECURITY DEFINER, EXECUTE service_role only.';

-- ───────────────────────────────────────────────────────────────────────────
-- (2) ingest_apply_ameli_ban_join_batch — UPDATE keyset cache → staging
-- ───────────────────────────────────────────────────────────────────────────
-- Jumeau STRICT de `ingest_apply_rpps_ban_join_batch` (20260519T180000),
-- adapté au prédicat d'éligibilité Ameli (plus simple : un seul état non
-- précis = `commune_centroid`).
--
-- PARITÉ EXPRESSION : la clé `rpps_normalize_address_key(adresse, code_postal,
-- code_insee)` est identique à celle utilisée par le pipeline RPPS et par
-- l'ingestion du cache (ban-backfill.mjs côté JS, parité byte-à-byte
-- garde-fouée par `scripts/ingest/ban-geocode-parity.integration.test.ts`).
--
-- POURQUOI KEYSET (p_after BIGINT) et NON sentinelle : prouvé prod RPPS
-- (cf. docs/plans/ban-join.md §3.2). La sentinelle re-scanne le préfixe
-- déjà traité → quadratique → 57014 fin de parcours ; le keyset démarre
-- où le lot précédent s'est arrêté → linéaire, ~4,8 s/lot constant. Ameli
-- a un volume comparable côté éligibilité (462 K rows × hit rate ~33 % = ~150 K
-- posés en cron #1, ~370 K post-backfill) — le pattern keyset RPPS scale.
--
-- statement_timeout = '55s' (< cap passerelle PostgREST 60 s — gotcha
-- CLAUDE.md « RPC d'ingestion longue via PostgREST »).
CREATE OR REPLACE FUNCTION ingest_apply_ameli_ban_join_batch(
  p_after BIGINT, p_limit INT)
RETURNS TABLE(last_id BIGINT, applied INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '55s'
AS $$
BEGIN
  RETURN QUERY
  WITH batch AS (
    SELECT id,
           rpps_normalize_address_key(adresse, code_postal, code_insee) AS akey
    FROM annuaire_ameli_staging
    WHERE id > p_after
      AND geom_source = 'commune_centroid'
      AND adresse IS NOT NULL
    ORDER BY id
    LIMIT p_limit
  ),
  -- wCTE data-modifying : PostgreSQL l'exécute EXACTEMENT UNE FOIS dès qu'il
  -- est référencé n'importe où dans la requête (ici via le count scalaire
  -- ci-dessous). NE PAS le « simplifier » en le croyant mort.
  upd AS (
    UPDATE annuaire_ameli_staging r
    SET geom = ST_SetSRID(ST_MakePoint(g.lon, g.lat), 4326),
        geom_source = 'ban_address'
    FROM batch b
    JOIN geocoded_addresses g
      ON g.address_key = b.akey AND g.accepted = true
    WHERE r.id = b.id
    RETURNING 1
  )
  -- last_id = dernière clé VUE du lot (curseur keyset, matchée ou non) ;
  -- applied = nb réellement posé (count des RETURNING de `upd`).
  SELECT max(b.id)::BIGINT AS last_id,
         (SELECT count(*)::INT FROM upd) AS applied
  FROM batch b;
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_apply_ameli_ban_join_batch(BIGINT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_apply_ameli_ban_join_batch(BIGINT, INT) TO service_role;

COMMENT ON FUNCTION ingest_apply_ameli_ban_join_batch(BIGINT, INT) IS
  'Chantier C 2026-05-21 — pose ensembliste cache geocoded_addresses → annuaire_ameli_staging pour UN lot keyset (p_after curseur, p_limit). Jumeau STRICT de ingest_apply_rpps_ban_join_batch (20260519T180000) avec prédicat éligibilité simplifié (Ameli n''a qu''un seul état non précis : commune_centroid + adresse NOT NULL — pas de branche finess_join comme RPPS). Clé partagée rpps_normalize_address_key (générique malgré le nom historique). JOIN (pas LEFT JOIN) : une ligne sans hit cache garde commune_centroid (repli ~3 km). RETURNS (last_id, applied) : last_id = max(id) du lot VU matché ou non = curseur ; NULL ⇒ page vide ⇒ fin ; applied = nb réellement posés. SECURITY DEFINER, statement_timeout=55s, EXECUTE service_role only. Idempotente.';

-- ───────────────────────────────────────────────────────────────────────────
-- (3) ameli_measure_ban_to_geocode — observabilité best-effort
-- ───────────────────────────────────────────────────────────────────────────
-- Jumeau de `rpps_measure_ban_to_geocode` (20260520T000000). Logge dans
-- `ingest_log.ban_eligible_distinct` + `ban_to_geocode_distinct` à chaque
-- cron Ameli pour dimensionner la future Phase 2 (automatisation backfill).
-- Réutilise les 2 colonnes ingest_log ajoutées par la migration RPPS
-- (partagées Ameli/RPPS — `ingest_log.source` distingue).
--
-- ANTI-INJECTION : CASE whitelist EXPLICITE ('annuaire_ameli_staging' |
-- 'annuaire_ameli'). Toute autre valeur ⇒ EXCEPTION (jamais lecture
-- silencieuse à 0). Pattern aligné sur rpps_measure_ban_to_geocode.
--
-- COÛT : DISTINCT de la clé sur les éligibles (~462 K rows pre-backfill,
-- ~312 K post-backfill). Sans index fonctionnel sur la clé (volontairement
-- absent côté Ameli — pas de skip-scan nécessaire car pas de FINESS join
-- pré-step) : seq scan + sort. statement_timeout='55s' aligné gotcha.
CREATE OR REPLACE FUNCTION ameli_measure_ban_to_geocode(
  p_source_table TEXT DEFAULT 'annuaire_ameli_staging'
)
RETURNS TABLE (
  eligible_distinct    BIGINT,
  to_geocode_distinct  BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout = '55s'
SET search_path = public, extensions
AS $$
DECLARE
  v_source TEXT;
BEGIN
  v_source := CASE p_source_table
    WHEN 'annuaire_ameli_staging' THEN 'annuaire_ameli_staging'
    WHEN 'annuaire_ameli'         THEN 'annuaire_ameli'
    ELSE NULL
  END;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'ameli_measure_ban_to_geocode: invalid source_table %, expected ''annuaire_ameli_staging'' | ''annuaire_ameli''',
      p_source_table USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY EXECUTE format($q$
    WITH staging_eligible AS (
      SELECT DISTINCT rpps_normalize_address_key(t.adresse, t.code_postal, t.code_insee) AS k
      FROM %I t
      WHERE t.geom_source = 'commune_centroid'
        AND t.adresse IS NOT NULL
    )
    SELECT
      count(*)::BIGINT AS eligible_distinct,
      count(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM geocoded_addresses g
           WHERE g.address_key = se.k
             AND (g.accepted = true OR g.ban_attempt_count >= 3)
        )
      )::BIGINT AS to_geocode_distinct
    FROM staging_eligible se
  $q$, v_source);
END;
$$;

REVOKE EXECUTE ON FUNCTION ameli_measure_ban_to_geocode(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ameli_measure_ban_to_geocode(TEXT) TO service_role;

COMMENT ON FUNCTION ameli_measure_ban_to_geocode(TEXT) IS
  'Chantier C 2026-05-21 — mesure best-effort du delta cache BAN à chaque cron Ameli. Retourne (eligible_distinct, to_geocode_distinct) pour la table source whitelistée (annuaire_ameli_staging | annuaire_ameli). Best-effort côté caller : scripts/ingest/ameli.ts logue les 2 chiffres dans ingest_log.ban_eligible_distinct + ban_to_geocode_distinct (colonnes ajoutées par 20260520T000000, partagées Ameli/RPPS — source distingue). Dimensionne la future Phase 2 (automatisation backfill BAN). Jumeau de rpps_measure_ban_to_geocode. SECURITY DEFINER, statement_timeout=55s, EXECUTE service_role only.';

NOTIFY pgrst, 'reload schema';
