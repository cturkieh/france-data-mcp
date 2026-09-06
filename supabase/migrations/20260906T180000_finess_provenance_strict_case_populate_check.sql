-- Suite de 20260906T160000/T170000 (revue silent-failure du même jour).
--
-- (1) `ingest_apply_finess_geom_previous` : le CASE de propagation n'a plus de
--     ELSE. `ban_address` hérité reste `ban_address`, `ans`/`previous_ingest`
--     hérités deviennent `previous_ingest`, et TOUTE autre valeur (un 4e
--     libellé ajouté demain au CHECK sans mise à jour de ce repli) donne NULL
--     sur un point → viole `finess_geom_source_iff_geom` → le cron échoue
--     LOUD au lieu de dégrader la provenance en silence. Corps recopié
--     VERBATIM de 20260906T160000 à cette clause près.
-- (2) Vérification REJOUABLE du peuplement one-shot de 20260906T160000 : la
--     preuve (91 542 SIRET, 78 429 clés/scores, 0 point sans provenance) avait
--     été faite à la main à l'apply ; sur une autre base (branche, restauration)
--     un `raw` dérivé peuplerait partiellement, en `success`. Le bloc échoue
--     si une valeur de `raw` bien formée n'est pas en colonne. Parité des
--     regex : `siret` = SIRET_PATTERN (testée), `score_ban` = décimal positif
--     (le parseur TS accepte aussi un signe ; un score BAN n'est jamais négatif).
--
-- Migration T-format : PROD-ONLY, appliquée via MCP Supabase `apply_migration`.

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
         -- Pas de ELSE : une provenance inconnue → NULL → contrainte violée → échec LOUD.
         geom_source      = CASE WHEN f.geom_source = 'ban_address' THEN 'ban_address'
                                 WHEN f.geom_source IN ('ans', 'previous_ingest') THEN 'previous_ingest'
                            END
    FROM finess f
   WHERE f.num_finess = s.num_finess
     AND s.geom IS NULL
     AND f.geom IS NOT NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ingest_apply_finess_geom_previous() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.ingest_apply_finess_geom_previous() TO service_role;

DO $$
DECLARE
  v_raw_siret INT; v_col_siret INT;
  v_raw_score INT; v_col_score INT;
  v_raw_cle   INT; v_col_cle   INT;
  v_pt_sans_prov INT;
BEGIN
  SELECT count(*) FILTER (WHERE raw->>'siret' ~ '^\d{14}$'),
         count(*) FILTER (WHERE siret IS NOT NULL),
         count(*) FILTER (WHERE raw->>'score_ban' ~ '^[0-9]+(\.[0-9]+)?$'),
         count(*) FILTER (WHERE score_ban IS NOT NULL),
         count(*) FILTER (WHERE raw->>'cle_ban' IS NOT NULL),
         count(*) FILTER (WHERE cle_ban IS NOT NULL),
         count(*) FILTER (WHERE geom IS NOT NULL AND geom_source IS NULL)
    INTO v_raw_siret, v_col_siret, v_raw_score, v_col_score, v_raw_cle, v_col_cle, v_pt_sans_prov
    FROM finess;
  -- `>=` et non `=` : après le prochain cron, `raw` est vide et les colonnes
  -- pleines — la vérification reste vraie ; seul un peuplement PARTIEL échoue.
  IF v_col_siret < v_raw_siret OR v_col_score < v_raw_score OR v_col_cle < v_raw_cle OR v_pt_sans_prov > 0 THEN
    RAISE EXCEPTION 'peuplement finess incomplet — siret raw %/col %, score_ban raw %/col %, cle_ban raw %/col %, points sans provenance %',
      v_raw_siret, v_col_siret, v_raw_score, v_col_score, v_raw_cle, v_col_cle, v_pt_sans_prov;
  END IF;
  RAISE NOTICE 'peuplement finess vérifié : siret %, score_ban %, cle_ban %, 0 point sans provenance', v_col_siret, v_col_score, v_col_cle;
END $$;
