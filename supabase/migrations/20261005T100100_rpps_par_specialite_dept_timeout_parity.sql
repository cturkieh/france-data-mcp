-- Fix FRANCE-DATA-MCP-Q — `professionnels_rpps_par_dept` → RPC
-- `rpps_par_specialite_dept` coupée en 57014 (statement_timeout) à froid.
--
-- CAUSE RACINE (prouvée prod, catalogue + EXPLAIN ANALYZE, 2026-10-05) :
--   `pg_proc.proconfig` = NULL pour `rpps_par_specialite_dept` : ni
--   `search_path` ni `statement_timeout`. La fonction hérite donc du budget du
--   rôle `anon` = 3 s. Le plan est sain (Index Scan `rpps_dept_insee_sort_idx`,
--   ~229 ms à chaud) ; c'est le plafond 3 s qui coupe à froid / sous contention.
--
-- HISTORIQUE DE LA PERTE (deux fois) :
--   - 20260510T000000 posait `SET search_path` + `ALTER FUNCTION … SET
--     statement_timeout = '15s'`.
--   - 20260510T010000 a fait `RESET statement_timeout` : justifié à l'époque
--     car la fonction passait en `LANGUAGE sql` et une clause SET bloque
--     l'inlining d'une SRF SQL.
--   - 20260510T030000 est revenue en `LANGUAGE plpgsql` (EXECUTE format, plus
--     d'inlining possible) SANS reposer les SET → justification du RESET
--     caduque, budget 3 s anon hérité.
--   - 20260520T120000 (geo_precision) a re-DROP + CREATE la fonction, toujours
--     sans SET (un DROP efface tout ALTER antérieur).
--
-- FIX : reposer les deux SET par ALTER FUNCTION (corps inchangé, aucun risque
-- de drift de logique). Parité `rpps_in_radius` : `search_path = public,
-- extensions` + `statement_timeout = '15s'` (< 60 s passerelle PostgREST).
-- Garde-fou anti-récidive : `scripts/ingest/lookup-statement-timeout.test.ts`
-- (une future re-création DROP + CREATE sans SET repasse le test au rouge).
--
-- VÉRIFICATION POST-APPLY :
--   SELECT proconfig FROM pg_proc WHERE proname = 'rpps_par_specialite_dept';
--   -- attendu : {"search_path=public, extensions",statement_timeout=15s}

ALTER FUNCTION rpps_par_specialite_dept(TEXT, TEXT, TEXT, TEXT, TEXT[], INT, INT)
  SET search_path = public, extensions;

ALTER FUNCTION rpps_par_specialite_dept(TEXT, TEXT, TEXT, TEXT, TEXT[], INT, INT)
  SET statement_timeout = '15s';

-- Recharge le cache de schéma PostgREST (signature/retour de RPC modifiés).
NOTIFY pgrst, 'reload schema';
