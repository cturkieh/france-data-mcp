# Ingestion runbook

How the FINESS data flows from the government source into the public MCP server.

## Cadence

| Source | Frequency | Workflow                        | Cron               |
|--------|-----------|---------------------------------|--------------------|
| FINESS | bimonthly | `.github/workflows/ingest-finess.yml` | `0 4 1,15 * *` UTC |

## Pipeline (5 steps)

1. **Download** — fetch the CSV from data.gouv.fr with retry (3 attempts, exponential backoff).
2. **Pre-validate** — file size ≥ 30 MB and required headers present.
3. **Copy → staging** — stream-parse the CSV, batch-insert into `finess_staging`.
4. **Validate** — row count between 50K and 200K (catches truncated parses and format changes).
5. **Atomic swap** — single PL/pgSQL transaction renames `finess_staging` → `finess` and keeps the previous version as `finess_previous`.

If any step fails, the production `finess` table is **not** mutated and an issue is auto-opened on the repository.

## Manual trigger

GitHub → Actions → "Ingest FINESS" → "Run workflow".

## Troubleshooting

Check the latest entry in `ingest_log`:

```sql
SELECT source, status, error_phase, error_message, row_count, finished_at
FROM ingest_log
WHERE source = 'finess'
ORDER BY started_at DESC
LIMIT 5;
```

| `error_phase`  | Likely cause                                      | Fix                                                               |
|----------------|---------------------------------------------------|-------------------------------------------------------------------|
| `download`     | data.gouv.fr 404/5xx, network timeout              | Re-run the workflow; if persists, check FINESS URL is unchanged.   |
| `pre_validate` | File truncated or schema changed                   | Compare current CSV headers to `FINESS_HEADERS` in the script.     |
| `copy`         | RLS or schema mismatch                             | Check Supabase schema migrations are in sync.                      |
| `validate`     | Row count out of bounds                            | Investigate the file; adjust thresholds in `MIN_ROWS`/`MAX_ROWS` only after manual confirmation. |
| `swap`         | Concurrency race or permission                     | Retry; check that only one ingestion runs at a time (`concurrency` in workflow). |

## Rollback

The previous version is preserved as `finess_previous`. Manual rollback (cloud SQL editor):

```sql
BEGIN;
ALTER TABLE finess RENAME TO finess_failed;
ALTER TABLE finess_previous RENAME TO finess;
ALTER TABLE finess_failed RENAME TO finess_previous;
COMMIT;
```
