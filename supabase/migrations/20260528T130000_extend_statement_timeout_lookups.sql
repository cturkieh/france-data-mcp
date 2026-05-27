-- 2026-05-28 — Extend statement_timeout to 15s on 8 lookup RPCs that inherit
-- the default 8s authenticator timeout. Goal: eliminate cold-start 57014
-- timeouts observed on these RPCs over the past 14 days (21 Sentry events
-- baseline before this migration, target 0 after).
--
-- Why 15s : 2x the authenticator default (8s), gives ~3-5s margin above
-- the measured cold-start P99 (~5s in prod). Stays short enough to fail
-- fast on truly pathological queries (vs a 30s generous default).
--
-- ALTER FUNCTION ... SET is idempotent and only touches the function config,
-- never the body. Zero risk of silently reverting post-swap matview OID
-- bombs or partial GiST index decoupling (cf. CLAUDE.md gotchas) — those
-- only apply to full CREATE OR REPLACE rewrites.
--
-- NOT touched (intentional tuning kept tight to fail-fast on bad queries;
-- the keep-warm cron `.github/workflows/keep-warm.yml` protects them anyway
-- by maintaining hot Postgres buffers + warm Vercel lambda):
--   - count_rpps             statement_timeout=2s   (5 events / 14d)
--   - count_rpps_by_commune  statement_timeout=5s   (1 event  / 14d)
--   - rpps_search_by_name    statement_timeout=10s  (1 event  / 14d)
--
-- Discipline cardinale prouvée par la prod (cf. mémoire prove-rootcause-by-prod) :
--   1. pg_roles.rolconfig confirmé : authenticator=8s + lock_timeout=8s,
--      anon=3s, service_role=NULL (mais hérite via SET ROLE).
--   2. pg_stat_user_tables : finess.last_autoanalyze=2026-05-15 (12 jours
--      sans refresh stats avant le test live), buffers froids attendus.
--   3. ingest_log : aucun cron actif dans les 6h précédant les timeouts
--      (dernier = CDS 2026-05-25 10:03 UTC), hypothèse embouteillage écartée.
--   4. pg_proc.proconfig : 8 fonctions sans SET statement_timeout, héritaient
--      donc du 8s authenticator. PK lookup atteignant 8s = signal cold-start
--      pool/buffers, jamais une exécution longue.

ALTER FUNCTION public.finess_by_num_finess(text)
  SET statement_timeout = '15s';

ALTER FUNCTION public.finess_by_categorie(text[], text, text, integer)
  SET statement_timeout = '15s';

ALTER FUNCTION public.ameli_by_specialite_dept(text, text, text, integer, integer)
  SET statement_timeout = '15s';

ALTER FUNCTION public.ameli_in_radius(double precision, double precision, double precision, text[], text[], integer, boolean)
  SET statement_timeout = '15s';

ALTER FUNCTION public.ameli_lister_specialites()
  SET statement_timeout = '15s';

ALTER FUNCTION public.centres_sante_by_finess(character)
  SET statement_timeout = '15s';

ALTER FUNCTION public.lister_savoir_faire_rpps(text)
  SET statement_timeout = '15s';

ALTER FUNCTION public.rpps_in_radius(double precision, double precision, double precision, text[], text[], text[], text[], integer, boolean)
  SET statement_timeout = '15s';

NOTIFY pgrst, 'reload schema';
