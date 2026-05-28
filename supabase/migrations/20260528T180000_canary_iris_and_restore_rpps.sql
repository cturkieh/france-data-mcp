-- Phase B étape 1 — canary IRIS + RESTAURATION canary RPPS (régression prouvée prod).
--
-- DÉCOUVERTE (vérif prod `pg_get_functiondef` 2026-05-28) : la def courante de
-- `check_ingest_canary` ne contient QUE finess/ameli_ps/cds — la branche `rpps`
-- (ajoutée par 20260509T200500) a été SILENCIEUSEMENT écrasée par le
-- CREATE OR REPLACE de 20260515T010200 (extension cds), qui ne l'a pas recopiée.
-- Conséquence : depuis ~2026-05-15 chaque cron RPPS appelle un canary qui lève
-- `unknown source rpps` → `runAndRecordCanary` logge `__rpc_error__` (non-bloquant,
-- swap déjà committé) → canary RPPS MORT en silence. Leçon CLAUDE.md : un
-- CREATE OR REPLACE doit recopier TOUTES les branches (pas d'héritage de corps).
--
-- Ce fichier recompose la def COMPLÈTE (finess, ameli_ps, cds, rpps RESTAURÉE,
-- iris NOUVELLE) — source unique recopiée verbatim + 2 ajouts.
--
-- CIBLES RPPS = placeholders jamais réels (vérifié : 0/3 présentes dans `rpps`).
-- On les SUPPRIME → branche rpps inactive proprement (retourne `[]`, comme
-- ameli_ps) au lieu d'un cry-wolf 100% missing à chaque cron mensuel. Dette :
-- seeder 2-3 IDNPS référents stables (annuaire.sante.fr) — docs/backlog.md.
--
-- CIBLES IRIS = 3 codes RÉELS vérifiés présents post-1re ingestion (pas de
-- placeholder → pas de cry-wolf) : commune rurale, IRIS urbain Paris, Corse.

CREATE OR REPLACE FUNCTION check_ingest_canary(p_source TEXT) RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  missing TEXT[];
BEGIN
  IF p_source = 'finess' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN finess f
      ON t.key_type = 'num_finess'
     AND f.num_finess = t.key_value
    WHERE t.source = 'finess'
      AND t.key_type = 'num_finess'
      AND f.num_finess IS NULL;

  ELSIF p_source = 'ameli_ps' THEN
    -- Canary Ameli inactif (aucune cible seedée) → `[]`.
    missing := NULL;

  ELSIF p_source = 'cds' THEN
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN centres_sante c
      ON t.key_type = 'etab_finess'
     AND c.etab_finess = t.key_value
    WHERE t.source = 'cds'
      AND t.key_type = 'etab_finess'
      AND c.etab_finess IS NULL;

  ELSIF p_source = 'rpps' THEN
    -- RESTAURÉE 2026-05-28 (cf. en-tête). Pivot key_type 'rpps_id' (IDNPS 11 car.).
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN rpps r
      ON t.key_type = 'rpps_id'
     AND r.rpps_id = t.key_value
    WHERE t.source = 'rpps'
      AND t.key_type = 'rpps_id'
      AND r.rpps_id IS NULL;

  ELSIF p_source = 'iris' THEN
    -- Phase B : pivot key_type 'code_iris' (CHAR(9), PK de `iris`).
    SELECT array_agg(t.key_value)
    INTO missing
    FROM ingest_canary_targets t
    LEFT JOIN iris i
      ON t.key_type = 'code_iris'
     AND i.code_iris = t.key_value
    WHERE t.source = 'iris'
      AND t.key_type = 'code_iris'
      AND i.code_iris IS NULL;

  ELSE
    RAISE EXCEPTION 'check_ingest_canary: unknown source %', p_source
      USING ERRCODE = '22023'; -- invalid_parameter_value
  END IF;

  RETURN COALESCE(missing, ARRAY[]::TEXT[]);
END;
$$;

GRANT EXECUTE ON FUNCTION check_ingest_canary(TEXT) TO anon, authenticated, service_role;

-- Purge des placeholders RPPS jamais réels (anti cry-wolf — cf. en-tête).
DELETE FROM ingest_canary_targets WHERE source = 'rpps' AND key_type = 'rpps_id';

-- Seed IRIS — 3 codes réels vérifiés présents (commune rurale / IRIS urbain / Corse).
INSERT INTO ingest_canary_targets (source, key_type, key_value, description) VALUES
  ('iris', 'code_iris', '010010000', 'L''Abergement-Clémenciat (01) — commune rurale non-irisée (TYP_IRIS Z)'),
  ('iris', 'code_iris', '751103701', 'Saint-Vincent de Paul 1, Paris 10e — IRIS urbain (TYP_IRIS H)'),
  ('iris', 'code_iris', '2A0010000', 'Afa (2A) — couverture Corse')
ON CONFLICT (source, key_type, key_value) DO NOTHING;

NOTIFY pgrst, 'reload schema';
