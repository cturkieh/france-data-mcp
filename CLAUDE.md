# CLAUDE.md — france-data-mcp

> Conventions + workflow + release, **en règles de tête** (budget ~1 000 mots). Le détail — post-mortems chiffrés, patrons SQL, checklists — vit dans les skills du projet, chargés à la demande : `mcp-conventions`, `ingestion-crons`, `db-gotchas`, `release-process` (`.claude/skills/`). Voir `README.md` pour l'usage MCP, `CHANGELOG.md` pour l'historique.

> **Override CLAUDE.md global — Déploiement** : Merge sur `main` et deploy production = **manuel**, validation Cyril requise. Le défaut universel « Claude merge+deploy auto quand tout est vert » ne s'applique PAS ici. Justification : données santé prod (FINESS / RPPS / Ameli), HDS, audit trail ; les régressions silencieuses prouvées prod (matview OID, GiST partiel découplé, ban_join keyset) avaient toutes des tests verts au commit. Claude prépare la PR, Cyril valide et merge.

## Stack

TypeScript strict + Vercel serverless (`api/`) + Supabase PostGIS + pnpm + tsup + vitest + biome.
Lib (`src/`, publiée npm) ≠ Endpoint (`api/`, hosté Vercel) — conventions distinctes (skill `mcp-conventions`).

## Workflow

```bash
pnpm test:unit                            # rapide, sans DB
pnpm typecheck && pnpm lint               # avant tout commit
pnpm test                                 # complet, nécessite `pnpm db:start`
pnpm release                              # release semi-auto (voir scripts/release.sh)
```

CI GitHub Actions vérifie typecheck (2 tsconfigs) + biome + tests + Supabase local.

**`test`/`test:integration` portent `--no-file-parallelism`** : plusieurs fichiers `*.integration.test.ts` partagent la table mutable `rpps_staging` (recréée par `ingest_create_rpps_staging()`) — l'exécution parallèle des fichiers les clobbe mutuellement. `test:unit` exclut les intégration → reste parallèle. Tout nouveau test d'intégration touchant `rpps_staging` DOIT re-seed en tête de chaque `it` + ré-asserter le peuplement (pattern `ban-eligibility-skipscan.integration`).

## Conventions code — règles de tête (détail : skill `mcp-conventions`)

**Lib (`src/`)** — OSS publiable, pas de Sentry direct. Catch jamais silencieux (`console.error`/`warn` préfixé `[france-data-mcp]`). `RangeError` pour input invalide au boundary (→ JSON-RPC `-32602`). `LookupResult<T>` discriminé « pas trouvé » ≠ « erreur ». `_resetXForTesting()` pour tout état partagé. Lookup PK ≤ 1 row → `expectSingleRow`. Clé de dédup d'identité = attributs de PERSONNE, jamais de site. Primitives génériques → `core/`, jamais `sante/`. `reverseGeocode` (adresse) ≠ `communeContainingPoint` (frontières, n'exploiter QUE `length === 1`). Resolver SIRET : l'établissement ACTIF co-localisé (100 m, bande 30 m) prime sur le score d'adresse — ne pas recalibrer sans relire la preuve prod.

**Endpoint (`api/`)** — Sentry (`captureMcpError`, fingerprint stable) + logs JSON 1 ligne/req, rate limit 60/min/IP, IP = dernier segment XFF. JSON malformé → `-32700` classé au site `req.body` (le runtime Vercel throw un `Error` nu, pas un `SyntaxError`). Tout tool de comptage expose `perimetre` (`withPerimetre`, après `await withFreshness`) ; tout tool FINESS filtré par famille expose `activite_hebergee` (juxtaposé, jamais additionné). Tout scope commune passe par `applyCommuneResolver` (`departement` = hint, jamais scope de calcul).

**Boundary (`api/_lib/args.ts`)** — validators `requireXxxId` à 3 branches via `requireIdPattern` ; regex partagés lib ↔ boundary exportés depuis `src/sante/db-helpers.ts`.

## Ingestion — règles de tête (détail : skill `ingestion-crons`)

3 sources : **FINESS (flux ANS JSON.gz quotidien depuis 2026-09-05, cron le 1er et le 15, ~105 K)**, Ameli (hebdo, ~466 K), RPPS (mensuel, ~2,28 M). Pattern : download → SHA256 short-circuit → COPY staging → validate → atomic swap → canary → ingest_log. RPC récente → `getUntypedServiceClient`. Migrations prod via **MCP Supabase `apply_migration`** (le CLI `db push` est cassé, format `T`). Tout champ optionnel ajouté à `IngestLogEntry` va dans `PGRST204_RECOVERABLE_FIELDS`. Le CSV DREES est mort le 2026-07-20 : quatre mois de `same_checksum` en `success` sans signal → `data_freshness` expose `data_age_days` (âge réel) et un canary manquant marque le run `partial`. Pièges du flux ANS (adresse `usageAdresse "03"`, paires WGS84/Lambert inversées, clé BAN commune = centroïde refusé) : `docs/plans/finess-migration-ans.md` + `finess-ans-parse.test.ts`.

## Gotchas DB — index (détail et preuves : skill `db-gotchas`)

- PostgREST sérialise `NUMERIC`/`BIGINT` en **string** → coercer au boundary (`Number` + `isFinite`, `numOrNull`) ; tester avec des strings.
- `ST_AsGeoJSON(geom)::jsonb` en sortie RPC ; `geog GEOGRAPHY STORED` + GIST ; proxy PostgREST 60 s ≠ `statement_timeout`.
- Colonne `CHAR(n)` filtrée par param `TEXT` → `EXECUTE format(%L::CHAR(n))`, jamais `WHERE col = p_text`.
- Matview `FROM` table swappée → **RECONSTRUIRE** post-swap (OID), jamais REFRESH-only.
- Parité index prod ↔ `ingest_create_*_staging` (recopie VERBATIM, `staging-parity.test.ts`) ; GiST spatial rpps PARTIEL-à-PARTIEL.
- RPC d'ingestion longue → `SET statement_timeout` fonction (< 60 s) + `ANALYZE` post-COPY ; jamais de `CREATE INDEX` lourd via PostgREST.
- `ban_join` = curseur keyset, jamais sentinelle ; acceptation BAN par **précision** (`result_type`), jamais par score.
- Valider une nomenclature contre la matview NON filtrée source du count.
- Coords centroïde + rayon = O(lignes/commune) → matview de centroïdes ; `ORDER BY geog <-> point` (KNN), jamais `ST_Distance`.
- Cache paresseux serve-time → RLS `anon lit / service_role écrit` ; upsert CSV à PK composite → dédup AVANT `ON CONFLICT`.
- Un garde mesuré après l'étape qui remplit son propre ensemble est une tautologie (`lost_geom`) ; la non-régression géo = taux de points déplacés.

## Release (checklist complète : skill `release-process`)

Maintainer-only. `typecheck && lint && test:unit` verts → bump **3 sources** (`package.json`, `server.json` ×2 — description ≤ 100 caractères —, `src/core/version.ts`) → section CHANGELOG → commit + tag `vX.Y.Z` + push → CI verte → `pnpm publish` (OTP) → `mcp-publisher publish` → Release GitHub auto sur le tag (ne PAS `gh release create`) → vérifier `npm view`, `/healthz`, registry MCP **en paginant** (`metadata.nextCursor`) → Glama : Sync → build → « Create a release » (manuel).

## Contribuer

PR bienvenues. Convention commit : `<type>(<scope>): <résumé>` où type ∈ `feat|fix|chore|docs|refactor|test|ci|perf`. Contributeur peut tout faire sauf publier npm/MCP Registry (maintainer-only).
