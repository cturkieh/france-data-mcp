# CLAUDE.md — france-data-mcp

> Conventions + workflow + release. Voir `README.md` pour l'usage MCP, `CHANGELOG.md` pour l'historique.

## Stack

TypeScript strict + Vercel serverless (`api/`) + Supabase PostGIS + pnpm + tsup + vitest + biome.
Lib (`src/`, publiée npm) ≠ Endpoint (`api/`, hosté Vercel) — voir conventions distinctes.

## Workflow

```bash
pnpm test:unit                            # rapide, sans DB
pnpm typecheck && pnpm lint               # avant tout commit
pnpm test                                 # complet, nécessite `pnpm db:start`
pnpm release                              # release semi-auto (voir scripts/release.sh)
```

CI GitHub Actions vérifie typecheck (2 tsconfigs) + biome + tests + Supabase local.

## Conventions code

**Lib (`src/`) — OSS publiable, pas de Sentry direct.**
- Catch jamais silencieux : `console.error` ou `console.warn` avec préfixe `[france-data-mcp]`.
- `RangeError` pour input invalide au boundary public (mappe JSON-RPC `-32602`).
- `LookupResult<T>` discriminé pour distinguer "pas trouvé" vs "erreur API".
- Tests `_resetXForTesting()` pour tout module avec état partagé.

**Endpoint (`api/`) — Sentry + observabilité.**
- `captureMcpError` / `captureMcpConfigWarning` avec fingerprint stable (`api/_lib/sentry.ts`).
- Logs JSON 1 ligne/req via `logMcpEvent`. Rate limit Upstash 60/min/IP.
- Anti-spoofing IP : dernier segment XFF (Vercel append en queue).

**Boundary (`api/_lib/args.ts`).**
- Validators `requireXxxId` avec 3 branches (clé absente, type wrong, format wrong) via factor `requireIdPattern`.
- Regex partagés lib ↔ boundary : `NUM_FINESS_PATTERN`, `RPPS_ID_PATTERN`, `SIRET_PATTERN` exportés depuis `src/sante/db-helpers.ts`.

## Ingestion (crons GitHub Actions)

3 sources : FINESS (bimestriel, ~95K), Ameli (hebdo, ~485K), RPPS (mensuel, ~2.23M). Pattern : download → SHA256 short-circuit si identique → COPY staging → validate → atomic swap → canary → ingest_log.

**Service client typage** : pour toute RPC ajoutée par migration récente, utiliser `getUntypedServiceClient(source)` (sinon `tsc -p tsconfig.api.json` échoue, types Supabase pas regénérés).

## Top gotchas DB

- `ST_AsGeoJSON(geom)::jsonb` obligatoire en sortie RPC (sinon hex EWKB).
- Colonne calculée `geog GEOGRAPHY ... STORED` + index GIST (cast runtime tue le plan).
- PostgREST proxy timeout **60s** ≠ Postgres `statement_timeout` → batch UPDATEs par 10K.
- `LANGUAGE plpgsql + EXECUTE format(...)` pour forcer custom plan sur RPC avec param ciblé (sinon generic plan biaisé).
- `(date - date)` retourne jours total ; **pas** `EXTRACT(DAY FROM interval)` (fragile, retourne le champ "day").

## Discipline post-fix (avant commit feature)

1. Tests unitaires écrits/MAJ
2. `/simplify` (3 agents reuse/quality/efficiency en parallèle)
3. `/review` Passe 1 (3 agents : code-reviewer + silent-failure-hunter + code-simplifier) → corriger TOUT
4. `/review` Passe 2 (2 agents : code-reviewer + silent-failure-hunter)
5. Documentation à jour (CHANGELOG, CLAUDE.md, README si applicable)
6. `pnpm typecheck && pnpm lint && pnpm test:unit` verts

Pour commit `chore`/`fix(ci)` mécanique : étapes 2-4 skippables (documenter pourquoi).

## Release process

**Maintainer-only** (npm publish OTP 2FA + mcp-publisher GitHub OAuth sur namespace `io.github.cturkieh/...`).

Séquence (voir `scripts/release.sh` qui automatise) :

1. ☐ `pnpm typecheck && pnpm lint && pnpm test:unit` verts
2. ☐ Bump version sur 3 sources : `package.json`, `server.json`, `src/core/version.ts`
3. ☐ Éditer `CHANGELOG.md` (nouvelle section en haut)
4. ☐ `git commit + git tag -a vX.Y.Z + git push + git push origin vX.Y.Z`
5. ☐ Attendre CI vert (`gh run watch --exit-status`)
6. ☐ `pnpm build && pnpm publish --no-git-checks` (entrer OTP 2FA)
7. ☐ `mcp-publisher login github` (device code) → `mcp-publisher publish`
8. ☐ `gh release create vX.Y.Z --notes ...` (extrait du CHANGELOG)
9. ☐ Vérifier : `npm view france-data-mcp version`, registry MCP, `/healthz`, Vercel auto-deploy

## Contribuer

PR bienvenues. Convention commit : `<type>(<scope>): <résumé>` où type ∈ `feat|fix|chore|docs|refactor|test|ci|perf`. Contributeur peut tout faire sauf publier npm/MCP Registry (maintainer-only).
