# Ingestion runbook

How the FINESS data flows from the government source into the public MCP server.

## Cadence

| Source | Frequency | Workflow                        | Cron               |
|--------|-----------|---------------------------------|--------------------|
| FINESS | bimonthly | `.github/workflows/ingest-finess.yml` | `0 4 1,15 * *` UTC |

## Pipeline (5 steps)

1. **Download** — fetch the CSV from data.gouv.fr with retry (3 attempts, exponential backoff).
2. **Pre-validate** — file size ≥ 30 MB and required headers present.
3. **Copy → staging** — stream-parse the CSV, batch-insert into `finess_staging`. The parser reconstructs `code_insee` (5 chars) from `departement + commune`, extracts `code_postal` + real `ville` from `ligneacheminement`, and concatenates `numvoie + typvoie + voie` into a full address line.
4. **Apply geom** — server-side Lambert 93 → WGS84 reproject in batches of 10K rows (PostgREST 60s proxy timeout safe).
5. **Validate** — row count 50K–200K, geocoding coverage ≥ 80%, parsing anomaly rates within tolerance (see thresholds below).
6. **Atomic swap** — single PL/pgSQL transaction renames `finess_staging` → `finess` and keeps the previous version as `finess_previous`.

If any step fails, the production `finess` table is **not** mutated and an issue is auto-opened on the repository.

## Thresholds (constantes nommées dans `scripts/ingest/finess.ts`)

| Constant | Default | Behaviour |
|---|---|---|
| `STRUCTURAL_FAIL_THRESHOLD` | 0.01 (1%) | Aborts if `no_finess_id + no_commune + ligneAch_no_match` exceeds — DREES schema regression suspect |
| `BAD_DEPT_NOISE_THRESHOLD`  | 0.05 (5%) | Aborts if `bad_dept` exceeds (steady state ~2.5% baseline due to `csv-parse` un-quoted comma column shifts; >5% indicates a real layout shift) |
| `AUTRE_FAMILY_DRIFT_THRESHOLD` | 0.15 (15%) | **Warns** (not blocks) if the share of categorie_codes falling into family `autre` overshoots — DREES nomenclature drift suspect, consider extending FINESS_CATEGORIES |
| `MIN_GEOM_COVERAGE` | 0.8 (80%) | Aborts if fewer than 80% of inserted rows have a valid Lambert→WGS84 reprojection |
| `MIN_ROWS` / `MAX_ROWS` | 50K / 200K | Aborts if the row count escapes the band (truncated parse or format change) |

## Skip reasons tracked at parse time

| Reason | Counted in `IngestStreamStats` | Blocking? |
|---|---|---|
| `no_finess_id` | `skippedNoFinessId` | yes (structural) |
| `no_commune` | `skippedNoCommune` | yes (structural) |
| `bad_dept` | `skippedBadDept` | yes if > 5% (CSV column shift baseline) |
| `dom_unsupported` | `skippedDom` | no (architectural limit, V0.4 widens `code_insee`) |
| ligneacheminement non-match | `parsedNoLigneAch` | yes (counted in structural rate) |
| `unknownCategorieCount` | `unknownCategorieCounts` Map | warn-only if > 15% (drift signal) |

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
