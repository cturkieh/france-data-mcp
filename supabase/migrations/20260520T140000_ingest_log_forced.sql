-- V0.12.2 — Marqueur `forced` distinct dans ingest_log (P1 backlog cleanup).
--
-- Problème (audit) : un run lancé via le levier opérationnel `FORCE_REINGEST=1`
-- (workflow_dispatch GitHub Actions) qui ré-ingère pleinement alors que le
-- CSV upstream est byte-identique au dernier success s'écrivait dans
-- `ingest_log` comme un run cron normal — impossible à distinguer en audit.
-- L'audit ops perdait l'info « ce run a été déclenché manuellement pour
-- ré-appliquer un traitement aval (ex. cache BAN jamais posé) ».
--
-- Fix : ajout d'une colonne booléenne `forced` peuplée par
-- `shortCircuitIfSameChecksum(..., force=true)` (chokepoint unique côté
-- `scripts/ingest/shared.ts`). Default FALSE : un cron normal n'a aucune
-- charge de set le flag (les writes existants restent rétrocompatibles, le
-- champ est optionnel dans `IngestLogEntry`).
--
-- Audit traçable :
--   SELECT id, source, started_at, status FROM ingest_log
--   WHERE forced = TRUE ORDER BY started_at DESC;

ALTER TABLE ingest_log
  ADD COLUMN IF NOT EXISTS forced BOOLEAN NOT NULL DEFAULT FALSE;

-- Index partiel : la grande majorité des runs sont des crons (forced=FALSE),
-- l'ops queryera `WHERE forced=true` qui est une minorité. Index partiel évite
-- de bloater l'index sur le 99 % majoritaire (cohérent avec la philo des
-- index partiels du repo cf. `rpps_geog_precise_gist`).
CREATE INDEX IF NOT EXISTS ingest_log_forced_idx
  ON ingest_log (started_at DESC)
  WHERE forced = TRUE;

NOTIFY pgrst, 'reload schema';
