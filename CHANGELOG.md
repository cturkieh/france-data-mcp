# Changelog

Toutes les modifications notables apparaissent ici. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; le projet suit
SemVer (la branche `0.x` autorise les breaking changes mineurs documentés).

## [0.5.1] — 2026-05-09

**Hotfix RPPS — récupère les ~970 K PS skippés par V0.5.0**

### Corrigé après le 1er run V0.5.1
- Retry schema-cache miss étendu à `PGRST204` (column not found) en plus de
  `PGRST205` (table not found). Le 1er run V0.5.1 (run GH 25611048725) a fail
  à 33s sur la colonne `geom_source` fraîchement ajoutée — PostgREST n'avait
  pas encore propagé le `NOTIFY 'reload schema'` au moment du 1er INSERT. Les
  2 codes signalent le même phénomène, le retry exponentiel les couvre tous
  les deux désormais. (+77 % de couverture
ingérée vs V0.5.0). Le 1er run V0.5.0 (run GH `25607546400`) avait skippé 43 %
des PS car le parser exigeait une adresse de structure matchée sur l'index
commune INSEE — exactement la valeur ajoutée du RPPS vs Ameli (étudiants,
retraités, salariés CH/CHU sans adresse site, libéraux à domicile).

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
