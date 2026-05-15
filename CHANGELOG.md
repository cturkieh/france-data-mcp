# Changelog

Toutes les modifications notables apparaissent ici. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; le projet suit
SemVer (la branche `0.x` autorise les breaking changes mineurs documentés).

## [0.10.1] — 2026-05-15

**Patch — fix timeout Postgres 57014 sur 3 RPC Ameli (root cause prouvée en prod).**

Symptôme : `ameli_lister_specialites`, `ameli_lister_types_ps`,
`ameli_by_specialite_dept` renvoyaient par intermittence
`57014: canceling statement due to statement timeout` (systématique à cache
froid post-ingest hebdo / éviction par les requêtes RPPS 2.23M). Diagnostic
EXPLAIN ANALYZE en prod (transaction ROLLBACK, zéro mutation) :

- **`ameli_by_specialite_dept`** : `WHERE a.code_departement = p_departement`
  avec `p_departement` typé `TEXT` → Postgres caste la **colonne indexée
  `code_departement CHAR(3)` en text** (`(code_departement)::text = $1`),
  rendant `annuaire_ameli_dept_sort_covering_idx` inutilisable → fallback
  `insee_idx`, scan/filtre ~460K lignes (254 ms / **265 786 buffers**).
  Ce n'était PAS un problème generic-vs-custom plan (les deux étaient lents).
  **Fix A** : RPC réécrite `LANGUAGE plpgsql` + `EXECUTE format(... %L::CHAR(3)
  ...)` (même pattern que `rpps_par_specialite_dept` V0.5.4, jamais porté à
  Ameli jusqu'ici). Mesuré : **254 ms / 265 786 buffers → 5,5 ms / 90
  buffers**, parité de sortie byte-identique vérifiée sur 6 cas.

- **`ameli_lister_specialites` / `ameli_lister_types_ps`** : `Seq Scan` de
  462K lignes / 154 MB + HashAggregate à chaque appel (GROUP BY non
  indexable). La sous-requête corrélée O(N²) était négligeable (red herring).
  **Fix B/C** : materialized view `ameli_nomenclature_stats` pré-agrégée (~65
  lignes), refresh post-swap via `ingest_refresh_matview` (whitelist étendue),
  pattern `rpps_savoir_faire_stats` V0.8.2. Mesuré : **~330 ms → ~43 ms**,
  parité byte-identique. Garde `status: "partial"` ajouté côté
  `scripts/ingest/ameli.ts` (symétrie RPPS) pour ne pas masquer un échec de
  refresh en `success`.

- **Garde-fou** : nouveau test structurel `scripts/ingest/staging-parity.test.ts`
  (sans DB) — échoue si un index prod `annuaire_ameli` n'est pas répliqué
  dans `ingest_create_annuaire_ameli_staging()` (perte silencieuse au swap
  hebdo, déjà arrivé 2× historiquement) ou si une matview refresh par un
  script ingest est hors whitelist `ingest_refresh_matview`.

Migrations : `20260515T020000_ameli_by_specialite_dept_execute_format.sql`,
`20260515T020100_matview_ameli_nomenclature.sql`. Aucun changement d'API MCP
(sémantique de sortie strictement identique). 872 tests verts. Hotfix
DB-side : package npm/MCP Registry inchangé vs 0.10.0 (la lib `src/` et
l'endpoint `api/` ne changent pas — fix dans les migrations SQL + script
d'ingestion, non packagés).

## [0.10.0] — 2026-05-15

**Minor — `inspect_site` agrégateur 360 + nouvelle source CDS (centres de santé).**

Sprint V0.10.0 : 1 nouveau tool composé pour la vue 360 d'un établissement
santé (pendant naturel de `panorama_sante_territoire` côté site), + nouvelle
source d'ingestion CDS (centres de santé Annuaire Ameli CNAM) avec 2 tools
MCP dédiés exposant la donnée métier carte_vitale / APCV / spécialités
exercées sur place que FINESS catégorie 124 n'a pas. **34 tools exposés**
(31 V0.9.4 + 3). 865 tests verts (+36 vs V0.9.4).

### Ajouté

- **`inspect_site(num_finess)`** — vue 360 d'un établissement santé en 1
  call MCP. Composition pure de `verifier_site_actif` + `rpps_dans_etablissement`
  + `historique_etablissement` en parallèle (`Promise.all`). Retourne 4
  sections : identification FINESS (raison sociale, adresse, téléphone),
  statut administratif SIRENE (verdicts site + groupe via SIRET resolver,
  best_match, dinum_errors, explication LLM-friendly), professionnels
  rattachés (count exact + sample), historique INSEE (timeline périodes).
  Section `historique` encapsulée en `available: false` quand FINESS existe
  mais aucun SIRET candidat (RPPS vide + DINUM 0 match) — au lieu d'un
  silent dropping. `LookupResult` discriminé pour cohérence avec les
  sous-tools. Surcoût admis : pivot RPPS→DINUM exécuté en double (verifier
  + historique partagent la cascade), p95 ≤ 600 ms — acceptable pour un
  agrégateur. Optimisation différée à V0.11+ via factor `_loadSiteContext`
  dans `cross-source.ts`. Alias DX : `numFiness`/`finess`/`id` → `num_finess`.
- **Source CDS — Centres de Santé** (Annuaire santé Ameli CNAM, ~3K
  structures, sync hebdomadaire). Pipeline complet calqué sur Ameli PS :
  - **Migrations SQL** :
    - `20260515T010000_table_centres_sante` — table `centres_sante`
      (PK `etab_finess` CHAR(9), donnée métier `accepte_carte_vitale` /
      `accepte_apcv` BOOLEAN, `specialites_codes`/`libelles` TEXT[]
      dénormalisé, `type_etab_code` 124/125, geog GENERATED STORED, RLS anon
      SELECT). Indexes GIST sur geog, B-tree sur dept/insee/type, GIN sur
      `specialites_codes` pour `?|` any-of performant.
    - `20260515T010100_rpc_centres_sante_staging` — RPC SECURITY DEFINER
      superset strict (lesson V0.5.1).
    - `20260515T010200_canary_cds_extension` — étend `check_ingest_canary`
      à la source `cds`, seed 2 cibles canary TODO à valider après 1ère
      ingestion réelle.
    - `20260515T010300_rpc_centres_sante_query` — RPCs `centres_sante_in_radius`
      (PostGIS ST_DWithin + filtre GIN any-of spécialités + carte_vitale +
      type_etab) et `centres_sante_by_finess` (lookup PK).
  - **Script `scripts/ingest/cds.ts`** (276 lignes) — pattern download
    SHA256 short-circuit + pre-validate + fetchAllCommunes + groupBy
    `etab_finess` (volume bound ~600 KB RAM) + dédup spécialités via Map +
    insert batched + atomic_swap + canary. Thresholds calibrés (MIN_CDS=2K,
    MAX_CDS=5K, structural ≤ 1%, unmatched_locality ≤ 5%). Gestion des
    leading zeros etab_finess + parseStrictBoolean + warn sur drift schéma
    CNAM (carte_vitale = "1" / "yes" → false par défaut, observable ops).
  - **Workflow `.github/workflows/ingest-cds.yml`** — cron lundi 06:00 UTC
    (2h après le slot Ameli pour ne pas saturer data.gouv), timeout 15 min,
    auto-issue on failure avec causes typiques pré-listées.
  - **Lib `src/sante/cds-db.ts`** (200 lignes) — `getCdsInRadius` +
    `getCdsByFiness` (LookupResult discriminé), shape métier propre
    (`specialites: { codes, libelles }`, `type_etab: { code, libelle }`,
    coords centroïde commune null si geom malformé — pas de Golfe-de-Guinée
    silencieux).
  - **Tools MCP** : `centres_sante_in_radius` (filtres `specialite_codes`
    array any-of, `accepte_carte_vitale` boolean optionnel, `type_etab_codes`
    array, alias DX radius/latitude) + `centres_sante_by_finess` (alias DX
    numFiness/finess/etab_finess). Documentation stricte L.1461-2 CSP
    "Source : Annuaire santé Ameli, Assurance Maladie".
- **Type `IngestSource`** étendu à `"cds"` (4 sources désormais : finess,
  ameli_ps, rpps, cds).
- **GeoPrecision `centroide_commune_cds`** — note dédiée mentionnant la
  source CNAM + L.1461-2 CSP + pivot via `etab_finess` pour précision
  adresse. Helper `cdsRadiusMetadata`.
- **Helper générique `buildListQueryResult<TRaw,TOut,TMeta>`** (`db-helpers.ts`)
  — factorise le pattern `expectRpcRows → truncation → slice → map`. Adopté
  par `cds-db.ts` ; migration des 5 occurrences pré-existantes au backlog.
- **Garde anti-drift booléen CDS** — `parseStrictBoolean` signale les
  fallbacks (valeur ni "true" ni "false") ; l'ingestion REFUSE le swap si
  le taux dépasse `BOOLEAN_FALLBACK_THRESHOLD` (1 %). Empêche de publier
  une table où `accepte_carte_vitale` est massivement faux si CNAM bascule
  le schéma `true/false` → `1/0` (donnée santé métier différenciante).
- **Const `CDS_TYPE_ETAB`** {STANDARD: "124", DENTAIRE: "125"} — source de
  vérité unique pour les codes type établissement Annexe B.
- **Script package.json `ingest:cds`** — `tsx scripts/ingest/cds.ts`.

### Notes opérationnelles

- **Migrations à appliquer en prod manuellement** via Dashboard SQL Editor
  (les 4 fichiers `20260515T010*`) ou via `mcp__claude_ai_Supabase__apply_migration`.
  L'ordre est important : `010000` (table) → `010100` (staging RPC) →
  `010200` (canary) → `010300` (query RPCs).
- **Canary CDS inactif par design** — la migration `010200` ne seed AUCUNE
  cible `cds` (les vrais `etab_finess` notoires sont inconnus avant la 1ère
  ingestion). Le RPC retourne `[]` pour `cds` (inactif sans bruit, comme
  `ameli_ps`) — pas de cry-wolf. Activation via migration corrective
  `_canary_cds_real_seeds` une fois 3-5 CDS stables identifiés en base.
- **`withFreshness` non câblé pour `cds`** — `centres_sante_in_radius` ne
  passe pas par le wrapper freshness pour l'instant (le type `IngestSource`
  côté freshness reste sur 3 sources). Workaround : appeler `data_freshness`
  séparément avec `source: "cds"`. Câblage propre prévu en V0.10.1.
- **Bump version** : 3 sources (`package.json`, `server.json`,
  `src/core/version.ts`) à passer de `0.9.4` à `0.10.0` AVANT release npm
  (séquence `scripts/release.sh`).

## [0.9.4] — 2026-05-14

**Patch — fix timeout 57014 Ameli + polish dette technique.**

Mini-sprint quick wins V0.9.x focalisé sur Sentry FRANCE-DATA-MCP-3 (timeout
SQL 57014 sur `professionnels_par_specialite_dept`, 3 events 13-14 mai sur
users OpenAI et Claude). Fix structurel par index couvrant aligné sur
l'ORDER BY de la RPC, instrumentation diagnostic Sentry, et 5 refactors
post-V0.9.3 backlog `P2 — Polish` exécutés en parallèle. 829 tests verts
(vs 801 V0.9.3, +28 tests).

### Ajouté

- **Index couvrant Ameli** (migration `20260514T090000_idx_ameli_dept_sort_covering`) —
  `annuaire_ameli (code_departement, code_insee NULLS LAST, nom, prenom, id)`
  aligné sur l'ORDER BY exact de `ameli_by_specialite_dept`. Postgres peut
  désormais faire un Index Range Scan + ordering gratuit et s'arrêter au
  LIMIT au lieu d'un top-N heapsort en RAM sur les départements denses.
  Coût query : O(N log N) → O(LIMIT). Bénéficie en particulier au cas
  "department-only sans filtre" non couvert par les composite indexes V0.4.1.
  Mirror staging via `ingest_create_annuaire_ameli_staging` superset strict
  → survit au swap hebdo.
- **`api/_lib/error-context.ts`** — propagation de context diagnostic
  anonymisé via symbol non-enumerable, lu par `captureMcpError` pour
  enrichir le scope Sentry. Garde la lib `src/` libre de toute dépendance
  Sentry (règle OSS). Double anti-leak : `Symbol.for("mcp.query_context")`
  (invisible à `JSON.stringify` / `Object.keys` / `getOwnPropertyNames`) +
  non-enumerable defense-in-depth. Rejet explicite des arrays
  (Sentry `setContext` attend un object plain).
- **`api/_lib/once-warner.ts`** — helper `onceWarner()` + spécialisation
  `prodOnlyConfigWarner(code, message, captureFn)` qui factorise les 4
  flags one-shot warn module-level (`axiomWarningEmitted`, `bufferOverflowWarned`,
  `breakerOpenWarned`, `saltWarningEmitted`). Rend la mécanique mécanique
  au lieu de discipline humaine ("aligné avec X").
- **Instrumentation Sentry tool `professionnels_par_specialite_dept`** —
  context anonymisé (`departement`, `has_specialite_filter`, `has_type_ps_filter`,
  `offset`, `limit`) attaché au throw, surfacé dans le scope `mcp_query`.
  Type `AmeliQueryErrorContext` strict bloque l'ajout de PII au compile time.
  Si retimeout malgré l'index, on aura le pattern exact en un click Sentry.
- **Constantes `DROP_STALE_PREVIOUS_DEFAULT_DAYS = 7`** et
  **`DROP_STALE_PREVIOUS_MAX_DAYS = 365`** exportées depuis
  `scripts/ingest/shared.ts` — miroir des bornes RPC SQL. Consommées par la
  CLI `drop-stale-previous.ts` (auparavant magic numbers en dur).
- **Log `axiom_circuit_breaker_closed: cool-down expired, retrying flush`**
  émis quand le breaker se réarme. Observabilité ops côté Vercel Logs sans
  re-pinger Sentry (event d'origine `axiom_circuit_breaker_open` reste seul
  côté alerting).
- **28 tests ajoutés** : 10 `error-context` (attach/extract/Array reject/
  getOwnPropertyNames defense), 16 `once-warner` (8 `onceWarner` idempotence /
  reset / payload variable / exception non catchée + 8 `prodOnlyConfigWarner`
  prod/preview/dev gate / idempotence / reset / verbatim code+message),
  2 `sentry.test` (scope `mcp_query` push + absent quand no context),
  1 assertion ajoutée à `observability.test` (log `circuit_breaker_closed` au
  reset cool-down). Total 829 tests verts.

### Modifié

- **`captureMcpError`** (`api/_lib/sentry.ts`) — lit le context attaché
  via `extractErrorContext(err)` et push dans `scope.setContext("mcp_query", ...)`
  uniquement si non-undefined (pas de scope vide).
- **`warnMissingSaltOnce` / `warnMissingAxiomOnce`** — refactorés vers
  `prodOnlyConfigWarner`. Comportement runtime identique (env check
  prod+preview, fingerprint Sentry stable), code 50 % plus court.
- **Tool handler `professionnels_par_specialite_dept`** — wrap try/catch
  qui attache un context anonymisé à l'erreur AVANT re-throw. `console.error`
  en 1re ligne du catch (robuste au hook `enforce-logging` qui scanne 8
  lignes après le `catch (err) {`).

### Backlog post-V0.9.4

- Union typée `McpConfigWarningCode` pour fermer les codes Sentry config_warning
  (reporté tant que <4 codes en usage)
- Si retimeout 57014 malgré l'index couvrant : Option B — réécrire la RPC
  `ameli_by_specialite_dept` en `EXECUTE format(...)` pour custom plan
  systématique (lesson V0.5.2-V0.5.4 documentée dans CLAUDE.md)
- Tools composés `panorama_sante_territoire` / `inspect_site(num_finess)`
- CDS centres de santé (CSV 3 Mo, pipeline Ameli-like)
- DOM widening FINESS (`code_insee` CHAR(5))

## [0.9.3] — 2026-05-14

**Patch — polish refactor legacy + observabilité avancée.**

Second mini-sprint quick wins V0.9.x sur le backlog `P2 — Polish` et
`P2 — Observabilité` : circuit breaker Axiom pour stopper les fetch quand
le token est révoqué/dataset absent, helpers boundary `requireRppsId` /
`requireSiretId` (miroirs V0.9.2 `requireFinessId`), DROP différé des
`<source>_previous` quand l'ingestion stagne, et 4 micro-refactors qui
suppriment des duplications repérées en review V0.9.2.

### Ajouté

- **Circuit breaker Axiom** (`api/_lib/observability.ts`) — après
  `AXIOM_BREAKER_THRESHOLD = 5` erreurs 4xx consécutives (auth/scope/dataset),
  coupe les fetch pendant `AXIOM_BREAKER_COOL_DOWN_MS = 5 min` et émet UN
  `Sentry.captureMessage("axiom_circuit_breaker_open", warning)` avec
  fingerprint stable. Les 5xx (panne transient Axiom) et erreurs réseau
  n'incrémentent PAS le compteur — retry au prochain flush. Succès → reset.
  Évite de spammer Axiom + Sentry quand la misconfig persiste.
- **`requireRppsId(args, key="rpps_id")`** (`api/_lib/args.ts`) — validator
  tool boundary, miroir de `requireFinessId` (3 branches d'erreur : clé
  absente, type wrong, format wrong via `RPPS_ID_PATTERN`). Refactor caller
  `professionnel_by_rpps` qui dupliquait `asString + trim + custom error`.
- **`requireSiretId(args, key="siret")`** — validator tool boundary,
  partage `SIRET_PATTERN` (14 chiffres) avec la lib. Refactor caller
  `etablissement_by_siret` qui dupliquait la regex inline.
- **`RPPS_ID_PATTERN` + `SIRET_PATTERN`** (`src/sante/db-helpers.ts`) —
  source de vérité unique, miroirs de `NUM_FINESS_PATTERN` (V0.9.2). Le
  pattern RPPS est aussi consommé par `getRppsById` (lib).
- **`dropStalePrevious()`** + RPC `ingest_drop_stale_previous(p_prod_table,
  p_source, p_max_age_days=7)` (migration `20260514T080000`) — drop
  `<prod>_previous` si `MAX(ingest_log.started_at WHERE status='success') >
  max_age_days`. Retour discriminé (`dropped` / `kept` / `absent` /
  `no_history`) parsé par `parseDropStalePreviousOutcome`. Idempotent.
  Économie disk principale sur `rpps_previous` (~700 MB) et `ameli_ps_previous`
  (~150 MB) quand l'ingestion stagne.
- **`scripts/ingest/drop-stale-previous.ts`** — CLI standalone qui boucle
  sur les 3 sources (`finess`, `ameli_ps`, `rpps`) et appelle
  `dropStalePrevious` avec `--max-age-days=N` configurable. À lancer
  manuellement ou via GitHub Action de maintenance hebdo.
- **`resolveCategorieCodes(codes?)`** (`src/sante/rpps-db.ts`) — helper
  pure qui défausse explicitement le default TS-side `[C]` (Civil seul)
  quand l'array d'input est vide ou undefined. Consommé par
  `getRppsParSpecialiteDept` et `getRppsByName`. JSDoc documente le piège
  sémantique avec les 4 autres wrappers qui passent `?? []` (sémantique
  différente : laisse la RPC retomber sur son COALESCE SQL).
- **17 tests ajoutés** : 7 circuit breaker (threshold, 5xx ignoré, network
  error ignoré, reset success, cool-down, one-shot Sentry, drop buffer),
  4 INSEE/ANS 429 (sustained → null/api_error, transient → recover),
  5 `parseDropStalePreviousOutcome` (4 formats + drift contrat),
  1 re-tripp breaker après cool-down,
  2 sémantique `resolveCategorieCodes` (`[]` vs `[C]`). Total 801 tests
  verts (vs 781 V0.9.2).

### Modifié

- **`getFinessByCategorie`** (`src/sante/finess-db.ts`) — migré de
  `getAnonClient` (typé) vers `getUntypedAnonClient` pour supprimer le cast
  overkill `null as unknown as string`. Pattern aligné sur `countFiness`
  et tous les wrappers `rpps-db.ts`.
- **`getRppsById`** — utilise désormais `RPPS_ID_PATTERN` (source de vérité
  partagée) au lieu de la regex inline `/^\d{11,12}$/`.
- **`__resetAxiomStateForTesting`** — reset aussi le state du circuit
  breaker (compteur 4xx, instant de réouverture, flag warned). Helper
  `__getAxiomBreakerStateForTesting()` exposé pour les assertions.

### Backlog post-V0.9.3

- Tools composés `panorama_sante_territoire` / `inspect_site(num_finess)`
- CDS centres de santé (CSV 3 Mo, pipeline Ameli-like)
- DOM widening FINESS (`code_insee` CHAR(5))
- INSEE Melodi (séries macro libre sans clé pour dénominateurs population)

## [0.9.2] — 2026-05-14

**Patch — observabilité production + nettoyage dette legacy.**

Mini-sprint quick wins post-V0.9.1 : un endpoint `/healthz` pour les monitors
externes, escalade Sentry sur les warns one-shot RGPD/observabilité, capture
groupée des timeouts Postgres 57014, et factorisation de deux duplications
(API key reader + FINESS ID validator) repérées dans le backlog `P2 — Polish`.

### Ajouté

- **`/healthz` endpoint** (`api/healthz.ts`) — GET/HEAD retournent 200 + JSON
  `{ status, version, timestamp, config }` où `config` expose des booléens
  par dépendance (Axiom, IP salt, Sentry, Supabase, INSEE SIRENE, ANS FHIR,
  Upstash). Aucune valeur d'env var leakée. Path rewrite `/healthz` →
  `/api/healthz`, CORS `*`, `Cache-Control: no-store`, `maxDuration: 5s`.
  Consommable par Uptime Kuma, Better Stack, Smithery, etc.
- **`captureMcpConfigWarning(code, message)`** (`api/_lib/sentry.ts`) — capture
  d'un `Sentry.captureMessage` avec `level: warning`, tag `mcp.config_warning`
  et fingerprint stable basé sur le `code` pour grouper toutes les instances
  d'un même warn one-shot dans UNE issue Sentry. Appelé depuis
  `warnMissingSaltOnce` (code `missing_ip_salt`) et `warnMissingAxiomOnce`
  (code `missing_axiom_config`). Sans ce signal, un oubli d'env var en prod
  dégrade silencieusement une promesse PRIVACY.md.
- **Détection Postgres timeout 57014 dans `captureMcpError`** — quand le
  message d'erreur matche `(57014)` (code SQLSTATE injecté par
  `formatRpcError`), ajout d'un tag `mcp.postgres_code=57014`, escalade en
  `level: warning` et fingerprint stable `[mcp_postgres_timeout, method, tool]`.
  Toutes les timeouts d'un même tool sont groupées dans une seule issue Sentry —
  un volume anormal sur ce groupe = signal d'index manquant à investiguer,
  pas une panne à pager. Lib OSS reste sans dépendance Sentry (détection regex
  côté `api/` uniquement).
- **`readApiKeyEnv(name)`** (`src/core/env.ts`) — helper centralisé pour les
  secrets API : lit `process.env[name]`, trim + strip quotes entourantes,
  retourne `null` si absente/vide après nettoyage. Élimine la duplication
  entre `getInseeApiKey` et `getAnsFhirApiKey` (Vercel UI conserve parfois
  les `"<UUID>"` → 401 silencieux indiscernable d'une clé révoquée).
- **`requireFinessId(args, key?)`** (`api/_lib/args.ts`) — valide qu'un argument
  tool MCP est un FINESS (9 chiffres exactement après trim). Throw `RangeError`
  avec message explicite incluant le paramètre attendu + un exemple. Remplace
  6 callers répétés dans `api/tools.ts` qui faisaient `asString + check vide`
  sans valider la longueur ni le format chiffres. Defense-in-depth au tool
  layer (message LLM-friendly) + RPC Postgres (CHAR(9) reject).
- **Tests** — 30 nouveaux tests : 6 healthz (GET/HEAD/405, booléens, secrets
  non leakés, axiom host EU/US), 4 captureMcpConfigWarning (sans/avec DSN,
  Sentry throw, init failed), 2 warns one-shot relayés (rate-limit + axiom),
  4 timeout 57014 (tags + fingerprint avec tool / sans tool / non-timeout /
  err null), 7 requireFinessId (trim, custom key, type non-string, < 9 chars,
  > 9 chars, non-numérique, message d'erreur), 7 readApiKeyEnv (absente, vide,
  whitespace, trim, quotes ", quotes ', quotes internes préservées).

### Modifié

- **`getInseeApiKey` / `getAnsFhirApiKey`** délèguent à `readApiKeyEnv`. Aucun
  changement de comportement, juste élimination d'une duplication.
- **JSDoc `SavoirFaireEntry.libelle`** (`rpps-db.ts`) — corrigée pour refléter
  le comportement réel de la matview `rpps_savoir_faire_stats` :
  `MAX(savoir_faire_libelle)` retient le **dernier alphabétiquement**, PAS
  le plus fréquent. Stable et déterministe, suffisant pour disambiguation
  côté LLM (le `code` reste l'identifiant). Backlog `P2 — Polish` reporté
  V0.9.1.
- **`toFinessResult`** (`finess-db.ts:249`) — aligné sur `rpps-db.ts:toResult`
  pour éviter un `(0,0)` Golfe-de-Guinée silencieux quand `geom.coordinates`
  est malformé : check `typeof === "number"` + fallback `coords: null`.
  Backlog `P2 — Refactor legacy`.
- **`vercel.json`** — ajout de la fonction `api/healthz.ts` (maxDuration 5s),
  rewrite `/healthz` → `/api/healthz`, headers CORS dédiés.

### Fix

- **Version mismatch** — `src/core/version.ts`, `package.json` et `server.json`
  passés à `0.9.2` en synchrone (lesson V0.9.1).

## [0.9.1] — 2026-05-14

**Patch — log drain Axiom + privacy hardening + fix format CI.**

V0.9.1 publie officiellement le code Axiom log drain (push miroir des logs
MCP vers un dataset Axiom avec rétention 30 jours, fail-soft) et le privacy
hardening du hash IP (salt via `FRANCE_DATA_IP_SALT`, warn one-shot anti
silent-failure RGPD) qui avaient été embarqués accidentellement dans le
commit Biome `f54b87f` mais sans le format Biome final. Cette release fix
le format CI, synchronise `src/core/version.ts` (qui était resté à 0.8.3),
et expose ces fonctionnalités au consommateur du wrapper npm.

### Ajouté

- **`flushMcpEventsToAxiom`** — log drain Axiom (push batch en `finally` du
  handler MCP, parallèle à `flushSentry` via `Promise.allSettled`). Config via
  `AXIOM_TOKEN` + `AXIOM_DATASET` + `AXIOM_HOST` optionnel (`api.axiom.co`
  par défaut, `api.eu.axiom.co` pour la région EU). Buffer module-level cap 500
  avec warn one-shot si overflow. Timeout 1.5 s via `AbortSignal`. Fail-soft sur
  tout chemin (token absent, fetch reject, HTTP 4xx/5xx, body unreadable).
- **`warnMissingAxiomOnce`** — `console.error` one-shot en production si Axiom
  non configuré, signalant que la promesse PRIVACY.md de rétention 30 j n'est
  pas tenue. Symétrique à `warnMissingSaltOnce` côté `rate-limit.ts`.
- **Type `AxiomEvent`** — exige `_time: string` au compile time pour cohérence
  avec l'indexation Axiom.
- **16 nouveaux tests** sur le push Axiom (no-op, batch headers, URL encoding,
  `AXIOM_HOST` override + whitespace fallback, 4xx/5xx, fetch reject, body
  unreadable, buffer cap + overflow warn, warn one-shot prod, idempotence).

### Modifié

- **`logMcpEvent`** — refactor : extraction de `buildCanonicalRecord` partagé
  entre l'émission console et l'enqueue Axiom. Comportement public inchangé.
- **`api/mcp.ts` finally** — `await Promise.allSettled([flushSentry(),
  flushMcpEventsToAxiom()])` pour borner la latence ajoutée à
  `max(flushSentry, flushAxiom)` (acceptable ~1.5 s p99 sur endpoint MCP
  non-temps-réel).
- **`hashIp` (rate-limit.ts)** — salt SHA-256 via `FRANCE_DATA_IP_SALT`,
  `.trim()` appliqué (whitespace ≡ absent), warn one-shot en production si
  salt manquant. Documenté dans `PRIVACY.md`.
- **`PRIVACY.md`** — politique RGPD complète : données collectées, données NON
  collectées, sous-traitants avec localisation, base légale (art. 6.1.f RGPD),
  rétention 30 j sur Axiom (région selon compte), droits d'accès / effacement /
  portabilité, contact data controller.
- **`.env.example`** — sections `FRANCE_DATA_IP_SALT` et `AXIOM_*` documentées
  avec procédure least-privilege.
- **`README.md`** — section *Garde-fous publics* mise à jour (hash IP salé,
  bullet RGPD pointant vers `PRIVACY.md`).

### Corrigé

- **`src/core/version.ts`** — était resté à `0.8.3`, désormais synchronisé à
  `0.9.1` (la version `0.9.0` initialement publiée annonçait `0.8.3` au client
  MCP via `initialize.serverInfo.version`).
- **CI Biome** — format des fichiers Axiom (`observability.ts`, tests).
- **`.gitignore`** — ajout `*.tgz` pour éviter de tracker les artefacts
  `npm pack` locaux.

### Backloggé (acceptable jusqu'à ~10 RPS)

- Circuit breaker après N erreurs 4xx Axiom consécutives.
- Healthz endpoint exposant l'état de configuration (Axiom, salt, Sentry).
- `Sentry.captureMessage` sur les warns one-shot (Sentry capte déjà les 500).

## [0.9.0] — 2026-05-14

**Densité communale + agrégateur panorama + UX MCP — feature majeure.**

V0.9.0 ajoute le niveau commune au tool `densite_professionnels_sante` via
le nouveau RPC `count_rpps_by_commune`, introduit le tool agrégateur
`panorama_sante_territoire` (densités multi-PS + count FINESS en 1 call),
et applique 3 améliorations UX significatives (alias paramètres, descriptions
inputSchema enrichies, messages d'erreur suggestifs) suite au constat partagé
en testant le MCP via ChatGPT / Claude : 2-3 essais ratés en moyenne avant
de trouver le bon nom de paramètre.

### Ajouté

- **`panorama_sante_territoire(code_insee, finess_familles?)`** — nouvel
  agrégateur santé en 1 call. Retourne en parallèle population (Melodi),
  densités médecins/infirmiers/pharmaciens vs national, et count FINESS par
  famille (`labo`, `pharmacie`, `ehpad`, `mco`, `msp_cpts` par défaut).
  Granularité mixte explicite : `niveau: "commune"` pour population + PS,
  `niveauEtablissements: "departement" | "indisponible"` pour FINESS (le
  RPC `count_finess_by_commune` est différé en V0.9.1). Réduit la friction
  LLM de 7-10 calls séquentiels à 1.
- **`densite_professionnels_sante` au niveau commune** — paramètre
  `code_insee` alternatif et exclusif à `code_dept`. Le champ retour
  `zone.niveau: "departement" | "commune"` rend la granularité observable.
- **`count_rpps_by_commune` RPC** (migration `20260514T070000`) — brique
  SQL. EXECUTE format + custom plan, index `rpps_insee_idx` existant.
  Garde-fou sentinelle `EXISTS (SELECT 1 FROM rpps LIMIT 1)` → SQLSTATE
  P0002 si table vide (anti faux positif « désert médical » sur ingest
  cassé).
- **`ingest_refresh_matview(p_matview TEXT)` RPC** (migration
  `20260514T060000`) — SECURITY DEFINER + whitelist hardcoded. Permet le
  REFRESH CONCURRENTLY post-swap atomique des matviews RPPS sans accorder
  de DDL public au service_role.
- **`refreshRppsMatviews` post-swap dans `scripts/ingest/rpps.ts`** —
  refresh des 2 matviews RPPS après chaque ingest mensuel. `log.status =
  "partial"` en cas de fail, préservé jusqu'à `writeIngestLog`.
- **`isValidCodeInsee` + `assertValidCodeInsee`** dans
  `src/territoire/dept-codes.ts` — validation stricte des codes INSEE
  5 chars. Rejette les préfixes territoriaux fantaisistes (96, 99, 20xxx).
- **Helpers UX `api/_lib/args.ts`** : `normalizeAliases` (warn sur
  collision), `requireString` (distingue absent vs mauvais type),
  `requireOneOf`, `suggestParamError`.
- **Constantes centralisées `rpps-types.ts`** : `RPPS_PROFESSION` (codes
  TRE_R94), `RPPS_SAVOIR_FAIRE` (anti-drift SM02/SM04 historique).
- **`src/sante/sources.ts`** — `SOURCE_LABELS` centralisé pour les
  attributions sources.

### Modifié

- **`densite_professionnels_sante` tool MCP** — XOR `code_dept` /
  `code_insee`. Alias `dept`, `departement`, `codeInsee`, `insee` acceptés.
  Description enrichie avec exemples, mention limite Paris/Marseille/Lyon
  arrondissements, fix « SM04 » Cardiologie (SM02 = Anesthésie-réanimation).
- **`densite_etablissements_sante`, `population_par_commune`,
  `population_par_departement`, `get_commune_by_code`,
  `autocomplete_commune` tools MCP** — alias paramètres applicables,
  descriptions enrichies avec exemples, messages d'erreur suggestifs.
- **`densiteProfessionnelsSante` + `densiteEtablissementsSante`** (lib TS)
  — population introuvable Melodi → `RangeError` (mapping JSON-RPC -32602)
  au lieu de `Error` générique.
- **`buildRppsFilters` extrait** — factorise la shape filtres entre
  builders dept et commune dans `densite.ts`.
- **`parseFamilles` désormais utilisé** par `panorama_sante_territoire`
  handler — throw au lieu de filter silencieux.

### Fixed

- Régression silencieuse `log.status = "success"` écrasant « partial »
  posé par `refreshRppsMatviews` (chopped en /review Passe 1).
- Sentinelle « rpps vide » initialement basée sur `pg_class.reltuples`
  → faux positif post-swap (chopped en /review Passe 2) → remplacée
  par `EXISTS`.
- Drift documentaire SM02 = « Cardiologie » corrigé partout.

### Documentation

- README FR + EN : 30 → 31 tools (ajout panorama_sante_territoire).
- `docs/installation-claude.md` : drift « 24 tools V0.7.0 » corrigé.
- `docs/backlog.md` : items P0/P1 V0.9 cochés.

### Tests

- 642 → 725 tests verts (+83 nouveaux V0.9). tsc strict clean, Biome
  clean. 3 passes /review (1 simplify + 2 review) — GO unanime Passe 3.

## [0.8.3] — 2026-05-14

**Fix performance `count_rpps` — matview `rpps_count_stats` pré-agrégée.**

Sentry FRANCE-DATA-MCP-4 reproduit en prod V0.8.2 :
`densite_professionnels_sante({code_dept:"75", profession_code:"10",
compare_national:true})` → `count_rpps(p_dept=NULL, profession_code='10',
mode_exercice IN ('L','S','M'), categorie IN ('C','M'))` → COUNT(*)
France entière sur ~500 K médecins, heap visit pour filtrer mode + categorie
→ ~22 s, statement_timeout anon (3 s) cancel 57014.

V0.8.0 (RPC count_rpps initial) avait anticipé ça via EXECUTE format pour
forcer un custom plan côté dept précis, mais la branche France entière
(p_dept IS NULL) reste un seq scan + filtres : pas viable.

### Modifié

- **Migration `20260514T050000_matview_rpps_count_stats.sql`** :
  - `CREATE MATERIALIZED VIEW rpps_count_stats` agrégée par
    (code_departement, profession_code, savoir_faire_code, mode_exercice_code,
    categorie_code) → COUNT(*). ~50-100 K rows attendus. Peuplée
    immédiatement au CREATE (WITH DATA default Postgres) — pas de REFRESH
    inconditionnel après pour éviter le double peuplement au 1er run et
    le risque d'AccessExclusiveLock prod au replay.
  - `CREATE UNIQUE INDEX … NULLS NOT DISTINCT` (PG15+) requis pour REFRESH
    CONCURRENTLY future. Cohérent avec GROUP BY (NULL=NULL). Préfixe
    `(profession_code)` couvre déjà le pattern de filtre le plus commun
    → pas d'index secondaire dédié (matview ~50-100 K rows, index scan
    <50 ms quel que soit le combo).
  - `GRANT SELECT TO anon`.
  - `CREATE OR REPLACE FUNCTION count_rpps` réécrite : `SUM(count_ps)`
    sur la matview, plus besoin d'EXECUTE format ni de branchement
    dept précis vs France entière. Sémantique strictement identique à
    V0.8.0 (defaults DREES, gestion NULL, validation regex dept).
  - **`SET statement_timeout = '2s'`** clause sur la fonction (scope
    invocation, pas `SET LOCAL` qui aurait fuité sur la transaction
    englobante du caller) : fail-fast si la matview drift en cardinalité
    ou si un seq scan inattendu se déclenche (cible <50 ms, marge x40).
    Au-delà → erreur Sentry observable au lieu de dégrader silencieusement
    vers le timeout anon par défaut (3 s).
  - **Garde-fou matview vide** : `SELECT COUNT(*) INTO v_matview_total
    FROM rpps_count_stats` en début de fonction, `RAISE EXCEPTION P0002`
    si la matview est vide (REFRESH WITH NO DATA, GRANT SELECT cassé,
    rollback partiel). Évite le pattern V0.8.1 (mode_exercice 1/2/3 vs
    L/S/M → 0 silencieux toute la France). Sentinelle <1 ms (PK index).

### Notes opérationnelles

- **Perf attendue** : <50 ms quel que soit le pattern de filtre
  (dept précis, France entière, combinaisons arbitraires) vs ~22 s en V0.8.2.
- **Matview figée jusqu'à REFRESH explicite** — même trade-off que
  `rpps_savoir_faire_stats` (V0.8.2). Au déploiement V0.8.3 : `CREATE`
  peuple immédiatement, aucune action manuelle requise.
- **TODO V0.8.4** : intégrer `REFRESH MATERIALIZED VIEW CONCURRENTLY
  rpps_count_stats` ET `rpps_savoir_faire_stats` dans
  `scripts/ingest/rpps.ts` post-swap atomique pour refresh mensuel
  automatique. Backporter aussi la suppression du REFRESH inconditionnel
  de `20260514T040000_matview_rpps_savoir_faire.sql` (gaspillage
  négligeable ~250 rows mais même risque rejeu).
- **Tests TS inchangés** : la signature TS de `countRpps` (rpps-db.ts:280)
  ne change pas. 642 tests existants doivent rester verts.
- **Dette docs notée hors scope** : `README.en.md` ligne 80 mentionne
  encore "v0.7.7" + "25 tools" alors qu'on est à V0.8.3 / 30 tools.
  À synchroniser au prochain passage docs.

## [0.7.5] — 2026-05-13

**Smithery quick win #2 : outputSchema sur 22 tools + structuredContent.**

Spec MCP 2025-06-18 §6.3 : `outputSchema` permet aux clients de type-check
les réponses et de mieux grounder un LLM consommateur. Score Smithery
attendu : +10.37pt (80 → 90+/100).

### Ajouté

- **6 patterns JSON Schema réutilisables** déclarés en tête `api/tools.ts` :
  - `LOOKUP_RESULT_OUTPUT_SCHEMA` : discriminé par `found`. `required: ["found", "lookupStatus"]`
    (validé contre `src/core/lookup-result.ts` qui garantit l'invariant).
  - `QUERY_RESULT_OUTPUT_SCHEMA` : `{count, results, truncated?, query_metadata?, freshness?}`.
    `truncated` optional (les tools de listing exhaustif `lister_*_ameli` ne le mettent pas).
  - `DINUM_QUERY_OUTPUT_SCHEMA` : shape native DINUM `{total, page, perPage, totalPages, entreprises, fallback?}`.
    Schema dédié car le handler `entreprises_in_radius` expose la pagination DINUM telle quelle (pas de normalisation `count/results`).
  - `COVERAGE_OUTPUT_SCHEMA` : audit de couverture FINESS vs SIRENE avec
    `coverage_ratio` nullable (zone rurale + NAF rare → `sirene_sirets === 0` → ratio non calculable).
  - `DATA_FRESHNESS_OUTPUT_SCHEMA` : tous les fields runtime-nullable typés `["string" | "number", "null"]`
    (1er déploiement → aucun succès enregistré, signal alarmant à propager au caller).
- **22 outputSchema assignments** sur les 25 tools : 9 LOOKUP, 11 QUERY (dont 2 lister_*),
  1 DINUM_QUERY, 1 COVERAGE, 1 DATA_FRESHNESS. Les 3 tools spec-violating
  (`autocomplete_commune` array-root, `geocode_adresse` / `reverse_geocode` nullable)
  n'ont volontairement pas d'outputSchema : spec MCP exige `type: "object"` littéral au root
  et un schema invalide ferait planter les clients stricts (Inspector v0.10+).
- **`structuredContent` dans `tools/call` response** (`api/mcp.ts`) : émis quand
  `tool.outputSchema` est défini ET result est un object non-array non-null. Permet
  aux clients MCP modernes (Inspector, Claude Desktop récent) de valider la réponse
  contre le schema déclaré.
- **Type `McpTool.outputSchema?: Record<string, unknown>`** : optional, non-breaking
  pour les tools sans schema.
- **`lookupStatus`** ajouté manuellement aux 3 branches de `professionnel_by_rpps`
  (le tool a des champs custom `source`/`fhir`/`ans_fhir_status` incompatibles avec
  les helpers `lookupFound`/`lookupNotFound` generic). Conforme au `LOOKUP_RESULT_OUTPUT_SCHEMA`
  qui requiert `lookupStatus`.

### Tests

- **606 tests verts** (603 → 606, +3 régressions outputSchema declarations).
- 3 nouveaux tests dans `api/tools.test.ts` : (1) 22 tools ont outputSchema,
  (2) 3 tools spec-violating n'ont volontairement pas d'outputSchema,
  (3) chaque outputSchema déclaré a `type: "object"`.

### Discipline post-fix

- `/review` pass 1 (3 agents code-simplifier + code-reviewer + silent-failure-hunter) →
  **NO-GO COMMIT** initial avec 8 findings :
  - 2 CRITICAL (ARRAY_RESULT viole spec, mapping QUERY_RESULT faux sur 4 tools)
  - 4 HIGH (DATA_FRESHNESS non-nullable, OBJECT_RESULT ne couvre pas null,
    DINUM/COVERAGE shape mismatch, structuredContent absent)
  - 2 MEDIUM (LOOKUP.lookupStatus required, JSDoc trompeurs)
- 8 fixes appliqués + 6 nouveaux schemas/refactors créés.
- `/review` pass 2 (2 agents) → **VERDICT GO COMMIT** après 5 fixes additionnels
  (professionnel_by_rpps lookupStatus, COVERAGE.coverage_ratio nullable,
  retrait OBJECT_OR_NULL_OUTPUT_SCHEMA dead code, retrait outputSchema sur 2 tools
  nullable, garde structuredContent stricte).

### Backlog V0.7.6+

- **Wrapper `professionnel_by_rpps` via `lookupFound`/`lookupNotFound`** (au lieu
  d'ajouter `lookupStatus` manuellement). Demande d'étendre `lookupNotFound` pour
  accepter des champs custom (`source`, `ans_fhir_status`). Cohérence avec les
  12 autres LOOKUP tools.
- **Tests E2E `structuredContent`** : ajouter dans `api/mcp.test.ts` (à créer)
  un test qui vérifie que `tools/call` émet `structuredContent` quand
  `outputSchema` déclaré, et ne l'émet pas pour `autocomplete_commune`.

## [0.7.4] — 2026-05-13

**Smithery quick wins : annotations MCP, descriptions params, doc Corse, icon.**

Améliorations distribution/discoverability post-V0.7.3 pour pousser le quality
score Smithery (72 → cible 88+/100, badge Verified).

### Ajouté

- **Annotations MCP sur les 25 tools** (spec 2025-06-18 §6.2) : `readOnlyHint: true`,
  `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` sur 24
  tools. `data_freshness` reçoit la variante `idempotentHint: false` (sa réponse
  contient `staleness_days` qui varie dans le temps). 2 constantes
  `READ_ONLY_IDEMPOTENT_ANNOTATIONS` et `READ_ONLY_TIME_VARYING_ANNOTATIONS`
  (la 2e spread la 1re + override) factorisent les valeurs.
- **Type `McpToolAnnotations` strict** : 5 propriétés exactes de la spec
  (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
  au lieu de `Record<string, boolean>` qui aurait accepté un typo silencieusement.
  Convention CLAUDE.md "TypeScript strict, jamais `any`" appliquée.
- **Forward annotations dans `tools/list`** : `api/mcp.ts` map les annotations
  via spread conditionnel `...(t.annotations ? { annotations: t.annotations } : {})`
  (omet la clé si absente, conforme spec).
- **3 icon variations** dans `branding/icons/` (drapeau FR + caducée, hexagone +
  croix, lettermark FD) générées via nano-banana pro 2K. Pour upload Smithery
  + profile GitHub.

### Modifié

- **14 descriptions params ajoutées** sur `professionnels_rpps_in_radius` et
  `professionnels_rpps_par_dept` (center, radius_km, profession_codes,
  savoir_faire_codes, mode_exercice_codes, limit, offset).
- **Doc Corse harmonisée** sur les 4 tools qui prennent un `departement` :
  `professionnels_par_specialite_dept`, `professionnels_rpps_par_dept`,
  `rpps_search_by_name`, `etablissements_finess_by_categorie`. Wording uniforme
  `"Code département INSEE (ex: '75', '2A', '2B', '971'). Métropole 2 caractères
  (Corse '2A'/'2B', pas '20'), DOM/TOM 3 caractères."` — évite que les LLM
  clients passent `"20"` et obtiennent silencieusement 0 résultat sur la Corse.

### Discipline post-fix

- `/simplify` 3 agents + `/review` pass 1 3 agents → 4 findings appliqués
  (type strict, DRY constantes, doc Corse `rpps_search_by_name`, propagation
  doc Corse 3 autres tools).
- `/review` pass 2 2 agents → **VERDICT GO COMMIT**.
- 603 tests verts, tsc clean.

## [0.7.3] — 2026-05-13

**Hardening error handling : RangeError → -32602, Sentry bot-noise filter,
stubs MCP `resources/list` + `prompts/list`.**

Réagit à 2 events Sentry observés en prod post-V0.7.2 :

- **FRANCE-DATA-MCP-2** : `searchCommunes` (et ~24 autres validators caller-fault)
  throwaient `Error` standard, mappés en JSON-RPC `-32603 internal_error` avec
  capture Sentry parasite, alors que l'input invalide est une faute caller
  (`-32602 bad_request`).
- **FRANCE-DATA-MCP-1** : bot scanner JSON-RPC malformé tombe dans le catch
  root → Sentry-flood récurrent dès qu'un scanner balaye l'endpoint.

### Ajouté

- **`requireLonLatStrict(args)`** (`api/tools.ts`) : nouveau helper qui factorise
  l'extraction `lon`/`lat` via `coerceNumber` (rejet strict des inputs non-numériques)
  + throw `RangeError` si absent. Appliqué aux 2 handlers `etablissements_finess_in_radius`
  et `professionnels_in_radius`. `reverse_geocode` garde sa sémantique laxiste
  `Number() + Number.isFinite()` (documenté dans la JSDoc).
- **`isBotNoiseEvent(event)`** + **`beforeSendEvent(event)`** + **`sanitizeEventHeaders(event)`**
  exportés dans `api/_lib/sentry.ts`. Pipeline `beforeSend` :
  1. Drop si `tags['mcp.method'] === 'handler_root'` ET message matche
     `BOT_NOISE_PATTERNS` (6 entrées : `Cannot read prop`, `Cannot destructure prop`,
     `Cannot convert undefined or null`, `is not iterable`, `is not a function`,
     `Unexpected token`).
  2. `console.warn` distinctif au drop (observabilité Vercel JSON logs, anomaly
     detection possible via grep `bot-noise event`).
  3. Sinon, sanitize headers via clone immutable (pas de mutation in-place).
- **`SENSITIVE_HEADER_NAMES`** : 9 headers droppés (OWASP + infra Vercel/AWS) :
  `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`,
  `x-csrf-token`, `x-xsrf-token`, `x-amz-security-token`, `x-vercel-protection-bypass`.
  Match case-insensitive.
- **Stubs MCP `resources/list`** → `{ resources: [] }` et **`prompts/list`** →
  `{ prompts: [] }`. Déclarés dans `initialize.capabilities` aux côtés de `tools`
  (`listChanged: false`). Supprime les warnings Smithery ranker + les `-32601`
  côté clients qui sondent ces capacités après initialize.

### Modifié

- **24 validators caller-fault** : `throw new Error` → `throw new RangeError`.
  Sites : `src/territoire/communes.ts:95` (FRANCE-DATA-MCP-2 root cause),
  `src/sante/dinum.ts` (5 sites `searchEntreprises` + `getEntrepriseBySiren`),
  `src/sante/finess.ts:134` (`searchEtablissementsFiness`), `src/sante/finess-db.ts:142`
  (`getFinessByNumFiness` via `assertValidNumFiness` réutilisé), `api/tools.ts`
  (~16 sites : `parseFamilles` 2×, `parseStringArray` 3×, handlers 11×).
- **`getFinessByNumFiness`** utilise désormais `assertValidNumFiness` (helper
  shared dans `db-helpers.ts`, déjà adopté par `cross-source.ts`). Élimine la
  régex dupliquée + bonus `.trim()` sur l'input. Message d'erreur uniforme.
- **`sanitizeEventHeaders`** retourne maintenant un clone (spread `{ ...event, request: {...} }`)
  au lieu de muter l'event d'entrée. Idempotent si appelé plusieurs fois par Sentry SDK.
- **`initialize.capabilities`** : ajout de `resources: { listChanged: false }`
  et `prompts: { listChanged: false }`. Si une vraie ressource/prompt est
  ajoutée plus tard, basculer `listChanged: true` (spec MCP).

### Tests

- 603 tests verts (598 → 603, +5 nets). Nouveaux :
  - `sentry.test.ts` : tests `isBotNoiseEvent` (6 patterns + edge cases),
    `beforeSendEvent` pipeline (drop, log warn, immutability, sanitize),
    `SENSITIVE_HEADER_NAMES` coverage (proxy/csrf/cloud auth + case-insensitive).
  - Régressions RangeError sur `searchCommunes`, `searchEntreprises`,
    `getEntrepriseBySiren`, `getFinessByNumFiness`.
- `tsc` clean sur `tsconfig.json` + `tsconfig.api.json`.

### Discipline post-fix appliquée

- **`/simplify`** (3 agents reuse/quality/efficiency) → 7 findings appliqués :
  `assertValidNumFiness` réutilisé, `requireLonLatStrict` factorisé, patterns
  étendus (3 ajoutés), immutability clone, log warn drop, em-dashes corrigés
  (5 sites), JSDoc trompeur retiré.
- **`/review` pass 1** (3 agents) → 4 findings appliqués : JSDoc orpheline
  (`categorieCodesFromArgs` qui flottait au-dessus de `requireLonLatStrict`),
  `SENSITIVE_HEADER_NAMES` élargi de 3 → 9 entrées (OWASP + Vercel + AWS),
  commentaire `beforeSend` redondant retiré, test redondant `sans tags` supprimé.
- **`/review` pass 2** (2 agents) → **VERDICT GO COMMIT**. 6 nits LOW
  backloguées V0.7.4 (log warn truncate, chained exceptions, `nextCursor` stubs,
  pattern `Unexpected end of JSON input`, audit `coerceNumber` RangeError).

## [0.7.2] — 2026-05-12

**Sentry error monitoring + wrapper npm `france-data-mcp` + sanitization
credentials.**

- Sentry `@sentry/node` 10.x sur l'endpoint MCP public. Capture des 500
  internes uniquement (pas de tracing). No-op transparent si `SENTRY_DSN`
  absent. Helper `reportInternalError` centralise console.error + emit +
  capture sur 4 callsites. Try/finally global pour `flushSentry`, catch root
  pour exceptions hors-boucle (invariant "100% des 500 capturés").
- Wrapper npm `bin/cli.ts` forwarde stdio NDJSON → endpoint HTTPS Vercel
  pour les clients MCP qui ne supportent pas HTTP distant (Claude Desktop).
  `npx france-data-mcp`. Override `FRANCE_DATA_MCP_URL` pour miroir privé.
- Source de vérité unique pour la version : `src/core/version.ts`.
- `sanitizeReason(reason)` : redact des credentials dans les messages d'erreur
  fetch (Node 22 TypeError contient l'URL userinfo complète).
- 586 tests verts (525 → 586, +61).

## [0.7.1] — 2026-05-12

**Fallback INSEE multi-sites + optimisation rate limit reconcilier**

### Ajouté

- **`lookupSiretsBySirenViaInsee(siren)`** dans `src/sante/insee-sirene.ts` :
  nouveau helper qui interroge l'endpoint de recherche SIRENE V3.11
  `GET /siret?q=siren:{siren}&nombre=1000`. Retourne
  `LookupResult<{ etablissements: EtablissementSireneDetail[] }>`. No-op
  gracieux sans clé INSEE (not_found avec message). 404 → not_found.
  401/5xx/timeout → throw (cohérent convention V0.6.x). Signal
  `console.warn` si `header.total > 1000` (pagination V0.7.2 backlogée).
- **`toEtablissementSireneDetail`** exportée (était privée) pour réutilisation
  par le nouveau helper sans duplication du mapper.
- **`SiretCandidate.raison_sociale_ul: string | null`** : nouveau champ
  optionnel sur l'interface `SiretCandidate` (non-breaking). Populé depuis
  `nomComplet` DINUM ou `raisonSocialeUniteLegale` fallback INSEE. Permet à
  `reconcilierFinessSirene` d'éviter des appels `/siret/{siret}` redondants.
- **P2.2 — Tool MCP `finess_sirene_coverage_in_radius`** (25e tool du serveur) :
  compare la couverture du référentiel FINESS DREES (sites physiques agréés)
  au référentiel SIRENE DINUM (SIRET physiques actifs au NAF cible) dans un
  rayon géographique. Résout le biais méthodologique où comparer N sites FINESS
  à M unités légales DINUM était mathématiquement incohérent. Algorithme :
  `getFinessInRadius` → `reverseGeocode` → département → `searchEntreprises` →
  `getEntrepriseBySiren` (cap `maxUnitesLegales`, Promise.allSettled) → filtre
  Haversine SIRET physiques actifs du NAF cible → matching greedy Dice ≥ 0.7.
  Retourne `coverage_ratio`, `matched_count`, `finess_only_count`,
  `sirene_only_count`, samples top 10 par catégorie, `methodology` LLM-friendly
  et `caveats[]` (discipline zéro overclaim). Nouveaux fichiers :
  `src/sante/coverage.ts` (module métier) + `src/sante/coverage.test.ts`.

### Modifié

- **`resolveSiretsForFiness`** (`src/sante/siret-resolver.ts`) : après le
  `Promise.allSettled` DINUM, fallback automatique `lookupSiretsBySirenViaInsee`
  pour les SIREN dont `enrichmentStatus === "partial"` UNIQUEMENT. Les
  établissements INSEE sont mergés via `mergeOrInsertDinumCandidate`. Erreurs
  de fallback collectées dans `dinum_errors` avec status discriminé
  (`rejected` / `not_found` / `config_missing`) et mention `insee_fallback` —
  pas de propagation d'exception (graceful degradation). Pour
  `enrichmentStatus === "failed"` : pas de fallback INSEE (rate limit), mais
  une entrée `dinum_errors` avec status `enrichment_failed` est poussée pour
  signaler au caller que le siège seul est listé alors qu'un retry serait
  justifié (discipline observabilité — pas de panne DINUM silencieuse).
- **`DinumLookupError["status"]`** étendu : ajout de `"config_missing"` (clé
  INSEE absente — distinct de `not_found` qui signifie "vrai SIREN absent
  SIRENE") et `"enrichment_failed"` (DINUM second appel KO — retry second
  appel justifié, distinct de `rejected` = premier appel KO).
- **`formatDinumDiag`** (`src/sante/cross-source.ts`) : discrimination des
  préfixes — `⚠ DINUM erreurs` pour `rejected` / `not_found` / `ambiguous` /
  `enrichment_failed` (vrais incidents data) vs `⚠ Config serveur` pour
  `config_missing` (problème admin déploiement, pas une absence de donnée).
- **`mergeOrInsertDinumCandidate`** : paramètre `nomComplet: string | null`
  ajouté (défaut `null` — non-breaking). Popule `raison_sociale_ul` sur le
  candidat inséré ou enrichi.
- **`reconcilierFinessSirene`** (`src/sante/cross-source.ts`) : séparation en
  deux branches avant les appels INSEE. `dinumEnriched` (candidats avec
  `raison_sociale_ul !== null` et `adresse_libelle !== null`) : scores calculés
  directement depuis DINUM, zéro appel `/siret/{siret}`. `inseeRequired`
  (candidats RPPS-only) : comportement V0.7.0 préservé. Économie ~÷5 sur le
  rate limit INSEE 30/min sur les FINESS multi-sites.

### Tests

- 40 nouveaux tests unitaires (525 → 565 verts) :
  - `insee-sirene.test.ts` : 7 tests `lookupSiretsBySirenViaInsee`
    (no-op, URL/header, 404, 5xx throw, 200 liste, réponse vide, warn >1000)
  - `cross-source.test.ts` : 4 tests fix V0.7.1 (pin Biogroup Bd Bizet,
    pas de fallback si success, not_found gracieux, 5xx gracieux) + 3 tests
    P2.3 (all DINUM-enriched zéro INSEE, mixed 1 appel, all RPPS-only préservé)
  - `coverage.test.ts` (P2.2) : 5 tests (cas heureux 3F/3S, FINESS vide,
    SIRENE vide, truncated maxUL=2, dinum_errors rejected sans crash)

### Cas reproductible corrigé

`verifier_site_actif("590048997")` (Biogroup Bd Bizet, fermé 2024-02-16)
retournait `verdict_site: "indetermine"` car DINUM retournait `partial` pour
ce SIREN 38 sites et ne listait que le siège actif. Retourne désormais
`verdict_site: "ferme"` + `best_match.siret = "50781594200218"`.

## [0.7.0] — 2026-05-11

**Pivot SIRET élargi + dual verdict site/groupe + discipline observabilité — breaking**

Refonte des helpers cross-source pour capter les **SIRET fermés invisibles
côté DREES** (cas reproductible : FINESS 590048997 LABORATOIRE SECONDAIRE
DIAGNOVIE BD BIZET, fermé SIRENE depuis 2024-02-16 mais toujours actif DREES).
La cascade RPPS → DINUM + scoring d'adresse Dice ramène désormais TOUS les
SIRET du SIREN parent et identifie le SIRET physique du site, pas juste le
SIRET du siège employeur déclaré par les PS.

Bug critique corrigé sur l'API SIRENE V3.11 `/siret/` : `raisonSocialeUniteLegale`
retournait le SIREN brut au lieu du nom (ex: "267500452" au lieu d'"AP-HP",
"301160750" au lieu de "CLINEA"). Le mapper cherchait dans
`uniteLegale.periodesUniteLegale[]` qui n'existe que sur l'endpoint `/siren/`,
pas `/siret/` (qui expose les champs à plat). Touchait `etablissement_by_siret`
et tous les helpers cross-source. Régression test couvre les 2 shapes
(personnes morales + entrepreneurs individuels).

### Ajouté

- **`src/sante/siret-resolver.ts`** : nouveau module qui résout les SIRET
  candidats pour un FINESS via cascade RPPS → DINUM. Expose
  `SiretResolution` avec `candidates` enrichis (score adresse + état actif +
  source `rpps` / `dinum_address_match`), `best_match` (= SIRET physique le
  plus probable, threshold 0.6), `sirens_explored`, `sirens_actif`,
  `dinum_errors` (`rejected` / `not_found` / `ambiguous`).
- **`src/sante/address-match.ts`** : primitives partagées
  `diceCoefficient` + `normalizeForCompare` (NFD + lowercase + ponctuation
  + collapse whitespace) + `buildFinessAdresseLibelle`. Élimine la
  divergence d'algo entre cross-source et siret-resolver.
- **`src/core/freshness.ts`** : helper `withFreshness(result, includeFreshness,
  sources)` qui injecte `data_freshness` (filtré par sources) dans le payload
  quand `include_freshness: true`. Graceful degradation : si
  `getDataFreshness` throw, injecte `data_freshness_error` sans casser le tool.
- **`include_freshness: boolean` (default false)** opt-in sur **12 tools**
  FINESS / RPPS / Ameli : `etablissements_finess_in_radius`,
  `etablissements_finess_by_categorie`, `etablissement_by_finess`,
  `professionnels_in_radius`, `professionnels_par_specialite_dept`,
  `lister_specialites_ameli`, `lister_types_ps_ameli`,
  `professionnels_rpps_in_radius`, `professionnels_rpps_par_dept`,
  `rpps_dans_etablissement`, `rpps_search_by_name`, `professionnel_by_rpps`
  (uniquement sur path `source: "db"`).
- Régression tests : 3 nouveaux scénarios `verifierSiteActif` (cas Bd Bizet
  fermé / site actif / address no-match), 3 tests `historiqueEtablissement`
  / `reconcilierFinessSirene` sur `status: all_sirene_failed` vs
  `all_sirene_not_found` vs propagation `dinum_errors`. 7 tests pour
  `lookupPractitionerByRpps` discriminated result, 3 tests pour la vraie
  shape SIRENE V3.11 `/siret/` à plat.

### Modifié — **BREAKING**

- **`verifierSiteActif`** retourne désormais `{ candidates, best_match,
  sirens_explored, dinum_errors, verdict_site, verdict_groupe, explication }`
  au lieu de `{ siret_candidates, verdict, explication }`. Les
  `VerdictSite` / `VerdictGroupe` sont distincts (`actif` / `ferme` /
  `indetermine`) — un site peut être fermé tandis que son groupe (SIREN)
  reste actif. L'ancien `VerifierVerdict` (6 valeurs) est supprimé.
- **`historiqueEtablissement`** ajoute `dinum_errors` + `status`
  (`success` / `partial` / `all_sirene_failed` / `all_sirene_not_found`).
  Pivot SIRET élargi via le resolver — capture les SIRET fermés invisibles
  côté RPPS.
- **`reconcilierFinessSirene`** ajoute `dinum_errors` + `status` aligné sur
  `historiqueEtablissement`. Pivot SIRET élargi.
- **`lookupPractitionerByRpps`** retourne désormais un
  `AnsFhirLookupResult` discriminé (`{ found: true, practitioner }` ou
  `{ found: false, status: "no_key" | "invalid_format" | "not_found" |
  "api_error", message }`) au lieu de `AnsFhirPractitioner | null`.
  Le caller distingue désormais "clé absente" / "format rejeté" / "PS
  absent ANS" / "panne ANS" — avant V0.7.0, les 4 cas renvoyaient `null`
  indifféremment, ce qui mentait au caller LLM (`api_error` ressemblait à
  `not_found`). Handler MCP `professionnel_by_rpps` propage le `status`
  dans le payload `ans_fhir_status`.

### Corrigé

- **SIRENE V3.11 `/siret/` mapper** : `pickUniteLegaleFields` gère les 2
  shapes de `uniteLegale` (champs à plat sur `/siret/`, dans
  `periodesUniteLegale[]` sur `/siren/`). Avant : `raisonSocialeUniteLegale`
  retournait le SIREN brut sur tout SIRET requêté. Bug confirmé sur 3
  catégories non-bio (AP-HP hôpital public, CLINEA cliniques privées,
  ARPAVIE EHPAD associatif).
- **`withFreshness`** ne fait plus crasher un tool entier si le freshness
  lookup `getDataFreshness` throw (ingest_log down / RLS broken /
  network) — injecte `data_freshness_error` et préserve la donnée métier.
- **`siret-resolver`** log `console.warn` + status discriminé
  (`rejected` / `not_found` / `ambiguous`) sur tout lookup DINUM échoué.
  Avant : les `not_found` étaient silencieusement absorbés dans le
  `dinum_errors` array sans `console.error`, masquant les dégradations
  systémiques en prod.
- **Explication `verifier_site_actif`** : suffix `dinumDiag` injecté dans
  TOUTES les branches (avant : seulement quand `verdict_site === "indetermine"`),
  pour que le caller voit toujours qu'un SIREN a échoué même si le site
  est confirmé actif/fermé.

### Supprimé

- `VerifierVerdict` (6 valeurs `indetermine_pas_de_siret` /
  `indetermine_pas_de_cle_insee` / etc.) — remplacé par les deux
  `VerdictSite` / `VerdictGroupe` orthogonaux.
- `SiretVerification` (helper interne de l'ancien shape) — remplacé par
  `SiretCandidate` du resolver.
- `diceCoefficient` exporté de `cross-source.ts` — déplacé vers
  `address-match.ts` (export public préservé).

## [0.6.2] — 2026-05-11

**Croisement multi-source FINESS ↔ RPPS ↔ SIRENE — 3 nouveaux tools de réconciliation**

Cette version conclut le cycle V0.6 (7 nouveaux tools ajoutés en cumulé) en
livrant les primitives de croisement multi-source. Détecte les divergences
factuelles entre référentiels FINESS DREES (bimestriel), RPPS / Annuaire
Santé ANS (mensuel) et SIRENE INSEE V3.11 (live). Aucune interprétation
métier : les tools renvoient les faits, le caller décide.

### Ajouté

- **`compare_raison_sociale_finess_vs_rpps(num_finess)`** : compare la raison
  sociale FINESS DREES vs RPPS / Annuaire Santé ANS pour un même `num_finess`.
  Retourne `exact_match` / `divergent_after_normalization` / `rpps_absent`.
  Utile pour détecter les rebrandings post-M&A que FINESS n'a pas encore
  propagés. Pas d'interprétation : le tool ne dit pas qui a racheté qui.
- **`historique_etablissement(num_finess)`** : reconstitue la timeline
  complète (toutes les périodes administratives) d'un établissement via
  SIRENE INSEE V3.11 pour chaque SIRET candidat trouvé en RPPS. Permet
  d'identifier la date de fermeture exacte d'un SIRET encore listé actif
  côté FINESS, ou de comprendre une cascade de rebrandings via les
  changements de `enseigne1Etablissement`.
- **`reconcilier_finess_sirene(num_finess)`** : calcule un score de cohérence
  Sørensen-Dice (sur bigrammes) entre FINESS DREES et SIRENE pour chaque
  SIRET candidat. Trois sous-scores (nom 0.5, adresse 0.4, téléphone 0.1)
  + verdict brut `match` (≥0.8) / `partial` (0.5..0.8) / `mismatch` (<0.5).
  Algorithme public (Sørensen-Dice depuis 1948), aucune valeur propriétaire.
  Le champ `skipped[]` expose les SIRET qu'on n'a pas pu réconcilier
  (lookup SIRENE rejected ou not_found) avec la raison.
- **`lookupSiretHistoriqueViaInsee(siret)`** côté lib : variante de
  `lookupSiretViaInsee` qui retourne en plus les `periodes` historiques
  triées chronologiquement (timeline complète actif/fermé/NAF/enseigne).

### Modifié

- Boucles de lookup INSEE parallélisées via `Promise.allSettled` dans
  `verifierSiteActif` / `historiqueEtablissement` / `reconcilierFinessSirene` :
  p99 latency divisée par N (typiquement N ≤ 3 SIRET candidats).
- Helper `assertValidNumFiness` factorisé dans `src/sante/db-helpers.ts`
  (élimine 4 duplications du regex `/^\d{9}$/` côté cross-source).
- 5 handlers MCP cross-source : `throw new Error` → `throw new RangeError`
  pour input manquant (cohérence convention JSON-RPC -32602).

## [0.6.1] — 2026-05-11

**`data_freshness` + `verifier_site_actif` : observabilité fraîcheur dump + détection SIRET fermé**

Réponse à un besoin évident : un agent LLM ne peut pas juger de la fiabilité
d'un résultat sans savoir QUAND la dernière ingestion s'est terminée. Et
FINESS DREES garde parfois actifs des SIRET fermés depuis 1-2 mois côté
SIRENE — il fallait un tool pour trancher.

### Ajouté

- **`data_freshness`** : retourne pour chaque source DB-backed (FINESS, Ameli,
  RPPS) le `last_success_at` ISO, `last_success_row_count`, `last_attempt_at`,
  `staleness_days`, `cadence_hint`. Cache mémoire 5 min côté serveur pour ne
  pas marteler `ingest_log` à chaque appel MCP. Helper `getDataFreshness()`
  dans `src/storage/ingest-log.ts`.
- **`verifier_site_actif(num_finess)`** : croise FINESS DREES ↔ RPPS
  (pivot SIRET) ↔ SIRENE INSEE V3.11. Verdict consolidé `actif` / `ferme` /
  `indetermine_pas_de_siret` / `indetermine_pas_de_cle_insee` /
  `indetermine_insee_unreachable` / `indetermine_sirene_partiel`. Quand
  `num_finess` est absent de FINESS DREES, retourne `LookupResult.not_found`.
  Helper `verifierSiteActif()` dans `src/sante/cross-source.ts` (nouveau
  module dédié au croisement multi-source, brick par brick).

## [0.6.0] — 2026-05-11

**`etablissement_by_siret` + `rpps_search_by_name` : 2 primitives de lookup manquantes**

L'audit de la couverture des tools a révélé 2 manques évidents : pas de
lookup unitaire par SIRET (alors qu'on l'a par SIREN et par num_finess), et
pas de recherche RPPS par identité (alors qu'on a radius, dept+spécialité,
et par FINESS). Comble.

### Ajouté

- **`etablissement_by_siret(siret)`** : lookup SIRET via SIRENE INSEE V3.11
  (`/siret/<siret>`). Retourne `LookupResult<EtablissementSireneDetail>`
  avec raison sociale unité légale, enseigne, NAF, dates création/fermeture,
  statut actif, adresse complète, tranche d'effectif. Pas de coords (endpoint
  INSEE ne les renvoie pas — géocoder côté caller via `geocode_adresse`).
  Si `INSEE_SIRENE_API_KEY` non configurée, retourne `not_found` avec message
  orienté config plutôt que de throw.
- **`rpps_search_by_name(nom, prenom?, departement?)`** : recherche fuzzy
  trigram (pg_trgm) sur la table RPPS. Score `match_score` ∈ [0..1] dans
  chaque résultat. Default catégorie `[C]` (Civil seul, cohérent avec les
  3 autres tools RPPS) ; flags `include_etudiants` + `include_agents_publics`
  pour étendre. Migration `supabase/migrations/20260511T100000_rpps_search_by_name.sql`
  ajoute extension `pg_trgm`, index GIN trigram sur `lower(nom)` et
  `lower(prenom)`, et RPC `rpps_search_by_name(p_nom, p_prenom, p_departement,
  p_categorie_codes, p_limit)`.

## [0.5.8] — 2026-05-11

**Hotfix : crash `Cannot read properties of null (reading 'replace')`**

Bug bloquant introduit silencieusement : l'API DINUM renvoie `null` (pas
`undefined`) pour les coordonnées GPS quand un établissement n'est pas
géocodé. Le helper `parseLooseNumber` ne distinguait pas les deux cas, et
crashait sur le `.replace(",", ".")`. Symptômes observés en prod : crash
sur `naf="8690B" + q="biogroup"` et sur `q="eurofins"` seul.

### Corrigé

- `parseLooseNumber` dans `src/core/coords.ts` accepte maintenant `null`
  en plus de `undefined`. Le type d'input devient `string | number | null
  | undefined` pour refléter la réalité runtime de l'API DINUM.
- Type `ApiSiege.latitude`/`longitude` dans `src/sante/dinum.ts` ajusté
  pour autoriser `null` (alignement TS/runtime).
- 8 tests de régression dans `src/core/coords.test.ts` (nouveau fichier).

## [0.5.7] — 2026-05-11

**Garde-fous publics : rate limit + observabilité structurée sur l'endpoint MCP**

Avant cette version, `https://france-data-mcp.vercel.app/mcp` était totalement
ouvert et sans logging structuré. Un scraper agressif (ou un bot d'indexation
mal configuré) pouvait faire exploser la facture Vercel/Supabase, et il n'y
avait aucun moyen de distinguer trafic humain vs trafic bot dans les logs ops.
Cette version pose les fondations minimales avant le lancement public
(Smithery + listings MCP).

### Ajouté
- **Rate limit 60 req/min par IP sur `tools/call`** (`api/_lib/rate-limit.ts`).
  Backend principal : Upstash Redis sliding window via REST (latence ~50 ms
  depuis Vercel Frankfurt). Fallback in-memory `Map<string, bucket>` cappé à
  10 000 IPs distinctes par instance chaude — déclenché si les env Upstash
  sont absentes OU si l'appel Upstash throw. Politique fail-open documentée :
  un blip Redis ne casse pas l'endpoint pour tous les users.
- **Logging JSON structuré par requête** (`api/_lib/observability.ts`).
  Une ligne par sous-requête JSON-RPC avec `ts`, `component`, `method`, `tool`,
  `ip_hash`, `user_agent`, `duration_ms`, `status`, `outcome` (union fermé
  `success | rate_limited | not_found | bad_request | internal_error`) et
  `extra` (champs custom). Niveau auto via `levelFromStatus()` : ≥500 →
  `console.error`, ≥400 → `console.warn`, sinon `console.log`. Vercel logs
  capture stdout/stderr ; chaque ligne JSON est aggregable jq/BigQuery/Datadog.
- **Variables d'env (toutes optionnelles)** dans `.env.example` :
  `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
  `RATE_LIMIT_PER_MINUTE` (default 60), `RATE_LIMIT_ENABLED` (default true,
  `false` désactive complètement pour dev local).
- **Émission d'event sur HTTP 405 / 400 early reject** : un client mal
  configuré (GET ou POST vide) apparaît désormais dans les logs structurés
  avec `outcome: "bad_request"`. Permet d'agréger le bruit côté ops et de
  détecter un DoS log-silent.
- **`scripts/smoke-mcp.ts`** : smoke test local du handler MCP (handshake +
  rate limit + batch JSON-RPC partiel). Exécutable via
  `pnpm exec tsx scripts/smoke-mcp.ts`.
- 31 tests unitaires : `api/_lib/rate-limit.test.ts` (16 tests : extractIp
  anti-spoofing, hashIp stable, getRateLimitPerMinute, checkRateLimit
  désactivé/in-memory), `api/_lib/observability.test.ts` (15 tests :
  extractUserAgent, format payload, niveau de log, protection canoniques,
  serialize-safe sur objet circulaire).

### Sécurité
- **CRITICAL `extractIp` anti-spoofing** — le réflexe naïf est de prendre le
  premier segment de `x-forwarded-for`, mais ce header est trivialement
  spoofable côté client (Vercel APPEND la vraie IP edge en queue, pas en
  tête). Implémentation finale : prioriser `x-real-ip` (single-value posé
  par l'edge Vercel, non-spoofable), fallback sur le DERNIER segment non
  vide de `x-forwarded-for`, fallback final `socket.remoteAddress`. Test
  explicite : `x-forwarded-for: "1.1.1.1, 203.0.113.42"` → on prend bien
  `203.0.113.42`.
- **`extra` ne peut écraser AUCUN champ canonique** — le spread de
  `event.extra` est placé AVANT les champs canoniques (`ts`, `component`,
  `method`, `tool`, `ip_hash`, `user_agent`, `duration_ms`, `status`,
  `outcome`) dans le payload final. Garantie testée : un caller malveillant
  ne peut pas envoyer `extra: { status: 999, outcome: "spoofed" }` pour
  polluer les agrégations ops.
- **IP hashée SHA-256 tronquée 16 chars** avant tout log/stockage Redis
  (zéro IP en clair persistée, RGPD-friendly).

### Robustesse
- **Throttle log Upstash par signature d'erreur** — un outage Upstash 1 h
  émettrait normalement des centaines de milliers de lignes
  `console.error` (1 par tools/call rate-limité). On limite à 1 ligne par
  minute PAR SIGNATURE d'erreur (`Map<string, number>`) : si l'erreur passe
  de `ECONNRESET` (blip réseau) à `WRONGPASS` (token révoqué), le second
  mode loggue immédiatement plutôt que d'être masqué par le throttle du
  premier.
- **`serializeSafe` pour `JSON.stringify(payload)`** — si `extra` contient
  un objet circulaire (Error avec `cause` self-référencée, par ex.), on
  émet un payload dégradé (champs canoniques seuls + `log_serialize_error`)
  plutôt que de throw et perdre toute la ligne.
- **Guard `tool.handler() === undefined`** — `JSON.stringify(undefined)`
  retourne la string `"undefined"` (pas un JSON valide), qui passait
  silencieusement au client MCP comme `text: undefined`. Désormais retourne
  `-32603 Tool X returned no value` + log `outcome: "internal_error"`.
- **Distinction `malformed_request` vs `unknown`** dans le batch loop catch
  — permet d'isoler les payloads cassés (request null ou non-objet) des
  pannes internes.

### Architecture
- **Rate limit appliqué UNIQUEMENT sur `tools/call`** — les méthodes meta
  `initialize`, `tools/list`, `ping`, `notifications/initialized` restent
  libres. Sinon le handshake MCP casse pour les clients qui
  re-`tools/list` souvent (Claude Desktop refresh périodique, Cursor reload,
  etc.). Le rate limit existe pour protéger les ressources Supabase, pas
  le handshake stateless.
- **Helper `emit()` unifié** dans `api/mcp.ts` — un seul site de log par
  sous-requête JSON-RPC (vs 8 invocations dupliquées avant
  refactorisation), garantit `durationMs`/`ipHash`/`userAgent` toujours
  présents.

### Modifié
- `api/mcp.ts` : branchement rate limit + logging, refactor `emit()`,
  `extractIp`/`hashIp`/`extractUserAgent` posés en `ctx` une fois par
  requête HTTP, cascade `isClientError` → `if/else` explicite.
- `package.json` : ajout deps `@upstash/ratelimit ^2.0.8`,
  `@upstash/redis ^1.38.0`.
- `.env.example` : documentation des 4 nouvelles variables d'env Upstash /
  rate limit.

### Notes opérationnelles
- Sans `UPSTASH_REDIS_REST_*` configurés en prod Vercel, le rate limit tombe
  sur le fallback in-memory : protège les bursts dans une instance chaude
  unique, **pas les flood distribués sur plusieurs instances serverless en
  parallèle**. Recommandation forte : créer une base Upstash gratuite
  (Frankfurt eu-west-1) et configurer les 2 env vars avant le lancement
  public.
- Aucun argument tool n'est loggé par défaut (sécurité). Pour activer pour
  debug ponctuel, créer un flag `LOG_TOOL_ARGS=true` plutôt que de l'activer
  en dur.
- 429/429 tests verts (398 unit + 31 nouveaux rate-limit/observability),
  tsc clean, Biome clean.

## [0.5.6] — 2026-05-10

**Canary RPPS — remplacement des 3 IDNPS placeholder par des référents stables**

Les 3 IDNPS placeholder seedés en V0.5.0 (`81000964799`, `00000000001`,
`99999999999`) faisaient remonter `canary missing: …` à chaque run d'ingestion
RPPS — ils étaient intentionnellement choisis pour ne pas matcher (sentinel),
en attendant une migration corrective post-1er-run prod. Cette migration les
remplace par 3 IDNPS référents identifiés en prod le 2026-05-10 via le serveur
MCP france-data-mcp lui-même.

### Critères de sélection
- **Couverture géographique** : 1 PS Paris (75), 1 PS Aix-en-Provence (13),
  1 PS DOM Réunion (974). Permet de détecter une régression d'ingestion
  ciblée sur un seul périmètre géographique (ex: parser cassé sur un format
  d'adresse DOM).
- **Couverture professionnelle** : 1 Médecin (code 10), 1 Infirmier (code 60),
  1 Pharmacien (code 21) — les 3 plus grosses populations RPPS.
- **Stabilité** : tous rattachés à des structures établies (CHU public, CH
  intercommunal, officine titulaire) — probabilité de radiation faible sur
  l'horizon de vie de la migration.
- **Catégorie** : Civil (`C`) pour les 3, aligné sur le default V0.5.5 du
  filtre `categorieCodes`. Sourcing d'un PS Agent public (`M`) backloggé —
  aucun candidat trouvé via le sample MCP du 2026-05-10.

### Modifié
- `supabase/migrations/20260510T050000_rpps_canary_seeds_v056.sql` : INSERT
  des 3 référents EN PREMIER puis DELETE des 3 placeholders V0.5.0 (ordre
  inversé pour éliminer toute fenêtre où la table `ingest_canary_targets`
  serait vide pour `source='rpps'` et où `check_ingest_canary` retournerait
  silencieusement `[]`). Bloc DO + RAISE NOTICE/WARNING pour traçabilité
  dans les logs Supabase (`purged % rows, expected 0 or 3`).
- `src/sante/rpps-db.ts` : regex `getRppsById` `/^\d{11}$/` → `/^\d{11,12}$/`
  pour accepter le format IDNPS moderne (12 chars avec préfixe `81` Type
  d'identifiant PP) ET legacy (11 chars). **Bug pré-existant V0.5.0 → V0.5.5
  révélé par V0.5.6** : tous les vrais IDs en base font 12 chars, donc le
  tool MCP `professionnel_by_rpps` throw RangeError sur tout vrai ID. Aucun
  test ne couvrait ce path d'où l'invisibilité.
- `api/tools.ts` : pattern JSON Schema `^\\s*\\d{11}\\s*$` →
  `^\\s*\\d{11,12}\\s*$`, descriptions et messages d'erreur alignés
  (« 11 ou 12 chiffres »).
- `src/sante/ans-fhir.ts` : doc IDNPS « 11 chars » → « 11 ou 12 chars ».

### Ajouté
- `src/sante/rpps-db.test.ts` : 7 nouveaux cas Vitest verrouillant
  (a) le format des 3 IDNPS canary V0.5.6 via parse migration SQL,
  (b) l'ordre INSERT-puis-DELETE de la migration,
  (c) le contrat regex `getRppsById` (11 ET 12 chars acceptés, 10 et
  13 chars rejetés, trim whitespace).

## [0.5.5] — 2026-05-10

**Correction nomenclature catégorie professionnelle RPPS — alignée sur ANS TRE_R09**

V0.5.0 → V0.5.4 documentaient et exposaient des codes catégorie fictifs
(`R` Retraité, `S` Suspendu, `D` Décédé) hérités d'une projection ADELI
historique jamais vérifiée contre la source officielle. Validation empirique
post-1er-run V0.5.1 (10 mai 2026, `SELECT GROUP BY` sur `rpps`) : la base ne
contient que **3 codes** (`C` Civil ~97,2 %, `E` Étudiant ~2,5 %, `M` Agent
public ~0,3 %). La nomenclature ANS officielle [TRE_R09](https://mos.esante.gouv.fr/NOS/TRE_R09-CategorieProfessionnelle/)
confirme : 4 codes au total, dont `F` (« Fonctionnaire d'État ou de
collectivité locale ») déprécié 2026-02-23 et fusionné dans `M`. Et le
fichier ANS `PS_LibreAcces_Personne_activite` est pré-filtré aux PS actifs
à la source (cf. DSFT v3.1 §5.1.2) — aucun retraité, suspendu, radié ou
décédé n'a jamais été en base. La notion d'« inactif » que portait V0.5.x
n'existait donc pas dans cette extraction.

### Breaking change MCP
- Param `include_inactifs: boolean` retiré des 3 tools RPPS query
  (`professionnels_rpps_in_radius`, `professionnels_rpps_par_dept`,
  `rpps_dans_etablissement`).
- Remplacé par 2 flags granulaires :
  - `include_etudiants: boolean = false` — ajoute le code `E` au filtre
    (internes, externes, élèves IDE/SF).
  - `include_agents_publics: boolean = false` — ajoute le code `M` au
    filtre (PH titulaires, médecins militaires SSA, médecins inspecteurs
    ARS, médecins conseils CNAM, médecins scolaires, médecins PMI).
- Default = `[C]` Civil seul (libéraux + salariés privés + hospitaliers
  contractuels). Ancien default V0.5.x = `[C, M]` mélangeait droit privé
  et fonction publique sans flag possible pour dissocier.

### Modifié
- `src/sante/rpps-db.ts` :
  - Constantes `CATEGORIE_CODES_ACTIFS` / `CATEGORIE_CODES_TOUS_STATUTS`
    supprimées.
  - Nouveaux exports `CATEGORIE_CODE_CIVIL`, `CATEGORIE_CODE_ETUDIANT`,
    `CATEGORIE_CODE_AGENT_PUBLIC`, `CATEGORIE_CODES_OFFICIELS`,
    `CATEGORIE_CODES_DEFAUT`.
  - Nouvelle fonction publique `buildCategorieCodes({ includeEtudiants,
    includeAgentsPublics })` — source unique pour la traduction flags MCP →
    array SQL, consommée par les 3 handlers tools.
- `api/tools.ts` : descriptions tools réécrites avec la vraie nomenclature
  (libellé `M` = Agent public, pas Militaire) et un lien vers la table de
  référence ANS. Hint partagé `RPPS_INCLUDE_CATEGORIES_HINT`.
- Mig `20260510T040000_rpps_v055_categorie_codes_default_civil.sql` :
  - `rpps_categorie_match` : default cardinality=0 → `IN ('C')` au lieu de
    `IN ('C','M')`. `OR IS NULL` conservé en défense.
  - `rpps_par_specialite_dept` (V0.5.4 EXECUTE format) : default interne
    `COALESCE(NULLIF(...), ARRAY['C'])` au lieu de `ARRAY['C','M']`. Aucune
    autre modif (signature inchangée, performance V0.5.4 préservée).
- README.md / README.en.md : nouvelle table « Filtre catégorie
  professionnelle (V0.5.5) » avec les 3 codes officiels, leurs périmètres
  et leur volumétrie observée. Mention explicite : la base est pré-filtrée
  aux PS actifs à la source ANS.

### Ajouté
- `src/sante/rpps-db.test.ts` : 8 cas Vitest unit pour les nouvelles
  constantes et `buildCategorieCodes`. Verrouille le contrat (default
  Civils, jamais d'array vide, codes fictifs R/S/D rejetés, code F
  déprécié rejeté).

### Garde-fou runtime contre l'ancien flag
Pour éviter qu'un caller V0.5.4 (ou un cache LLM tools/list désynchronisé)
continue de passer `include_inactifs` et reçoive silencieusement un
sous-ensemble (`[C]` au lieu de `[C, M]` historique), `categorieCodesFromArgs`
throw un `RangeError` explicite si le flag est présent — mappé en JSON-RPC
`-32602` côté `api/mcp.ts`, message guidant vers le mapping nouveaux flags.
Test `api/tools.test.ts > categorieCodesFromArgs > rejette explicitement le
legacy include_inactifs` verrouille ce contrat.

### Pourquoi pas d'alias silencieux
On est en `0.x` OSS, le serveur MCP est utilisé par une poignée de
testeurs early-stage. Garder `include_inactifs` en alias aurait perpétué
l'erreur d'abstraction (« inactif » n'existant pas dans cette extraction)
et empêché les LLMs callers d'apprendre les nouveaux noms de flags.

## [0.5.4] — 2026-05-10

**Hotfix perf #3 — `EXECUTE format` pour contourner le plan generic PostgREST**

V0.5.3 (index couvrant) résolvait le problème en EXPLAIN ANALYZE direct
(39 ms) mais pas via PostgREST (8 937 ms mean → timeout 57014). Diagnostic
via `pg_stat_statements` : PostgREST wrappe la query dans un pattern
`json_to_record LATERAL rpc(...)` qui empêche le planner de voir
`p_departement` au planning time → plan generic biaisé. Détail technique
dans la migration `20260510T030000`.

### Corrigé
- Mig `20260510T030000_rpps_par_specialite_dept_execute_format.sql` : RPC
  réécrite en `LANGUAGE plpgsql STABLE` avec `EXECUTE format($q$ ...
  WHERE r.code_departement = %L::CHAR(3) ... $q$, p_departement)`.
- Le `%L` interpole `p_departement` comme literal SQL → le planner voit
  `r.code_departement = '75'::CHAR(3)` et utilise les MCV de pg_stats
  pour estimer correctement la sélectivité → custom plan optimal à
  chaque appel → Index Scan sur `rpps_dept_insee_sort_idx` (V0.5.3).
- Garde `length(p_departement) NOT IN (2, 3)` (V0.5.1) maintenue en
  defense-in-depth pour les callers PostgREST directs.
- Test live confirmé : dept 75 = 786 ms, dept 13 = 523 ms, dept 08 =
  504 ms (pas de régression sparse), dept 75 + filtre profession =
  579 ms. Tous OK.

Trade-off : `LANGUAGE plpgsql` au lieu de `sql` → fonction non-inlinable
(Function Scan dans le plan parent). C'est OK car le `EXECUTE format`
force un plan custom à chaque appel, ce qui contourne précisément le
problème PostgREST. Coût planning ~0,1 ms par appel, négligeable.

## [0.5.3] — 2026-05-10

**Hotfix perf #2 — index composite couvrant `(code_departement, code_insee, nom, prenom, id)`**

La V0.5.2 (`LANGUAGE sql STABLE` inlinable) n'a pas suffi : smoke test live a
confirmé l'inlining (pas de `Function Scan` dans le plan) mais le planner
choisit toujours `rpps_insee_idx` (Presorted Key sur code_insee) → Index
Scan stream qui filtre 100K+ rows avant d'atteindre LIMIT 50 → timeout 57014
sur dept 75/13. Cas classique de "wrong index ORDER BY + LIMIT" documenté
par pganalyze (Tom Lane confirme que les stats Postgres ne suffisent pas
encore pour détecter ce pattern, état mai 2026).

### Corrigé
- Mig `20260510T020000_rpps_dept_insee_covering_idx.sql` :
  - Nouvel index `rpps_dept_insee_sort_idx (code_departement, code_insee,
    nom, prenom, id)` sur la table prod (effet immédiat). `CREATE INDEX`
    bloquant — pas `CONCURRENTLY` (Supabase migrations en transaction
    interdit CONCURRENTLY, cf migrations 000015/000019 précédentes).
  - Redéfinition de `ingest_create_rpps_staging` pour mirroir l'index
    sur la table staging. Sans cette mise à jour, le prochain cron RPPS
    (5 du mois) aurait recréé `rpps_staging` SANS l'index, swap atomic
    → l'index aurait été renommé en `rpps_previous_dept_insee_sort_idx`
    (perdu côté prod) → retour au timeout.
  - `COMMENT ON INDEX` documentant la finalité pour traçabilité future.
- Diagnostic comparatif via EXPLAIN ANALYZE en transaction (ROLLBACK final) :
  - Index complet → **13 ms** (Index Scan + early termination LIMIT 50)
  - Index minimal `(dept, insee)` → 3360 ms (doit lire 76K rows pour
    resorter nom/prenom/id en top-N heapsort)
  - Sans index nouveau → timeout 15s/57014
- Trade-off accepté : ~80 MB stockage sur 2,2 M rows = 1,4 % du quota
  Supabase. Solution plus robuste qu'un trick `ORDER BY + 0` ou
  `WITH MATERIALIZED` (pas de matérialisation explicite à chaque appel).
- Audit cross-tables (FINESS, Ameli) : indexes prod ↔ staging restent en
  sync, aucune dette.

## [0.5.2] — 2026-05-10

**Hotfix perf — `rpps_par_specialite_dept` réécrit en `LANGUAGE sql STABLE`**

Smoke test live post-V0.5.1 a confirmé que dept 75 et 13 timeoutent à 15s
malgré la mitigation `statement_timeout = '15s'`. Root cause : `LANGUAGE
plpgsql STABLE` empêche l'inlining et bascule sur un plan generic après
5 appels (default PG ≥ 12 `plan_cache_mode=auto`), qui choisit l'index
`rpps_insee_idx` (presorted key) et stream-filter ~120K rows au lieu d'un
bitmap scan sur `rpps_dept_categorie_idx`.

### Corrigé
- Mig `20260510T010000_rpps_par_specialite_dept_sql_inline.sql` : RPC
  réécrite en `LANGUAGE sql STABLE` sans clause `SET search_path` (Postgres
  bloque l'inlining quand `proconfig IS NOT NULL`, cf
  `inline_set_returning_function`). PostGIS étant installé dans `public`,
  pas de qualification nécessaire pour `ST_AsGeoJSON`.
- Plan désormais re-calculé à chaque appel avec les vrais params → bitmap
  index scan + top-N heapsort → dept 75/13 < 100 ms (vs timeout 15s).
- `RESET statement_timeout` annule le filet 15s de la V0.5.1 (devenu
  inutile).
- Caller TS `getRppsParSpecialiteDept` (`src/sante/rpps-db.ts`) résout
  désormais le default `categorieCodes` côté client (`CATEGORIE_CODES_ACTIFS
  = ["C","M"]`) — la nouvelle RPC SQL exige une liste non-vide pour rester
  inlinable. Comportement sémantiquement identique pour les callers MCP
  normaux. Effet de bord : un caller PostgREST direct passant `[]` recevra
  0 rows au lieu des actifs implicites (conforme à la sémantique
  `ANY(empty array) = false` de Postgres).

## [0.5.1] — 2026-05-09

**Hotfix RPPS — récupère les ~970 K PS skippés par V0.5.0**

(+77 % de couverture ingérée vs V0.5.0). Le 1er run V0.5.0
(run GH `25607546400`) avait skippé 43 % des PS car le parser exigeait une
adresse de structure matchée sur l'index commune INSEE — exactement la
valeur ajoutée du RPPS vs Ameli (étudiants, retraités, salariés CH/CHU sans
adresse site, libéraux à domicile).

### Corrigé après les 1ers runs V0.5.1
- Retry schema-cache miss étendu à `PGRST204` (column not found) en plus de
  `PGRST205` (table not found). Le 1er run V0.5.1 (run GH 25611048725) a fail
  à 33s sur la colonne `geom_source` fraîchement ajoutée — PostgREST n'avait
  pas encore propagé le `NOTIFY 'reload schema'` au moment du 1er INSERT. Les
  2 codes signalent le même phénomène, le retry exponentiel les couvre tous
  les deux désormais.
- `statement_timeout` étendu à 10 min sur `ingest_atomic_swap` (mig
  `20260509T220000_atomic_swap_extended_timeout.sql`). Le 2e run (GH
  25611148383) a tout réussi côté pipeline (2,23 M rows ingérées, 391 K
  matched FINESS, geo coverage 74,13 %) mais le swap atomic a fail au
  timeout 60s default — DDL (RENAME table + 14 RENAME INDEX en cascade) sur
  2,23 M rows avec geog GIST gigantesque dépasse le timeout. Scope limité
  à la fonction (les autres RPCs gardent 60s).
- `rpps_par_specialite_dept` perf fix (mig
  `20260510T000000_rpps_par_specialite_dept_perf_fix.sql`). 3 facteurs
  cumulés diagnostiqués au smoke test des 17 tools MCP : (1) mismatch type
  CHAR(3) vs param TEXT cassait l'usage de l'index B-tree dept (seq scan
  2,2 M rows) → fix var locale typée `CHAR(3)` ; (2) helper
  `rpps_categorie_match($codes)` empêchait l'évaluation au planning
  (`cardinality($codes) = 0` runtime) → fix 2 branches plpgsql avec filtre
  catégorie inliné comme literal ; (3) plan generic plpgsql STABLE refuse
  d'utiliser l'index optimal même avec les fixes 1 et 2 → mitigation
  pragmatique `statement_timeout = '15s'` scope local. **Cette mitigation
  ne tient pas en charge dept dense — superseded par V0.5.2.**
- Garde anti-truncation côté SQL sur `p_departement` : `::CHAR(3)` truncate
  silencieusement "0758" → "075". `RAISE EXCEPTION` si `length` ∉ {2, 3} pour
  defense en profondeur (le caller TS valide déjà via `assertValidDept` mais
  un caller direct PostgREST passerait outre). **Garde reportée dans la
  V0.5.2 ?** Non : la nouvelle RPC `LANGUAGE sql` n'autorise pas `RAISE
  EXCEPTION`. La validation reste donc côté caller TS uniquement.

### Refactor parser
- Skip uniquement `no_identity` (rpps_id vide ou nom/prénom manquant).
- Tous les autres PS insérés, avec `geom NULL` si pas de match commune et
  `code_departement` dérivé du code postal quand possible (helper
  `deriveDeptFromCp` — métropole 2-chars, DOM 3-chars 971-978, COM 984-988,
  Corse 20xxx → NULL car ambigu 2A/2B sans la commune).
- Volumétrie cible : **~2,0-2,2 M rows ingérées** (vs 1,27 M en V0.5.0).
- Thresholds recalibrés : `MIN_ROWS=2_000_000`, `MAX_ROWS=2_400_000`,
  `STRUCTURAL_FAIL_THRESHOLD=0.01` (couvre uniquement no_identity).

### Enrichissement post-INSERT via JOIN FINESS
- Nouvelle RPC `ingest_apply_rpps_finess_enrichment_batch(p_limit)` —
  LEFT JOIN sur `finess.num_finess` + CASE WHEN qui pose `geom_source =
  'finess_join'` (avec coords FINESS) ou `'finess_unmatched'` (sentinelle qui
  sort la row du predicate du prochain scan). Pattern boucle batched mirror
  de `ingest_apply_finess_geom_batch` (V0.4.2).
- Helper TS partagé `runBatchedRpc(supabase, rpc, params, expected, batch)`
  extrait dans `scripts/ingest/shared.ts` — déduplique le pattern boucle
  utilisé aussi par finess.ts.
- Index partiel `rpps_staging_pending_enrichment_idx WHERE geom IS NULL AND
  num_finess IS NOT NULL AND geom_source IS NULL` pour rester en O(p_limit)
  par batch malgré 970 K rows éligibles.
- 2 sentinelles defense en profondeur :
  1. Throw si `enrichedCount === 0 && initialNoGeo > 0` (régression totale
     du JOIN, indépendant du sample size).
  2. Throw si `initialNoGeo >= 1000 && matchRate < 10 %` (régression
     partielle — bruit du ratio absorbé sous le sample min).
- Filet final `geoRate < 25 %` reste en place (FLOOR catastrophe).

### Filtre catégorie professionnelle
- Nouveau param `p_categorie_codes TEXT[]` sur les 3 RPCs query
  (`rpps_in_radius`, `rpps_par_specialite_dept`, `rpps_dans_etablissement`).
- Helper SQL `rpps_categorie_match(code, codes)` — source unique pour la
  sémantique : `cardinality = 0 → C, M, IS NULL` (default actifs) ;
  `cardinality > 0 → ANY(codes) OR IS NULL`.
- Nouveau param MCP `include_inactifs: boolean` (default `false`). Description
  enrichie : « Par défaut, ne renvoie que les PS en activité (Civil C +
  Militaire M). Passer `include_inactifs: true` pour inclure aussi
  Retraité (R), Étudiant (E), Suspendu (S), Décédé (D). »
- `coerceBoolean(args.include_inactifs)` — accepte aussi `"true"` / `"1"`,
  throw `RangeError` (mappé `-32602`) sur valeur ambiguë.
- Indexes composites `rpps_categorie_idx` + `rpps_dept_categorie_idx`
  (mirror sur staging) pour la perf des filters dept dense.

### Migration SQL `20260509T210000_rpps_v051_relax_constraints`
- `ALTER TABLE rpps ALTER code_departement DROP NOT NULL` (idem staging DDL).
- `ADD COLUMN geom_source TEXT` (rpps + staging).
- DDL staging recréé en superset strict (les colonnes/indexes manquants au
  swap atomic seraient silencieusement perdus).
- Field `categorie` ajouté au shape `RppsResult` (déplacé depuis
  `RppsLookupResult` qui le redéfinissait — anti-duplication).

### Discipline post-fix
- `pnpm test:unit` : **374 tests verts** (16 nouveaux cas RPPS, 10 nouveaux cas
  `deriveDeptFromCp`).
- `pnpm typecheck` clean (tsconfig + tsconfig.api).
- `pnpm lint` clean (Biome).
- `/simplify` (3 agents standalone) + `/review` LOOP 4 rounds (3 agents
  pr-review-toolkit) jusqu'à CONVERGENT.

## [0.5.0] — 2026-05-09

**Phase 2 RPPS / Annuaire Santé ANS** — la pièce qui complète le triangle de
couverture santé. Là où Ameli ne couvre que les libéraux conventionnés (~462 K),
RPPS couvre **tous les PS** : libéraux + salariés (hospitaliers, salariés en
LBM/cabinet) + remplaçants + retraités inscrits. Volume : ~2,23 M lignes.
Apporte aussi un identifiant national stable (`rpps_id` / IDNPS) qui permet
le pivot PS↔FINESS (lien `num_finess` exposé sur chaque row).

### 🆕 4 nouveaux tools MCP

- `professionnels_rpps_in_radius` — recherche dans un rayon, filtres par
  profession (nomenclature ANS), savoir-faire (DES/DESC), mode d'exercice
  (libéral / salarié / mixte / remplaçant / volontariat).
- `professionnels_rpps_par_dept` — listing départemental + pagination via
  `offset`. Préférer Ameli pour les libéraux conventionnés ; cet outil sert
  surtout à compter ou lister les salariés / l'effectif total.
- `rpps_dans_etablissement` — **killer feature** qui répond enfin à
  *"qui travaille dans ce labo / hôpital / clinique ?"*. Filtre indexé sur
  `num_finess`, retourne tous les PS rattachés (libéraux vacataires +
  salariés). Couverture salariés CH/CHU/cliniques excellente.
- `professionnel_by_rpps` — fiche par identifiant national (11 chars). Si non
  trouvé en base locale (snapshot mensuel J-30 max), tente automatiquement
  un **fallback live FHIR ANS** (`gateway.api.esante.gouv.fr/fhir/v2`).
  Le champ `source` distingue `db` / `ans_fhir`.

Total tools MCP exposés : **17** (V0.4.6 = 13 + 4 RPPS).

### Pipeline d'ingestion mensuel

- Source : data.gouv `annuaire-sante-extractions-...-rpps`, fichier
  `ps-libreacces-personne-activite.txt` (~803 Mo, ~2,23 M lignes, Licence
  Ouverte v2.0). MAJ mensuelle côté ANS.
- Cron : `0 4 5 * *` UTC (le 5 du mois — laisse le temps à ANS de publier
  l'extract autour du 1er-3 sans cogner FINESS / Ameli).
- Pipeline ETL réutilise les patterns FINESS/Ameli : SHA256 short-circuit,
  threshold parsedCoordRejected, atomic swap, canary post-swap, threshold
  unmatched-locality (8%) + structural-fail (1%).
- Format : pipe-delimited (`|`), UTF-8. BATCH_SIZE 1000 (vs 500 Ameli) pour
  économiser ~2200 round-trips Supabase sur les 2,23M rows.
- Géocodage : centroïde commune (comme Ameli). Le caller peut enrichir vers
  une coord adresse en croisant le `num_finess` exposé avec
  `etablissement_by_finess`.

### Fallback FHIR ANS live

- Nouveau module `src/sante/ans-fhir.ts`. Pattern miroir de `insee-sirene.ts`
  (V0.4.5) : header `ESANTE-API-KEY`, no-op gracieux sans clé, log différencié
  404 (warn) vs 401/403/5xx (error), timeout 60s avec AbortController.
- Endpoint : `GET /Practitioner?identifier=urn:oid:1.2.250.1.71.4.2.1|<rpps_id>`.
- Nouvelle env var **optionnelle** `ANS_FHIR_API_KEY` (UUID gratuit obtenu via
  inscription Gravitee sur portal.api.esante.gouv.fr).
- API publique en libre accès depuis avril 2025, pas de quota documenté
  pendant la bêta — limites annoncées « après fin 2025 ».

### Migration SQL

- Table `rpps` (BIGSERIAL PK, 28 colonnes incluant `rpps_id` indexé,
  `num_finess` indexé, `mode_exercice_code` indexé, geog GENERATED).
- 4 RPCs : `rpps_in_radius`, `rpps_par_specialite_dept`, `rpps_dans_etablissement`,
  `rpps_lookup_by_id`. SECURITY INVOKER (anon read uniquement).
- 1 RPC SECURITY DEFINER : `ingest_create_rpps_staging` (pattern Ameli/FINESS).

### Discipline post-fix

- 24 nouveaux tests unitaires (12 ans-fhir + 12 parser RPPS).
- **362 tests verts** au total (hors integration qui requièrent Supabase Local).
- tsc clean (tsconfig.json + tsconfig.api.json).
- 1 helper ajouté `getUntypedAnonClient()` (pendant côté read du
  `getUntypedServiceClient` ingest existant) — utilisé temporairement par
  `rpps-db.ts` en attendant la régénération de `Database` types post-merge.

### Volumétrie projetée

- DB Supabase : ~480 MB FINESS+Ameli aujourd'hui → ~930 MB après RPPS
  (~450 MB ajoutés). Marge confortable sur Pro tier 8 GB.
- Coût d'ingestion : ~15-25 min/run mensuel.

## [0.4.6] — 2026-05-09

Patch post-test live V0.4.5 (claude.ai a relancé les 13 tools, 7/10 ✅,
1 ❌ B3, 2 ⚠️ contrat).

### B3 — UPDATE SQL one-shot sur les données prod existantes

Le `collapseWhitespace` ajouté en V0.4.4 vit dans le parser d'ingestion ;
les ~93K rows déjà en table `finess` (ingérées avant V0.4.4) gardaient
leurs doubles espaces. Audit : **2493 rows polluées** sur 93403 (2.7%) —
2201 `raison_sociale` + 301 `voie`. UPDATE appliqué :

```sql
UPDATE finess
SET raison_sociale = regexp_replace(trim(raison_sociale), '\s+', ' ', 'g'),
    ville = regexp_replace(trim(ville), '\s+', ' ', 'g'),
    voie = regexp_replace(trim(voie), '\s+', ' ', 'g')
WHERE raison_sociale ~ '\s{2,}' OR ville ~ '\s{2,}' OR voie ~ '\s{2,}';
```

Vérification post-UPDATE : 0 row polluée, BIO ARD'AISNE 4 sites tous propres
(`"LBM BIO ARD'AISNE"`). Idempotent (regex ne match plus après application),
appliqué en prod via MCP Supabase. Le fix V0.4.4 côté parser garantit que
les futures ingestions n'ont plus le problème.

### `siren_source: "dinum"` par défaut sur retour DINUM

Avant V0.4.6, le champ `siren_source` n'était émis que sur le path fallback
INSEE V3 (`"insee_v3"`). Le caller MCP ne pouvait pas distinguer "DINUM a
répondu" de "champ pas implémenté" → retour ambigu. Maintenant le contrat
est cohérent : **toujours présent**, valeur explicite (`"dinum"` ou
`"insee_v3"`).

## [0.4.5] — 2026-05-09

Correctif d'auth INSEE SIRENE découvert post-merge V0.4.4 : le portail INSEE
moderne (`portail-api.insee.fr`) expose une simple **clé API UUID** par
défaut, PAS un flux OAuth2 client_credentials. La V0.4.4 partait sur OAuth2,
incompatible avec les clés effectivement émises par le portail.

### Auth INSEE SIRENE V3.11 — refactor majeur

- **Une seule variable d'env** `INSEE_SIRENE_API_KEY` (UUID issu du portail
  INSEE, plan « api key »). Remplace les 2 vars OAuth2 V0.4.4
  (`INSEE_SIRENE_CLIENT_ID` + `INSEE_SIRENE_CLIENT_SECRET`).
- **Header HTTP** `X-INSEE-Api-Key-Integration` (custom Gravitee côté INSEE,
  vérifié 2026-05-09 — `Authorization: Bearer`, `apikey:`,
  `X-Gravitee-Api-Key:` retournent tous 401).
- **1 seul appel HTTP par lookup** au lieu de 2 (suppression du round-trip
  `/token` OAuth2). Latence p99 divisée par 2 sur le path nominal.
- **Suppression du cache token** module-level (`tokenCache`,
  `getInseeBearerToken`, `__resetInseeTokenCacheForTesting`,
  `TOKEN_REFRESH_MARGIN_MS`, `FALLBACK_TOKEN_TTL_SEC`) — ~90 LOC retirées.
- **Mapping V3.11 corrigé** : les champs métier (`denominationUniteLegale`,
  `nomUniteLegale`, `activitePrincipaleUniteLegale`,
  `etatAdministratifUniteLegale`, `categorieJuridiqueUniteLegale`) vivent
  dans `uniteLegale.periodesUniteLegale[0]` (la **période courante**, pas
  directement sur `uniteLegale`). V0.4.4 lisait à plat → mapping silencieux
  sur `null`. Vérifié live sur SIREN 787120435 (BIO ARD'AISNE).
- **Sélection de la période courante** par `dateFin === null` plutôt que
  l'index `[0]` aveugle, avec fallback sur `[0]` + `console.warn` si aucune
  période ouverte (cas dégénéré : entreprise cessée, données historiques).
- **Strip guillemets** dans `getInseeApiKey()` : certains parsers `.env`
  conservent les quotes entourantes, ce qui faisait échouer l'auth en 401.
- **Log différencié** : `console.warn` sur 404 (outcome attendu — SIREN
  vraiment absent de SIRENE), `console.error` sur 401/403/5xx/network
  (vrais incidents). Évite de polluer les dashboards Sentry/Vercel.
- **Rate limit INSEE** : 30 req/min documenté dans la JSDoc — `fetchJson`
  retry sur 429 mais sérialise. Le fallback est conçu comme ponctuel (~1%
  des SIREN), pas comme source primaire.

### ⚠️ Breaking — surface lib npm

Exports retirés depuis `src/sante/index.ts` :
- `getInseeSirenCredentials` → remplacé par `getInseeApiKey` (différente
  signature : retour `string | null` au lieu de `{clientId, clientSecret} | null`)
- `getInseeBearerToken` → supprimé (plus de token endpoint)
- `__resetInseeTokenCacheForTesting` → supprimé (plus de cache)
- type `InseeSireneCredentials` → supprimé (remplacé par retour `string`)

La surface MCP (tools côté serveur) est identique à V0.4.4 — seuls les
callers TS qui importaient ces helpers depuis la lib npm sont impactés.

### Tests

338 tests verts (+ 20 nouveaux insee-sirene, dont fake timers sur les 2 tests
retry pour ramener le wall-clock CI de 14.8s à 6.4s ; +6 tests strip
guillemets paramétrés via `it.each` + sélection période courante par
`dateFin === null`).

### Fix cosmétique post-déploiement

`format_count_human(BIGINT)` retournait `"7.K"` au lieu de `"7.0K"` quand
la décimale arrondie était 0 (`to_char(..., 'FM999D9')` strippe les zéros
trailing avec `FM`). Remplacé par `round(..., 1)::TEXT`, déterministe et
locale-indépendant. Validé live sur prod après application de la migration.

## [0.4.4] — 2026-05-09

Audit Claude.ai sur les 13 tools MCP : 4 bugs identifiés (B3/B5/B6/B7) +
2 garde-fous d'observabilité ingestion + 1 fallback API live (SIRENE INSEE V3).

### Tools MCP

- **`entreprises_in_radius`** : `perPage` propagé dans le fallback
  `naf + lat/lon/radius` (validation stricte 1–25, RangeError sinon). Sans
  cela, `perPage: 3` retournait jusqu'à 25 résultats post-filtre Haversine.
- **`lister_specialites_ameli`** : 2 nouvelles colonnes `libelle_clarifie`
  (désambiguïsation des libellés partagés calculée en SQL via sous-requête
  scalaire `COUNT(DISTINCT code)`) et `is_libelle_partage`. Format compact
  via le helper SQL `format_count_human` (sortie stable indépendante du
  `lc_numeric` de session). Robuste à un nouveau code dupliqué Ameli.

### Données ingérées

- **FINESS `raison_sociale` / `ville` / `voie`** : `collapseWhitespace`
  appliqué à l'ingestion (DREES émet parfois des doubles espaces qui
  produisent des doublons logiques côté equality matching).

### Type lib npm

- `Finance.caFiable: boolean` exposé sur les retours DINUM. `false` quand
  `ca === 0 && resultatNet > 0` (pattern observé à 100% sur les SELARL
  pharma 47.73Z qui ne déclarent pas leur CA au RNE). Vraie dormance reste
  `caFiable: true`.
- Nouveau type `EntrepriseSirenSource = "dinum" | "insee_v3"` (champ
  `Entreprise.siren_source`).

### Fallback API live — SIRENE INSEE V3.11

Nouveau module `src/sante/insee-sirene.ts` : quand DINUM
`recherche-entreprises.api.gouv.fr` ne connaît pas un SIREN (statut
diffusion partielle), `getEntrepriseBySiren` tente automatiquement un
lookup via SIRENE INSEE V3.11. No-op gracieux si la clé n'est pas
configurée. **⚠️ Le mode d'auth a été réécrit en V0.4.5** (OAuth2 retiré,
remplacé par simple API key UUID + header `X-INSEE-Api-Key-Integration`).
Voir l'entrée [0.4.5] ci-dessus.

### Observabilité ingestion

- **Checksum SHA-256 du CSV téléchargé** : tracé dans `ingest_log.csv_sha256`
  + short-circuit `same_checksum` quand le fichier est byte-identique au
  dernier success → skip COPY/VALIDATE/SWAP (économise plusieurs minutes
  Postgres + IOPS).
- **Canary post-swap** : nouvelle table `ingest_canary_targets` (5 cibles
  FINESS hardcodées : 3 LBM BIO ARD'AISNE Charleville + AP-HP Pitié-Salpêtrière
  + AP-HM Timone). RPC `check_ingest_canary(p_source)` appelé après
  l'atomic swap, missing keys écrits dans `ingest_log.canary_failures`
  sans rollback. Ameli reste sans cibles seedées (canary inactif jusqu'à
  identification de cibles stables).

### Robustesse

- `format_count_human(BIGINT)` defensive sur `n < 0`.
- INSEE timeout 60s (couvre les retries fetchJson cumulés).
- Validation stricte `perPage` (RangeError plutôt que clamp silencieux).

### Migrations SQL

- `20260509T140000_ingest_log_checksum_and_canary.sql`
- `20260509T140200_rpc_ameli_lister_specialites_clarifie.sql`

### .env.example

Ajout des 2 variables OAuth2 `INSEE_SIRENE_CLIENT_ID` /
`INSEE_SIRENE_CLIENT_SECRET` — **remplacées en V0.4.5** par une seule
`INSEE_SIRENE_API_KEY` (cf. entrée [0.4.5]).

### Tests

- 334 tests unitaires verts (+ ~22 nouveaux : 17 fallback INSEE, 3 SHA256
  + canary, 2 perPage).
- Aucun changement de comportement hors scope des chantiers.

## [0.4.3] — 2026-05-09

### ⚠️ Breaking — surface lib npm

Les trois lookups par identifiant retournent désormais un objet typé
`LookupResult<T>` discriminé par `found` au lieu d'un `T | null` brut.
Migration côté caller TS :

```ts
// Avant 0.4.3
const e = await getEntrepriseBySiren("787120435");
if (e) {
  console.log(e.siren);
}

// 0.4.3+
const e = await getEntrepriseBySiren("787120435");
if (e.found) {
  console.log(e.siren);
} else {
  console.warn(`SIREN introuvable : ${e.message} (status=${e.lookupStatus})`);
}
```

Fonctions concernées :
- `getEntrepriseBySiren(siren)` → `LookupResult<Entreprise>`
- `getCommuneByCode(code)` → `LookupResult<Commune>`
- `getFinessByNumFiness(num)` → `LookupResult<FinessResult>`

Côté serveur MCP runtime (caller LLM) : aucune cassure, le JSON expose
simplement le champ `found` en plus.

### Added

- **2 nouveaux tools MCP** :
  - `lister_specialites_ameli` : liste des codes spécialité Ameli (88+ entrées
    triées par fréquence) avec leur `type_ps_code` de rattachement.
  - `lister_types_ps_ameli` : liste des codes `type_ps` (3 entrées en base)
    avec un libellé clarifié et `specialites_presentes` (jsonb_agg des
    spécialités regroupées sous chaque type_ps). Résout l'ambiguïté du
    libellé natif Ameli pour le code `2`.
- **Type `LookupResult<T>`** partagé (`src/core/lookup-result.ts`) avec
  helpers `lookupFound` / `lookupNotFound` et statuts
  `found | not_found | ambiguous`.
- **Pattern `query_metadata`** sur les listings FINESS et Ameli
  (`geo_precision`, `distance_type: "haversine_postgis"`, notes actionnables
  sur fraîcheur DREES et précision centroïde commune).
- **Helper `expectRpcRows`** dans `db-helpers.ts` : throw explicite quand
  un RPC viole son contrat (`data === null` sans erreur amont).
- **Compteur `parsedCoordRejected`** côté ingestion FINESS, avec ladder
  warn 2 % / throw 5 % pour bloquer les ingestions partiellement géocodées
  causées par un column shift Lambert93 amont.
- **Helper `runIfMain()`** factorisé dans `scripts/ingest/shared.ts`,
  remplaçant la duplication entre `ameli.ts` et `finess.ts`.

### Changed

- **Doc tools Ameli corrigée** : la description listait des codes type_ps
  faux (`'3' sage-femme`, `'4' chir-dentiste`, `'8' kiné`) — codes
  inexistants dans la nomenclature Ameli. Audit Charleville 2026-05-09
  validé sur le CSV source (549 K lignes).
- **`load-env.ts`** : passage en path absolu via `fileURLToPath(new URL(...))`
  pour `.env.local` — corrige le no-op silencieux quand le script tournait
  depuis un autre cwd.
- **`metersToKm`** factorisé dans `core/numbers.ts` (auparavant dupliqué
  entre `ameli-db.ts` et `finess-db.ts`).
- **`assertValidDept`** ajouté dans `territoire/dept-codes.ts`,
  `validateDepartement` côté Ameli devient un wrapper trivial. Single
  source of truth INSEE.
- **`validateTypePsCodes`** au DB layer Ameli : un caller passant
  `type_ps_codes=["3"]` (laboratoires, filtré à l'ingestion) recevait
  silencieusement un résultat vide. Throw explicite avec orientation vers
  FINESS.
- **README** enrichi : section fraîcheur DREES (latence 1-2 mois pour
  structures émergentes), distance haversine vs routière, nomenclature
  type_ps clarifiée, lookups silencieux corrigés.

### Fixed

- Silent failure `entreprise_by_siren` qui retournait `null` brut sans
  message ni statut (cas SIREN introuvable + cas régression API DINUM
  full-text non distingués).
- Silent fallback `data ?? []` sur les RPCs Supabase : un `data === null`
  sans error retournait silencieusement un résultat vide. Désormais throw
  explicite (cf. `expectRpcRows`).

### Migration

- Migration SQL `20260509000002_rpc_ameli_nomenclature.sql` : 2 nouveaux
  RPCs `ameli_lister_specialites` et `ameli_lister_types_ps`. Aucun
  impact sur les RPCs existants.

## [0.4.2] — 2026-05-09 (pré-release)

- Migration Pro tier Supabase (8 GB) après incident free-tier disk
  saturation lors de l'ingestion Ameli.
- Colonnes typées `coordx_lambert93` / `coordy_lambert93` (DOUBLE PRECISION)
  remplacent la lecture via `raw->>'coordxet'` JSONB.
- `load-env.ts` : helper de chargement `.env.local` avec fallback `.env`.

## [0.4.0] — 2026-05-08

- Ingestion Annuaire Santé Ameli (libéraux conventionnés).
- 2 nouveaux tools MCP : `professionnels_in_radius`,
  `professionnels_par_specialite_dept`.
- Géocodage par centroïde commune (geo.api.gouv.fr).

## [0.3.0] — 2026-05-08

- Ingestion FINESS DREES dans Supabase + PostGIS.
- 3 tools MCP : `etablissements_finess_in_radius`,
  `etablissements_finess_by_categorie`, `etablissement_by_finess`.
- 24 familles FINESS catégorisées (~92 % du volume).

## [0.2.0] — version initiale

- Toolkit TS pour données publiques françaises.
- Tools territoire (geo.api.gouv) + DINUM Recherche Entreprises.
