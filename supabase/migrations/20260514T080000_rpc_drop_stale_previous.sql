-- V0.9.3 — DROP différé `<prod>_previous` quand l'ingestion a stagné > 7j.
--
-- Contexte : `ingest_atomic_swap` conserve UNE génération de rollback nommée
-- `<prod>_previous`. Tant qu'un nouveau swap n'a pas lieu, cette table reste
-- en place (utile pour rollback rapide post-swap). Mais si l'ingestion stagne
-- (cron en panne, source upstream cassée, checksum identique répété), le
-- previous devient obsolète comme point de rollback ET occupe inutilement du
-- disk (RPPS_previous = ~700 MB, FINESS ~80 MB, Ameli ~150 MB).
--
-- Cette fonction permet d'auditer l'âge et drop si > seuil. Appelée
-- manuellement ou via job de maintenance (pas par le flow d'ingestion lui-même,
-- qui overwrite previous au swap suivant de toute façon).
--
-- Source de vérité de l'âge : `MAX(started_at)` sur les `ingest_log` success
-- de la source. Représente le moment où le swap a déplacé l'ancienne prod
-- vers `<prod>_previous`. Si `NOW() - cette date > p_max_age_days` → previous
-- est plus vieux que le seuil de tolérance → DROP.
--
-- Retour : tableau de TEXT (audit trail). Format :
--   - "dropped:<table>:<age_days>d" si DROP effectué
--   - "kept:<table>:<age_days>d" si dans le seuil (no-op)
--   - "absent:<table>" si la table n'existe pas (rien à drop)
--   - "no_history:<table>" si aucun ingest_log success (premier déploiement)
--
-- Idempotent : appelable plusieurs fois sans effet de bord cumulatif.

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

  -- `(date - date)` retourne directement le nombre de jours calendaires
  -- écoulés (int, pas interval). Plus simple et plus rapide que
  -- `EXTRACT(DAY FROM ...)` qui retourne le champ "day" de l'interval,
  -- pas le total — fragile si Postgres normalise l'interval ('1 month'
  -- vs '30 days').
  v_age_days := (NOW()::date - v_last_success::date);

  IF v_age_days < p_max_age_days THEN
    RETURN format('kept:%s:%sd', v_previous_table, v_age_days);
  END IF;

  EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', v_previous_table);
  RETURN format('dropped:%s:%sd', v_previous_table, v_age_days);
END;
$$;

REVOKE EXECUTE ON FUNCTION ingest_drop_stale_previous FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ingest_drop_stale_previous TO service_role;

COMMENT ON FUNCTION ingest_drop_stale_previous IS
  'V0.9.3 — DROP `<prod>_previous` si NOW() - MAX(ingest_log.started_at WHERE success) > max_age_days. Économie disk quand l''ingestion stagne. Idempotent. Retourne TEXT audit ("dropped:..." / "kept:..." / "absent:..." / "no_history:...").';
