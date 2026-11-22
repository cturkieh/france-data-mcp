-- `ingest_drop_stale_previous` ne détruit plus ce qui dépend encore de la copie de secours.
--
-- Le défaut : la fonction faisait `DROP TABLE <prod>_previous CASCADE`. Une matview suit sa
-- table par OID. Après une bascule, tant que les matviews ne sont pas reconstruites, elles
-- restent donc liées à l'ANCIENNE table, devenue `<prod>_previous`. Si le run s'arrête entre
-- la bascule et la reconstruction (run RPPS du 2026-09-05 : bascule à 59:59, tué 5 s après)
-- ou si la reconstruction échoue (run `partial`), le nettoyage suivant emportait ces matviews
-- avec la copie : `rpps_in_radius`, `rpps_search_by_name` et les tools qui les lisent
-- auraient répondu 42P01 jusqu'à une reconstruction manuelle (déduit du code et rejoué sur
-- une base jetable, pas observé en prod).
--
-- Le correctif : `DROP TABLE` sans `CASCADE`. Ce que la table possède part toujours avec elle
-- (index, contraintes, policies RLS, séquence de son `id`, valeurs par défaut). Un objet
-- EXTERNE qui en dépend encore (matview, vue) fait échouer le DROP en 2BP01 : rien n'est
-- supprimé, la RPC rend l'erreur, la CLI sort en rouge et le workflow alerte. Réparer alors
-- par la reconstruction de la source (`ingest_rebuild_rpps_matviews`,
-- `ingest_rebuild_rpps_search_lists`, `ingest_rebuild_ameli_matviews`,
-- `ingest_rebuild_finess_hosted_activities`) ; le nettoyage du lendemain passe seul.
-- Vaut aussi pour la VUE `iris_full`, qui suit ses tables par OID comme une matview : après
-- une bascule IRIS elle reste liée à `iris*_previous` et doit être recréée (backlog P1).
--
-- Seule cette ligne change. Signature, valeur de retour, gardes d'entrée, calcul d'âge,
-- `SECURITY DEFINER` et `search_path` sont ceux de `20260514T080000`, recopiés parce que
-- `CREATE OR REPLACE` remplace toute la définition. Le défaut `p_max_age_days = 7` reste : le
-- code passe toujours le seuil explicitement (`DROP_STALE_PREVIOUS_DEFAULT_DAYS`).
--
-- Rejoué sur une base jetable avant écriture (défaut reproduit, puis correctif) :
-- `docs/experiences/2026-11-22-nettoyage-sans-cascade.md`.

CREATE OR REPLACE FUNCTION ingest_drop_stale_previous(
  p_prod_table TEXT,
  p_source TEXT,
  p_max_age_days INT DEFAULT 7
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_previous_table TEXT := p_prod_table || '_previous';
  v_last_success   TIMESTAMPTZ;
  v_age_days       INT;
BEGIN
  -- Defense-in-depth : noms de tables et sources contrôlés par le caller
  -- TS-side mais ré-validés ici (SECURITY DEFINER + EXECUTE format → toute
  -- injection serait amplifiée en bypass RLS service_role).
  IF p_prod_table !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid prod_table name %', p_prod_table;
  END IF;
  IF p_source !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid source name %', p_source;
  END IF;
  IF p_max_age_days < 1 OR p_max_age_days > 365 THEN
    RAISE EXCEPTION 'max_age_days must be in [1, 365], got %', p_max_age_days;
  END IF;

  IF to_regclass(v_previous_table) IS NULL THEN
    RETURN format('absent:%s', v_previous_table);
  END IF;

  SELECT MAX(started_at) INTO v_last_success
    FROM ingest_log
    WHERE source = p_source
      AND status = 'success';

  IF v_last_success IS NULL THEN
    -- Aucun historique mais la table previous existe → cas atypique (ingestion
    -- manuelle sans logging). On ne drop PAS sans contexte d'âge.
    RETURN format('no_history:%s', v_previous_table);
  END IF;

  -- `(date - date)` retourne directement le nombre de jours calendaires écoulés.
  v_age_days := (NOW()::date - v_last_success::date);

  IF v_age_days < p_max_age_days THEN
    RETURN format('kept:%s:%sd', v_previous_table, v_age_days);
  END IF;

  -- PAS de CASCADE : un objet externe encore lié fait échouer en 2BP01 (cf. en-tête).
  EXECUTE format('DROP TABLE IF EXISTS %I', v_previous_table);
  RETURN format('dropped:%s:%sd', v_previous_table, v_age_days);
END;
$$;

-- `CREATE OR REPLACE` garde les droits existants ; redits ici pour qu'une base neuve
-- n'ouvre pas la fonction à la clé publique (`pg_default_acl` de Supabase).
REVOKE EXECUTE ON FUNCTION ingest_drop_stale_previous(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION ingest_drop_stale_previous(text, text, integer) TO service_role;

COMMENT ON FUNCTION ingest_drop_stale_previous IS
  'DROP `<prod>_previous` (sans CASCADE) si le dernier ingest_log success de la source a au moins max_age_days jours. Un objet externe encore lié (matview non reconstruite) fait échouer en 2BP01 sans rien supprimer. Retourne "dropped:..." / "kept:..." / "absent:..." / "no_history:...".';
