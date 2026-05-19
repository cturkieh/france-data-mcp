-- Phase 1 — Brique MESURE du delta BAN mensuel.
--
-- But : à chaque cron RPPS, enregistrer dans `ingest_log` (a) le nb d'adresses
-- DISTINCTES éligibles dans `rpps_staging` (= would-be-eligible-for-BAN), et
-- (b) le sous-ensemble PAS encore résolu/capé dans le cache `geocoded_addresses`
-- (= ce que la future Phase 2 enverra effectivement à la BAN). Observabilité
-- pure, AUCUN changement de comportement du pipeline : on logge, on continue.
--
-- POURQUOI MAINTENANT : la décision d'archi de la Phase 2 (automatisation du
-- re-géocodage récurrent) dépend du chiffre RÉEL du delta mensuel. La
-- discipline projet « prouver par la prod avant de coder » exige cette mesure
-- avant tout code Phase 2. Cf. mémoire `ban-acceptance-precision-tier`,
-- `docs/plans/ban-join.md`, et le commit explicatif.
--
-- IDÉMPOTENCE : CREATE OR REPLACE FUNCTION ; ALTER TABLE ... ADD COLUMN IF
-- NOT EXISTS sur les 2 colonnes — rejouable.

-- ───────────────────────────────────────────────────────────────────────────
-- (1) Extension du schéma `ingest_log` : 2 colonnes nullable pour la mesure.
--     Nullable : un run pré-2026-05-20 ou un run qui n'a pas atteint le step
--     de mesure (échec early phase) loggue NULL → distinct d'un "0 mesuré".
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE ingest_log
  ADD COLUMN IF NOT EXISTS ban_eligible_distinct INTEGER,
  ADD COLUMN IF NOT EXISTS ban_to_geocode_distinct INTEGER;

COMMENT ON COLUMN ingest_log.ban_eligible_distinct IS
  'Phase 1 mesure — nb d''adresses DISTINCTES éligibles BAN dans rpps_staging au moment du cron (post-FINESS, pre-ban_join). NULL = mesure non exécutée (run pre-2026-05-20 ou échec early). Mesuré par rpps_measure_ban_to_geocode.';
COMMENT ON COLUMN ingest_log.ban_to_geocode_distinct IS
  'Phase 1 mesure — sous-ensemble des éligibles distincts PAS encore résolu/capé dans geocoded_addresses (= taille de la file BAN qu''un re-géocodage automatique aurait à traiter). NULL = idem. Mesuré par rpps_measure_ban_to_geocode.';

-- ───────────────────────────────────────────────────────────────────────────
-- (2) RPC de mesure — DEUX comptages d'un coup pour éviter de scanner
--     `rpps_staging` 2 fois.
--
-- Plan d'exécution :
--   • CTE `staging_eligible` : DISTINCT sur la clé normalisée des éligibles de
--     `<source_table>` (post-enrichment FINESS), prédicat byte-identique aux
--     6 sites garde-foués (`ban-eligibility-predicate-parity`).
--   • `eligible_distinct` = count(*) sur la CTE.
--   • `to_geocode_distinct` = count(*) sur la CTE moins les clés présentes
--     dans `geocoded_addresses` avec accepted=true OU ban_attempt_count>=3
--     (= déjà traitées définitivement : pas la peine de re-soumettre).
--
-- COÛT : le DISTINCT calcule `rpps_address_key_for_index` par ligne éligible
-- (~229k au snapshot post-ban_join, ~250-300k attendu post-FINESS / pre-ban_join).
-- Sans l'index BAN sur staging (volontairement absent — réintroduirait le bug
-- 57014 INSERT/UPDATE-time), c'est un scan + sort. `statement_timeout='55s'`
-- aligné sur le pattern projet (sous cap passerelle PostgREST ~60s, gardé par
-- `enrichment-statement-timeout.test.ts`). Si la mesure déborde, le caller
-- best-effort log NULL + run continue (Phase 1 est observabilité, pas gating).
--
-- ANTI-INJECTION : CASE whitelist EXPLICITE ('rpps_staging' | 'rpps'). Toute
-- autre valeur ⇒ EXCEPTION (jamais une lecture silencieuse à 0 ligne). Pattern
-- aligné sur `rpps_distinct_eligible_keys` (20260517T120000) et
-- `rpps_count_ban_eligible_rows`.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION rpps_measure_ban_to_geocode(
  p_source_table TEXT DEFAULT 'rpps_staging'
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
    WHEN 'rpps_staging' THEN 'rpps_staging'
    WHEN 'rpps'         THEN 'rpps'
    ELSE NULL
  END;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'rpps_measure_ban_to_geocode: invalid source_table %, expected ''rpps_staging'' | ''rpps''',
      p_source_table USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 1 passe planner : `count(*)` total + `count(*) FILTER` anti-jointure
  -- inline sur la CTE (vs 2 sous-SELECT qui auraient pu être matérialisés).
  RETURN QUERY EXECUTE format($q$
    WITH staging_eligible AS (
      SELECT DISTINCT rpps_address_key_for_index(t.adresse, t.code_postal, t.code_insee) AS k
      FROM %I t
      WHERE (t.geom_source = 'commune_centroid' OR (t.geom IS NULL AND t.adresse IS NOT NULL))
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

COMMENT ON FUNCTION rpps_measure_ban_to_geocode(TEXT) IS
  'Phase 1 mesure — retourne EXACTEMENT 1 ligne (eligible_distinct, to_geocode_distinct) pour la table source whitelistée (rpps_staging | rpps). Best-effort côté caller : utilisé par scripts/ingest/rpps.ts pour logger ces 2 chiffres dans ingest_log à chaque cron, dimensionne la future Phase 2 (automatisation re-géocodage récurrent). Prédicat éligibilité byte-identique aux 6 autres sites (ban-eligibility-predicate-parity 7e site). SECURITY DEFINER + REVOKE FROM PUBLIC + GRANT service_role = pattern aligné sur rpps_count_ban_eligible_rows.';

REVOKE EXECUTE ON FUNCTION rpps_measure_ban_to_geocode(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION rpps_measure_ban_to_geocode(TEXT) TO service_role;
