# CLAUDE.md — france-data-mcp

> Règles de tête seulement (budget ~400 mots). **Charger le skill AVANT de toucher sa zone** : `mcp-conventions` (`src/`, `api/`, un tool MCP), `ingestion-crons` (`scripts/ingest/`, `supabase/migrations/`, workflows `ingest-*`), `db-gotchas` (SQL, RPC, PostGIS, plan de requête), `release-process` (toute publication). `README.md` : usage MCP. `CHANGELOG.md` : historique.

> **Override CLAUDE.md global — Déploiement** : Merge sur `main` et deploy production = **manuel**, validation Cyril requise. Le défaut universel « Claude merge+deploy auto quand tout est vert » ne s'applique PAS ici. Justification : données santé prod (FINESS / RPPS / Ameli), HDS, audit trail ; les régressions silencieuses prouvées prod (matview OID, GiST partiel découplé, ban_join keyset) avaient toutes des tests verts au commit. Claude prépare la PR, Cyril valide et merge.

## Stack

TypeScript strict + Vercel serverless (`api/`) + Supabase PostGIS + pnpm + tsup + vitest + biome.
Lib (`src/`, publiée npm, OSS, pas de Sentry direct) ≠ Endpoint (`api/`, hosté Vercel, Sentry + logs JSON) : conventions distinctes.

## Workflow

```bash
pnpm test:unit                            # rapide, sans DB
pnpm typecheck && pnpm lint               # avant tout commit
pnpm test                                 # complet, nécessite `pnpm db:start`
pnpm release                              # release semi-auto (voir scripts/release.sh)
```

CI GitHub Actions vérifie typecheck (2 tsconfigs) + biome + tests + Supabase local.

`test`/`test:integration` portent `--no-file-parallelism` : les `*.integration.test.ts` partagent la table mutable `rpps_staging`. Tout nouveau test d'intégration qui la touche re-seed en tête de chaque `it` et ré-asserte le peuplement (pattern `ban-eligibility-skipscan.integration`).

## Invariants transverses

- « Pas trouvé » ≠ « erreur » (`LookupResult<T>`) ; catch jamais silencieux, préfixe `[france-data-mcp]` ; `RangeError` pour input invalide au boundary (→ `-32602`).
- PostgREST sérialise `NUMERIC`/`BIGINT` en **string** → coercer au boundary (`numOrNull`), tester avec des strings.
- Migrations prod via **MCP Supabase `apply_migration`** (le CLI `db push` est cassé, format `T`).
- Source tarie ≠ succès : `data_freshness` expose l'âge réel (`data_age_days`), un canary manquant marque le run `partial`.

## Release

Maintainer-only, checklist complète dans le skill `release-process`. Release GitHub auto sur le tag : ne PAS `gh release create`.

## Contribuer

PR bienvenues. Convention commit : `<type>(<scope>): <résumé>` où type ∈ `feat|fix|chore|docs|refactor|test|ci|perf`. Contributeur peut tout faire sauf publier npm/MCP Registry (maintainer-only).
