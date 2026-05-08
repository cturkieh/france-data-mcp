# Ingestion runbook

How the FINESS data flows from the government source into the public MCP server.

## Cadence

| Source | Frequency | Workflow                        | Cron               |
|--------|-----------|---------------------------------|--------------------|
| FINESS | bimonthly | `.github/workflows/ingest-finess.yml` | `0 4 1,15 * *` UTC |
| Annuaire Santé Ameli (PS libéraux) | weekly | `.github/workflows/ingest-ameli.yml` | `0 4 * * 1` UTC (Mondays) |

## Pipeline (5 steps)

1. **Download** — fetch the CSV from data.gouv.fr with retry (3 attempts, exponential backoff).
2. **Pre-validate** — file size ≥ 30 MB and required headers present.
3. **Copy → staging** — stream-parse the CSV, batch-insert into `finess_staging`. The parser reconstructs `code_insee` (5 chars) from `departement + commune`, extracts `code_postal` + real `ville` from `ligneacheminement`, and concatenates `numvoie + typvoie + voie` into a full address line.
4. **Apply geom** — server-side Lambert 93 → WGS84 reproject in batches of 10K rows (PostgREST 60s proxy timeout safe).
5. **Validate** — row count 50K–200K, geocoding coverage ≥ 80%, parsing anomaly rates within tolerance (see thresholds below).
6. **Atomic swap** — single PL/pgSQL transaction renames `finess_staging` → `finess` and keeps the previous version as `finess_previous`.

If any step fails, the production `finess` table is **not** mutated and an issue is auto-opened on the repository.

## Pipeline Ameli (V0.4 phase 1)

Even shape as FINESS, with two key differences:

1. **No GPS coords in the CSV** — geocoding is computed from the **commune centroid** via `geo.api.gouv.fr/communes` (~35 K communes fetched once at run start, ~4 MB JSON). Match by `(coordonnees_code_postal, coordonnees_ville)` with fallback CP-unique guarded against false positives via `byCpRawCount` (the raw count of communes for a CP includes filtered ones, so a hidden ambiguity refuses the fallback). Precision is commune-level (~3 km mean), suitable for density analysis.
2. **No stable identifier** in the public CSV (RPPS / ADELI absent), so the synthetic `BIGSERIAL id` is the PK and idempotence relies on the swap rename, not on `ON CONFLICT`.

Steps :

1. **Download** — `https://www.data.gouv.fr/api/1/datasets/r/432983b9-2e6f-473a-b35a-20403c300a5f` (override via `AMELI_PS_CSV_URL` env when bisecting).
2. **Pre-validate** — file size ≥ 100 MB (CSV ~154 MB), required headers present, delimiter `;`, BOM-aware.
3. **Build commune index** — single `geo.api.gouv` call. Throws if > 1 % communes are unindexable (centre absent, out of FR bbox).
4. **Copy → staging** — stream-parse, geocode each row via the commune index, batch-insert (size 500). Schema-cache miss retry on the first batch (3 attempts, linear backoff) preserves the full Supabase error in `cause` if all retries fail.
5. **Validate** — row count 1 M–2.5 M, structural skip rate < 1 %, unmatched-locality rate < 5 %, denominator > 0 (defense-in-depth against an empty pipeline).
6. **Atomic swap** — same `ingest_atomic_swap` RPC.

## Règle de séparation Ameli ↔ FINESS (V0.4)

Le CSV Annuaire Ameli mélange personnes physiques (médecins, IDE, kinés…) et personnes morales (pharmacies, labos, transporteurs). Pour la cohérence sémantique du serveur MCP :

- **Ameli (`annuaire_ameli` table)** = personnes physiques uniquement (`type_ps_code ∈ {1, 2, 5}`).
- **FINESS (`finess` table)** = établissements / personnes morales (catégories 611 labo, 620 pharmacie, etc.).

À l'ingestion Ameli, les rows avec `type_ps_code ∈ {3, 4}` sont skippées et comptées via `skippedPersonneMorale` (pas une anomalie, c'est le comportement attendu). Volume steady state : ~63 K skipped sur 549 K brut.

Côté MCP, les usages couvrent les deux :
- "médecins/IDE autour" → `professionnels_in_radius` (Ameli)
- "pharmacies/labos autour" → `etablissements_finess_in_radius` famille `pharmacie` / `labo` (FINESS)

## Ameli thresholds (constantes nommées dans `scripts/ingest/ameli.ts`)

| Constant | Default | Behaviour |
|---|---|---|
| `MIN_SIZE_BYTES` | 100 MB | Aborts if downloaded CSV is smaller (truncated transfer) |
| `MIN_ROWS` / `MAX_ROWS` | 400 K / 600 K | Aborts if row count escapes the band. CSV brut = 549 K rows ; après skip des personnes morales (cf. PERSONNE_MORALE_TYPE_PS_CODES), volume attendu = ~485 K. |
| `PERSONNE_MORALE_TYPE_PS_CODES` | `{"3", "4"}` | Codes type_ps Ameli skippés en ingestion (labos, pharmacies, transporteurs). Sémantique Ameli ↔ FINESS : ces structures ont leur place dans FINESS, pas dans l'index Ameli des PS personnes physiques. |
| `STRUCTURAL_FAIL_THRESHOLD` | 0.01 (1 %) | Aborts if `no_identity + no_locality` exceeds — column rename / format change suspect |
| `UNMATCHED_LOCALITY_THRESHOLD` | 0.05 (5 %) | Aborts if `unmatched_locality` exceeds — INSEE commune drift, refresh `geo.api.gouv` index |
| `SAMPLE_CAP` | 200 | Distinct (cp, ville) keys tracked for the unmatched top-N report; once saturated, hits are still counted on known keys but new distinct keys are dropped (logged via `unmatchedDistinctKeysDropped`) |

## Skip reasons (Ameli)

Exhaustive switch with TypeScript `never` check at compile time :

- `no_identity` — both `nom` and `prenom` empty (row unusable).
- `no_locality` — both `coordonnees_code_postal` and `coordonnees_ville` empty.
- `unmatched_locality` — CP+ville not found in the commune index. `sampleKey = "${cp}|${ville}"` collected for the top-N report.

## Failure trace (both ingesters)

The ingester writes an `ingest_log` row before `process.exit(1)`. If `writeIngestLog` itself silently fails (RLS, network, table missing), the top-level catch also dumps the structured log payload on stderr with prefix `[<source>][ingest_log_fallback]` for grep-survival in the GitHub Actions output. The auto-issue script can be enhanced later to embed those lines in the issue body.

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
