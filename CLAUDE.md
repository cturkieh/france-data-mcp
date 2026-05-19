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

**`test`/`test:integration` portent `--no-file-parallelism`** : plusieurs
fichiers `*.integration.test.ts` partagent la table mutable `rpps_staging`
(recréée par `ingest_create_rpps_staging()`) — l'exécution parallèle des
fichiers les clobbe mutuellement (non déterministe). `test:unit` exclut les
intégration → reste parallèle/rapide. Tout nouveau test d'intégration touchant
`rpps_staging` DOIT re-seed en tête de chaque `it` + ré-asserter le peuplement
(échec bruyant si clobbé) — pattern de `ban-eligibility-skipscan.integration`.

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
- **Matview `FROM <table swappée par ingest_atomic_swap>` + post-swap REFRESH-only = bombe OID** (post-mortem 2026-05-18, prouvé prod). Une matview suit l'**OID** de sa table source, pas son nom. `ingest_atomic_swap` fait une rotation par RENAME (`<t>`→`<t>_previous`→`<t>_previous_OLD`→`DROP CASCADE`). Un post-swap qui se contente de `REFRESH MATERIALIZED VIEW` (RPC `ingest_refresh_matview`) ⇒ 1er cron réussi : la matview reste collée à l'ancienne table (désync SILENCIEUSE, status `success`, données périmées servies) ; 2e cron : `DROP <t>_previous_OLD CASCADE` la DÉTRUIT → tools `42P01` avalés en `partial`. Fix RPPS : `ingest_rebuild_rpps_matviews` RECONSTRUIT post-swap (`DROP MV <m>` + `CREATE MV <m>_rebuild AS <SELECT canonique VERBATIM> FROM <t>` résolu PAR NOM + index + `RENAME` atomique, 1 transaction PL/pgSQL ; échec transitoire→`partial` sans throw car rollback préserve l'ancienne, structurel→throw `failed`+exit). `scripts/ingest/rpps-matview-rebuild.test.ts` garde l'invariant + la parité DDL anti-drift. **Ameli avait le MÊME défaut — CORRIGÉ 2026-05-19** par `ingest_rebuild_ameli_matviews` (migration `20260519T200000`, réplication 1:1 du patron RPPS ci-dessus ; `refreshAmeliMatviews`→`rebuildAmeliMatviews`, garde-fou `ameli-matview-rebuild.test.ts`). Le DROP sans CASCADE de `ameli_nomenclature_stats` est prouvé prod malgré les 2 RPC `LANGUAGE sql` qui la référencent (fonctions sql à corps `$$` = pas de dépendance catalogue bloquante ; CASCADE proscrit, droperait les RPC). Dette P1 close : `shortCircuitIfSameChecksum` peut désormais être optimisé sans risque. Plus AUCUN script ingest n'utilise `ingest_refresh_matview` (RPPS + Ameli en rebuild) — la whitelist `ingest_refresh_matview` reste pour toute FUTURE matview refresh-only légitime (non FROM table swappée) ; `staging-parity.test.ts` garde la protection whitelist générique, les invariants rebuild sont gardés par `{rpps,ameli}-matview-rebuild.test.ts`.
- **Parité index prod↔`ingest_create_*_staging`** : tout index sur la table prod DOIT être mirroré dans la staging-create (sinon perdu SILENCIEUSEMENT au swap → re-régression 57014). `staging-parity.test.ts` garde-fou (set prod *vivant* = creates − drops, `DROP INDEX` honoré PAR NOM, regex de drop ancrée sur `;` sinon une prose de commentaire « drop index X » dé-tracke un index vivant = faux négatif). Recréer `ingest_create_*_staging` = **recopie VERBATIM** de la dernière def (PostgreSQL n'a pas d'héritage de corps de fonction) ; patcher « prod − N lignes » réintroduit silencieusement un objet retiré par une migration ultérieure.
- **RPC d'ingestion longue via PostgREST = budget `statement_timeout` 8s hérité si la fonction n'a pas son propre `SET` ; + bulk COPY sans `ANALYZE` = plan dégradé** (post-mortem 2026-05-18, RÉFUTE l'hypothèse « index BAN » ci-dessous, prouvé prod run #26046475566 + `pg_roles` + `EXPLAIN ANALYZE`). Supabase : `service_role` n'a AUCUN `statement_timeout` (`rolconfig` NULL) → un appel supabase-js clé SERVICE_ROLE → PostgREST hérite du `statement_timeout` de `authenticator` = **8 s** (`anon` 3s / `authenticated` 8s / `postgres` cap 2min). Toute RPC d'ingestion longue DOIT porter un `SET statement_timeout` AU NIVEAU FONCTION (best practice Supabase ; valeur **< 60 s** = cap passerelle PostgREST, sinon timeout passerelle opaque au lieu d'un 57014 propre). De plus, `ingest_apply_*_finess_enrichment_batch` requête `rpps_staging` juste après un bulk COPY (~2,24 M lignes, table fraîchement `CREATE`) : **sans `ANALYZE` le planner n'a aucune statistique → plan dégradé sur le 1er batch → >8 s → 57014 déterministe en `validate`, avant le swap** (données intactes, cron cassé « tout seul »). Fix RPPS C : `SET statement_timeout='55s'` sur l'enrichment ET sur `ingest_analyze_rpps_staging`, cette dernière (`ANALYZE rpps_staging`) appelée post-COPY/pré-enrichment par `rpps.ts` (échec → `IngestError` LOUD). Garde-fou `scripts/ingest/enrichment-statement-timeout.test.ts`. Vérifier le budget réel : `SELECT rolname, rolconfig FROM pg_roles`.
- **Index fonctionnel Unicode-lourd dans `ingest_create_*_staging` = AGGRAVANT du run (INSERT ralenti), PAS la cause du 57014 enrichment** (correctif d'un post-mortem erroné — la prod a réfuté l'inférence). Un index fonctionnel Unicode (`rpps_address_key_for_index`) avec prédicat partiel sur des colonnes que l'UPDATE de masse modifie alourdit la maintenance d'index pendant le COPY/UPDATE (run ~57 min) — mais le **vrai** déclencheur du 57014 était le budget 8 s hérité + l'absence d'`ANALYZE` (gotcha ci-dessus), pas cet index : son retrait seul (fix A) n'a PAS corrigé le timeout (run #26046475566). Garder néanmoins la règle d'hygiène : un index BAN/Unicode lourd doit vivre dans un step DÉDIÉ post-enrichment, JAMAIS dans `ingest_create_*_staging` (évite de re-rallonger le run). Leçon transverse : **prouver une cause-racine par la prod avant de coder le fix** ; une inférence passée en /review P1+P2 reste une inférence.
- **`ban_join` : pose BAN cache→staging = jumeau `finess_join` MAIS piloté CURSEUR KEYSET (`p_after`), JAMAIS sentinelle ; plus AUCUN build d'index lourd ni géocodage API dans le cron** (refonte 2026-05-19, prouvée prod ; spec `docs/plans/2026-05-19-ban-join-design.md`, plan `docs/plans/2026-05-19-ban-join-implementation-plan.md` ; SUPERSEDE la refonte 2026-05-18 ci-dessous). Le cache `geocoded_addresses` étant rempli (hors cron, par `ban-backfill.mjs`), il devient « une table à joindre » comme FINESS : `ingest_apply_rpps_ban_join_batch(p_after, p_limit)` (migration `20260519T180000`, `SET statement_timeout='55s'`, `RETURNS TABLE(last_id, applied)`) fait un `UPDATE rpps_staging ⟕ geocoded_addresses ON g.address_key = rpps_address_key_for_index(...)`, lot borné `WHERE id > p_after ORDER BY id LIMIT p_limit`. **Pourquoi keyset et NON sentinelle** (prouvé prod, EXPLAIN ANALYZE transaction ROLLBACK) : la sentinelle façon FINESS re-scanne le préfixe déjà traité → quadratique → **57014 en fin de parcours** (proxy `OFFSET 1.2M` > 120 s, RÉFUTÉ) ; le keyset démarre où le lot précédent s'est arrêté → **~4,8 s/lot CONSTANT** début↔fin (~1,29 M éligibles ≈ ~11 min linéaire). Jointure `geocoded_addresses_pkey` = nested-loop indexé optimal 0,18 ms/ligne → **aucun index fonctionnel lourd sur `rpps_staging` requis** (≠ l'ancien `ingest_build_rpps_staging_ban_indexes`, cause structurelle du blocage : `CREATE INDEX` multi-min via PostgREST = impossible, cap passerelle Supabase 60 s en dur). Séquence load-bearing `scripts/ingest/rpps.ts` : analyze (5a) → enrichment FINESS (5b) → `rpps_count_ban_eligible_rows` + `runKeysetRpc(ingest_apply_rpps_ban_join_batch)` (5c, fail-loud + sentinelle cohérence « 0 posé/cache non vide → throw ») → swap → rebuildMatviews. Helper générique `runKeysetRpc` (`shared.ts`, garde de non-progression + `withTimeout` anti-hang). Expression `rpps_address_key_for_index(...)` + prédicat `geom_source='commune_centroid' OR (geom IS NULL AND adresse IS NOT NULL)` byte-identiques sur 6 sites (count / skip-scan ×2 / index staging ×2 / **ban_join**), gardés par `ban-eligibility-predicate-parity` (6 sites) + `ban-eligibility-index-expr-parity` (ban_join via WRAPPER, jamais le jumeau nu) + `enrichment-statement-timeout` (ban_join ≤55 s). `runBanGeocodeStep` SUPPRIMÉ (et ses ~8 constantes/imports BAN). **Dette tracée** : `ingest_build_rpps_staging_ban_indexes` conservée en base mais PLUS câblée par le cron ; `ban-backfill.mjs` (inchangé, hors scope) dépend encore des index BAN présents sur `rpps` — à résoudre dans la future feature « automatisation backfill » (post-swap bloquant = dead-end connu).
- **[OBSOLÈTE — superseded par `ban_join` ci-dessus, gardé pour le post-mortem]** Ré-armement BAN via `ingest_build_rpps_staging_ban_indexes()` post-enrichment/pre-swap (refonte 2026-05-18) : la prémisse « un step RPC d'index dédié suffit » a été **réfutée par la prod** (run #26087010166 : `CREATE INDEX` multi-minutes via supabase-js → `upstream request timeout`, cap passerelle Supabase 60 s structurel). Leçon transverse conservée : indexer APRÈS chargement de masse reste juste (doc PostgreSQL « Populating a Database ») — mais via canal direct, JAMAIS via une RPC PostgREST synchrone dans le cron.
- **Valider un code/identifiant contre une matview FILTRÉE = faux positif sur les codes valides exclus par le filtre** (post-mortem dette #1). `rpps_savoir_faire_stats` filtre `WHERE profession_code IS NOT NULL` ⇒ un `savoir_faire_code` n'apparaissant que sur des lignes profession NULL en serait absent → `RangeError` sur un code POURTANT valide (nouvelle panne silencieuse côté caller, pire que la dette). Toujours valider une nomenclature contre la matview NON filtrée qui est la **source réelle du count** que la validation protège (`rpps_count_stats`), pas une matview dérivée à finalité différente.
- `(date - date)` retourne jours total ; **pas** `EXTRACT(DAY FROM interval)` (fragile, retourne le champ "day").
- **Coords = centroïde commune + recherche rayon = piège O(lignes/commune)** (post-mortem V0.10.2). Une table dont les coords sont des centroïdes commune (RPPS) empile des dizaines de milliers de lignes au point identique en commune dense → `ST_DWithin`/KNN `<->` par-ligne sur le cluster co-localisé = 15 s, l'index GiST n'élague rien (tous les points identiques passent le `&&` bbox). Fix : matview de centroïdes communaux distincts (1 ligne/commune) → résoudre les communes dans le rayon (GiST sur la petite matview) puis `CROSS JOIN LATERAL (... WHERE code_insee = c.code_insee ... LIMIT n)` en early-stop via l'index B-tree `code_insee`. Jamais de KNN `geog <-> point` global sur une table à coords centroïde dense.
- **La branche `precise` de `rpps_in_radius` exige un GiST PARTIEL `WHERE geom_source IN ('finess_join','ban_address')` (`rpps_geog_precise_gist`) ; un GiST GLOBAL sur `rpps(geog)` la re-régresse en 57014, et `ingest_create_rpps_staging` doit créer ce PARTIEL (jamais le global) sinon le swap reverte** (post-mortem 2026-05-19, prouvé prod). Extension du piège V0.10.2 ci-dessus à la CTE `precise` : `ST_DWithin(r.geog, v_point)` filtré `geom_source IN ('finess_join','ban_address')`. Avec un GiST GLOBAL présent, le planner prend `Index Scan rpps_geog_gist` (`geog && _st_expand`) et relègue `geom_source` en **Filter post-index** → le bbox ramène tout le cluster co-localisé `commune_centroid` (prouvé Paris 1 km : 77 381 lignes dont **76 940 jetées en Filter** pour 225 résultats) → 57014. `20260516T050000` DROP le global + CREATE le partiel sur `rpps`. **Mais** `ingest_create_rpps_staging` (def `20260518T140000`, désamorçage cron) recopiait verbatim la def main créant le GiST **global** `rpps_staging_geog_gist` : au 1er swap le RENAME revertait `rpps_geog_precise_gist`→`rpps_geog_gist` global = re-régression SILENCIEUSE (découplage des 2 firefights BAN-rearm vs désamorçage cron). Fix durabilité `20260519T160000` : staging-create crée `rpps_staging_geog_precise_gist` (partiel, prédicat byte-identique RPC↔`20260516T050000`↔guard), le swap le renomme en `rpps_geog_precise_gist`. Garde-fou `staging-parity.test.ts` (« tout GiST rpps_staging(geog) porte le prédicat partiel ») : forme POSITIVE sur CHAQUE GiST `(geog)` (≠ regex négative qui ratait `IF NOT EXISTS`/`public.`/`WITH`/coexistence = faux VERT silencieux) + parité consommateur croisée vs `rpps_in_radius` + lecteur STRICT tag-aware `latestFunctionBody(..., {stripComments:true})` du module (ferme le faux VERT « prédicat en commentaire inline » et « def future en `$tag$` → corps mort capturé »). Le guard `indexColumnLists` historique est AVEUGLE ici (global et partiel normalisent à la même liste de colonnes `geog`, la clause WHERE étant hors du 1er groupe de parenthèses) — d'où l'assertion dédiée. Leçon transverse : 2 firefights concurrents peuvent découpler une fonction de son index compagnon ; tout index spatial sur `rpps` DOIT être mirroré PARTIEL-à-PARTIEL dans staging-create, pas seulement « par liste de colonnes ».

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
