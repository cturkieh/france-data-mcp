-- 2026-08-04 — Étend statement_timeout 5s → 15s sur `count_rpps_by_commune`,
-- la DERNIÈRE RPC lookup encore au tuning serré post-20260528. Fixes
-- FRANCE-DATA-MCP-M (2 events 2026-07-30 15:40:54, burst d'un même appel
-- `panorama_sante_territoire` : 2 des 3 counts parallèles — médecins /
-- infirmiers / pharmaciens — en 57014 simultané) + même classe que
-- FRANCE-DATA-MCP-K (1 event 2026-07-16, ignoré).
--
-- Pourquoi revenir sur la décision 20260528 (« kept tight to fail-fast ») :
-- sa prémisse « the keep-warm cron protects them anyway » est RÉFUTÉE par la
-- prod. (1) Cadence réelle du keep-warm : schedule `*/10 * * * *` mais runs
-- observés espacés de 1-2 h (throttling GitHub sur les workflows schedulés,
-- historique Actions 2026-07-30 : 15:04 → 16:43) — l'event 15:40:54 tombe
-- DANS le trou. (2) Le ping `densite_sante` du keep-warm ne chauffe que les
-- pages index/heap de la commune 59009 — les buffers de toute AUTRE commune
-- restent froids. (3) Bilan 19 jours : les 8 RPC passées à 15s = 0 event ;
-- `count_rpps_by_commune` restée à 5s = 3 events. Le pattern 20260528 a fait
-- ses preuves (baseline 21 events/14d → 0), on l'applique.
--
-- Impact amplifié : `panorama_sante_territoire` est fail-fast BY DESIGN
-- (panorama.ts — pas de fallback partiel, cf. lessons V0.8.1) → un seul
-- 57014 sur un count de 500 ms typique tue toute la réponse composite.
--
-- Pourquoi 15s (aligné 20260528) : 2× le défaut authenticator (8s), marge
-- au-dessus du P99 cold-start mesuré (~5s), très en dessous du cap
-- passerelle PostgREST 60s → un vrai pathologique fail vite et proprement.
--
-- ALTER FUNCTION ... SET est idempotent et ne touche QUE la config, jamais
-- le corps (zéro risque bombe OID / GiST partiel — réservés aux CREATE OR
-- REPLACE complets). ⚠️ Corollaire pour les mainteneurs : tout FUTUR
-- `CREATE OR REPLACE` de `count_rpps_by_commune` doit porter
-- `SET statement_timeout = '15s'` inline (la def V0.9 20260514T070000 dit
-- encore '5s' — la recopier verbatim reverterait silencieusement ce fix).

ALTER FUNCTION public.count_rpps_by_commune(text, text, text, text[], text[])
  SET statement_timeout = '15s';

NOTIFY pgrst, 'reload schema';
