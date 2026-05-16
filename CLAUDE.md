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
- **Clé de déduplication d'identité = attributs de PERSONNE uniquement**, jamais d'attribut de SITE (`raison_sociale`, adresse). Un PS multi-sites partage une identité ; mettre un attribut de site dans la clé le scinde en faux doublons (régression P1). L'attribut de site voyage dans `adresse`/`sites[]`.
- **Primitives génériques (texte, maths) → `core/`**, jamais `sante/`. `sante/` importe déjà `territoire/` : une primitive dans `sante/` consommée par `territoire/` crée une inversion de couche / cycle. Ré-export depuis l'ancien emplacement pour ne pas casser les consommateurs.

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
- `LANGUAGE plpgsql + EXECUTE format(... %L::CHAR(3) ...)` pour RPC filtrant une colonne `CHAR(n)` indexée par un param `TEXT`. **Jamais `WHERE col_char = p_text`** : Postgres caste la COLONNE indexée en text (`(col)::text = $1`) → index inutilisable → fallback seq/mauvais index (post-mortem V0.10.1, 254 ms→5,5 ms / 265 786→90 buffers). Interpoler le param en literal typé via `%L::CHAR(n)`, garder les autres params en `USING $n`.
- Nomenclature/agrégat full-table récurrent (GROUP BY non indexable sur table dense) → **materialized view** rafraîchie post-swap via `ingest_refresh_matview` (pattern `rpps_savoir_faire_stats`). Toute nouvelle matview refresh par un script ingest DOIT être ajoutée à la whitelist `ingest_refresh_matview` ET wirée post-swap — `scripts/ingest/staging-parity.test.ts` garde-fou les deux (+ parité index prod↔staging-create, perte silencieuse au swap hebdo). Ce garde-fou honore `DROP INDEX` PAR NOM (set prod *vivant* = creates − drops) : un index sciemment droppé n'est plus exigé en staging-create. Regex de drop ancrée sur `;` (sinon une prose de commentaire « drop index X » dé-tracke un index vivant = faux négatif).
- **Valider un code/identifiant contre une matview FILTRÉE = faux positif sur les codes valides exclus par le filtre** (post-mortem dette #1). `rpps_savoir_faire_stats` filtre `WHERE profession_code IS NOT NULL` ⇒ un `savoir_faire_code` n'apparaissant que sur des lignes profession NULL en serait absent → `RangeError` sur un code POURTANT valide (nouvelle panne silencieuse côté caller, pire que la dette). Toujours valider une nomenclature contre la matview NON filtrée qui est la **source réelle du count** que la validation protège (`rpps_count_stats`), pas une matview dérivée à finalité différente.
- `(date - date)` retourne jours total ; **pas** `EXTRACT(DAY FROM interval)` (fragile, retourne le champ "day").
- **Coords = centroïde commune + recherche rayon = piège O(lignes/commune)** (post-mortem V0.10.2). Une table dont les coords sont des centroïdes commune (RPPS) empile des dizaines de milliers de lignes au point identique en commune dense → `ST_DWithin`/KNN `<->` par-ligne sur le cluster co-localisé = 15 s, l'index GiST n'élague rien (tous les points identiques passent le `&&` bbox). Fix : matview de centroïdes communaux distincts (1 ligne/commune) → résoudre les communes dans le rayon (GiST sur la petite matview) puis `CROSS JOIN LATERAL (... WHERE code_insee = c.code_insee ... LIMIT n)` en early-stop via l'index B-tree `code_insee`. Jamais de KNN `geog <-> point` global sur une table à coords centroïde dense.

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
8. ☐ GitHub Release : **auto-créée par `release.yml` sur le push du tag** (étape 4) avec les notes du CHANGELOG. NE PAS lancer `gh release create` (422 `tag_name already exists`). Vérifier : `gh release view vX.Y.Z`
9. ☐ Vérifier : `npm view france-data-mcp version`, `/healthz`, et registry MCP via `curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=france-data-mcp' | jq -r '[.servers[]|select(.server.name=="io.github.cturkieh/france-data-mcp")]|sort_by(._meta."io.modelcontextprotocol.registry/official".updatedAt)|last|.server.version'` (PAS `.servers[0]` = plus ancienne entrée, fausse alerte)

## Contribuer

PR bienvenues. Convention commit : `<type>(<scope>): <résumé>` où type ∈ `feat|fix|chore|docs|refactor|test|ci|perf`. Contributeur peut tout faire sauf publier npm/MCP Registry (maintainer-only).
