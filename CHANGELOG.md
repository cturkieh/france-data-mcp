# Changelog

Toutes les modifications notables apparaissent ici. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; le projet suit
SemVer (la branche `0.x` autorise les breaking changes mineurs documentés).

## [Unreleased]

### Fixed — description périmée `professionnels_in_radius` (suite Chantier C V0.14.0)

V0.14.0 a rendu les coordonnées Ameli HYBRIDES (~77 % adresse BAN précise,
~23 % centroïde commune) et exposé `geo_precision` PAR résultat — mais la
**prose de description** du tool `professionnels_in_radius` annonçait toujours
en dur `geo_precision: "centroide_commune"` et « Précision géo : centroïde
commune » pour TOUS les PS. Le champ `geo_precision` par-résultat était correct
depuis V0.14.0 ; seule la description (lue au tool-discovery) était fausse.
Conséquence : un LLM lisant cette description en concluait que les coords Ameli
sont inexploitables pour un classement individuel et **sous-utilisait la donnée
précise** (~77 % du référentiel).

- **Description réécrite** : précision HYBRIDE explicite (split ~77/~23
  chiffré), les 2 valeurs canoniques `geo_precision` ∈ {`"adresse"`,
  `"centroide_commune"`} documentées avec leur sémantique respective, consigne
  « lire `geo_precision` PAR résultat ». Alignée sur le jumeau RPPS
  `professionnels_rpps_in_radius`, sans la 3ᵉ valeur `etablissement_finess`
  (pas de FINESS join côté Ameli).
- **Test garde-fou B5** (`api/tools.test.ts`) mis à jour : intitulé et
  assertions assumaient l'ancienne sémantique « 100 % centroïde commune ».
  Vérifie désormais les 2 valeurs `geo_precision`, le split chiffré, l'absence
  de `etablissement_finess`, et le maintien de l'avertissement intra-commune
  pour la branche centroïde résiduelle.

`precise_only` côté Ameli reste NON câblé : le GiST PARTIEL
`annuaire_ameli_geog_precise_gist` existe depuis V0.14.0, mais la RPC
`ameli_in_radius` n'expose pas encore `p_precise_only` (câblage à faire dans
une itération dédiée — migration RPC + branche CTE `precise` + schéma tool +
DB layer + tests, cf. jumeau RPPS `20260520T100000_rpps_in_radius_precise_only.sql`).

## [0.14.0] — 2026-05-21 (Chantier C : géocodage Ameli — centroïde commune → adresse précise)

### Added — `geom_source` Ameli + `ban_join` cron Ameli

Les 4 tools Ameli (`professionnels_in_radius`, `professionnels_par_specialite_dept`,
`centres_sante_in_radius`, `centres_sante_by_finess`) servaient des coordonnées
au **centroïde commune** (~3 km). Le tri par distance et les recherches en
rayon court étaient inutilisables en zone dense (Paris notamment) — même
classe de bug que côté RPPS pré-V0.12 (`ban_join`). Cf. plan détaillé
`docs/plans/ameli-geocoding.md`.

**Cadrage prouvé prod 2026-05-21** : sur 462 668 PS Ameli, 100 % ont les 3
segments de clé (adresse + CP + INSEE) → tous géocodables. Le cache
`geocoded_addresses` partagé avec RPPS contient déjà 295 660 entries
acceptées dont **33 % matchent un échantillon Ameli aléatoire** → ~150 K PS
seront géocodés **immédiatement** à la 1ʳᵉ application, sans backfill BAN
préalable. Option A (cache partagé) retenue contre Option B (cache dédié) —
zéro migration cache, croissance organique. Cf. `docs/plans/ameli-geocoding.md`
§ « Décision Option A ».

**Architecture** : clone fidèle du pattern `ban_join` keyset RPPS prouvé prod
(1 065 291 rows posés run #13). Les 3 RPC du pipeline Ameli sont des jumeaux
stricts des RPC RPPS, prédicat éligibilité simplifié (`commune_centroid AND
adresse IS NOT NULL` — pas de FINESS join côté Ameli) :

- `ingest_analyze_ameli_staging()` : `ANALYZE` post-bulk-INSERT, avant le
  `ban_join` (sans stats fraîches, la jointure cache peut basculer en seq
  scan plein → 57014 zone dense).
- `ingest_apply_ameli_ban_join_batch(p_after, p_limit)` : `UPDATE` ensembliste
  cache → staging, curseur keyset (jamais sentinelle — cf. gotcha CLAUDE.md).
- `ameli_measure_ban_to_geocode()` : observabilité best-effort, logge le delta
  cache dans `ingest_log.ban_eligible_distinct` + `ban_to_geocode_distinct`
  (réutilise les colonnes RPPS 20260520T000000, partagées via `source`).

Toutes en `SET statement_timeout='55s'` (< cap passerelle PostgREST 60 s,
gardé par `enrichment-statement-timeout.test.ts` étendu).

### Added — colonne `annuaire_ameli.geom_source` + GiST PARTIEL ban_address

- `ALTER TABLE annuaire_ameli ADD COLUMN geom_source TEXT NOT NULL DEFAULT
  'commune_centroid' CHECK (… IN ('commune_centroid', 'ban_address'))`.
- `CREATE INDEX annuaire_ameli_geog_precise_gist ON annuaire_ameli USING GIST
  (geog) WHERE geom_source = 'ban_address'` — jumeau de `rpps_geog_precise_gist`,
  prêt pour la future branche `precise` des tools radius (un GiST global ferait
  remonter le cluster co-localisé `commune_centroid` → 57014 zone dense,
  gotcha CLAUDE.md prouvé prod RPPS 2026-05-19).
- `ingest_create_annuaire_ameli_staging()` mirrore prod ↔ staging : 9 index
  (5 base + 2 composites V0.4.1 + 1 covering V0.9.4 + 1 GiST partiel
  Chantier C). Sans ce miroir, le RENAME du swap reverte le partiel.
- Gardes-fou étendus : `staging-parity.test.ts` whiteliste explicitement le
  GiST partiel et assert prédicat byte-identique prod ↔ staging-create.

### Added — exposition `geo_precision` au caller MCP (per-result + global dynamique)

- `ameli_in_radius` et `ameli_by_specialite_dept` retournent `geom_source TEXT`.
- `RawAmeliRow.geom_source` mappé vers `PerResultGeoPrecision = "adresse" |
  "centroide_commune"` (jamais "centroide_commune" quand la coord est BAN).
- Fenêtre transitoire code↔migration : `geom_source` absent → fallback
  `"centroide_commune"` conservateur (on ment vers le bas, jamais vers le haut).
- 3 tests unitaires : HIT BAN, MISS centroïde explicite, RPC pré-migration
  (fallback).
- **Étiquette globale `query_metadata.geo_precision` dynamique** (parité Fix
  #4 RPPS V0.13.0) : `ameliRadiusMetadata` / `ameliDeptMetadata` émettent
  désormais `centroide_commune_ameli_mixte` (vs ancien `centroide_commune_ameli`
  qui annonçait ~3 km en dur). `refineAmeliGeoPrecisionLabel` raffine
  post-RPC selon la distribution effective :
  - 100 % adresse → `centroide_commune_ameli_precis_uniquement`
  - 100 % centroïde → `centroide_commune_ameli_centroide_uniquement`
  - mixte → étiquette mixte conservée
- Note nuancée short-radius (radius<3km) au lieu de la note « FAUX négatif »
  générique : la branche précise (~77 % des PS Ameli post-géocodage) reste
  fiable, le caller LLM peut se fier à `distance_km` quand
  `geo_precision='adresse'`. Validation prod : Paris 500m médecins =
  `precis_uniquement`, Mayotte 976 = mixte effectif.
- Ancien `centroide_commune_ameli` marqué `@deprecated` mais conservé pour
  rétrocompat des clients qui auraient caché la string.
- Tests dédiés : 9 nouveaux tests `refineAmeliGeoPrecisionLabel` (jumeau
  exact des tests RPPS Fix #4).

### Fixed — `FORCE_REINGEST=1` câblé côté cron Ameli (asymétrie corrigée)

`scripts/ingest/ameli.ts` ne câblait PAS l'env `FORCE_REINGEST` (alors que
RPPS oui depuis V0.12.2). Conséquence : après le backfill BAN Ameli, le
cron court-circuitait sur `same checksum`, le `ban_join` ne tournait jamais.
Câblage ajouté via `isForceReingestEnv(process.env.FORCE_REINGEST)`,
strictement aligné sur `rpps.ts:256`. Flag **ponctuel par contrat**
(`isForceReingestEnv(undefined) === false`) — aucun risque de re-ingest
automatique à chaque cron.

### Added — étape `ban_join` dans le cron Ameli (`scripts/ingest/ameli.ts`)

3 sous-steps insérés entre `validate coherence` et `atomic swap` :

1. **5b** `ingest_analyze_ameli_staging` (fail-loud)
2. **5c** `ameli_measure_ban_to_geocode` (best-effort, logue dans `ingest_log`)
3. **5d** `runKeysetRpc("ingest_apply_ameli_ban_join_batch", …)` — pattern
   keyset rodé prod RPPS

Aucun appel BAN API dans le cron (dead-end prouvé : `CREATE INDEX` lourd ou
géocodage synchrone via PostgREST = cap passerelle 60 s structurel). Le cron
**applique seulement** le cache existant. Le re-remplissage du cache reste
manuel (`ban-backfill.mjs` adapté Ameli, hors cron — même dette que RPPS).

### Backfill manuel post-merge (action ops requise)

Pour viser un hit rate immédiat > 80 % au lieu de 33 % à la 1ʳᵉ application,
lancer `ban-backfill.mjs` adapté Ameli après merge (~52 min pour ~313 K
adresses, hors cron). Décrit en P1 du backlog (Phase 2 BAN automatisation).

### Migrations (à appliquer manuellement via dashboard SQL editor)

- `20260521T100000_ameli_geom_source.sql`
- `20260521T101000_ingest_create_annuaire_ameli_staging_with_geom_source.sql`
- `20260521T102000_ameli_ban_join_and_measure.sql`
- `20260521T103000_ameli_rpc_expose_geom_source.sql`

Naming T-format → CLI Supabase SAUTE (cf. gotcha CLAUDE.md V0.12.3). Le
fichier consolidé `dist/cadrage/apply-prod.sql` permet de coller les 4 en
une seule passe.

### Acceptance prod (post-application)

- `SELECT count(*) FROM annuaire_ameli WHERE geom_source = 'ban_address'` →
  ~150 K immédiat (hit rate 33 % cache existant), ≥ 350 K post-backfill.
- `professionnels_in_radius` Paris 500 m profession=`10` : distances variées
  (pas toutes ~3 km), `geo_precision='adresse'` dominant.
- Cron Ameli complet < 65 min.
- `ingest_log` : `ban_eligible_distinct` + `ban_to_geocode_distinct` non NULL.

## [0.13.3] — 2026-05-21 (KNN GiST sur `rpps_in_radius` — fix timeout zone dense)

### Fixed — Timeout `professionnels_rpps_in_radius` en zone dense (chantier A backlog)

L'outil `professionnels_rpps_in_radius` time-outait sur grand rayon + zone
dense (cas démo : Neuilly 2 km, tous PS). Cause-racine identifiée par
diagnostic prod `EXPLAIN ANALYZE BUFFERS` (discipline cardinale « prouver
la cause par la prod, jamais par inférence ») :

- **`ORDER BY ST_Distance(r.geog, v_point) LIMIT N` ne déclenche pas le KNN
  GiST.** Le planner ramène TOUTES les lignes du bbox `&&` (7 630 lignes
  à 2 km Neuilly post-V0.13 ban_join, cluster `ban_address` dense Paris ouest
  sur 1,14 M lignes), recalcule la distance exacte par-ligne, top-N heapsort.
- Hypothèses brief écartées par la prod : limit caller trop élevé (faux —
  clampLimit serveur à 100), branche centroid coûteuse (vraie mais
  secondaire), régression GiST partiel post-V0.13 (intact, 107 MB, prédicat
  byte-identique au RPC).

C'est le **piège V0.10.2 inversé** : V0.10.2 documentait le cluster
centroïdes commune, V0.13 a inflaté `ban_address` qui hérite du même
piège sur cluster Paris dense.

### Added — KNN PostGIS sur la CTE `precise` de `rpps_in_radius`

Migration `20260521T140000_rpps_in_radius_knn.sql` : `ORDER BY r.geog <->
v_point` (operator KNN GiST) au lieu de `ORDER BY ST_Distance(...)`. L'index
GiST PARTIEL `rpps_geog_precise_gist` trie en streaming par bounding box +
early-stop natif sur LIMIT.

`distance_meters` reste calculé via `ST_Distance(r.geog, v_point)` dans le
SELECT (distance géodésique exacte ; l'opérateur `<->` sur `geography`
retourne une distance bbox approximative — bonne pour le tri KNN, mauvaise
comme valeur publique). Postgres calcule les deux mais `ST_Distance` ne
tourne que sur les 100 rows post-KNN (au lieu de 7 630 pré-fix).

Contrat API préservé byte-pour-byte : signature `BOOLEAN p_precise_only`,
sentinelle P0002 (matview vide), tri global UNION ALL `ORDER BY
distance_meters, id LIMIT p_limit`. Aucun changement côté caller MCP.

### Mesures prod avant / après

| Test (Neuilly 2 km, tous PS, limit 100) | Pré-fix | Post-fix | Gain |
|---|---|---|---|
| RPC hybride (cas démo)               | timeout-prone | **80,7 ms** | **>30×** |
| RPC precise_only=true                | 2 594 ms      | **56 ms**   | **×46** |
| Buffers (precise_only)               | 10 628        | **1 393**   | ×7,6 |

### Gotcha CLAUDE.md — `ORDER BY ST_Distance ≠ KNN GiST`

Ajout durable à la section « Top gotchas DB » pour tout futur `ORDER BY
distance + LIMIT N` sur `geography` :

- Utiliser l'opérateur KNN `geog <-> point` dans `ORDER BY` pour activer
  l'early-stop GiST.
- Garder `ST_Distance` dans le SELECT pour la valeur géodésique exacte.
- Vérification rapide qu'un plan utilise le KNN : `Order By: (geog <-> ...)`
  dans `Index Scan using <gist_index>` (pas un `Sort` séparé).

### Dette parquée (hors V0.13.3)

Branche centroid : `Index Scan using rpps_insee_id_idx` retire 3 368 lignes
en `Filter: r.geom_source = 'commune_centroid'` à 500 m Paris. Un index
partiel `rpps_insee_id_centroid_idx ON rpps(code_insee, id) WHERE
geom_source = 'commune_centroid'` rendrait le scan ciblé directement
(~50–100 ms gagnées par commune touchée). Coût : maintenance d'un index
supplémentaire à chaque ingestion mensuelle RPPS. À ouvrir si la branche
centroid devient le goulot. Non bloquant V0.13.3 — la branche `precise`
dominait à 96 % le temps de réponse.

### Acceptance prod

- **Neuilly 2 km hybride** (cas démo) : 80,7 ms (vs timeout-prone). Démo unblocked.
- **Neuilly 2 km precise_only=true** : 56 ms (vs 2 594 ms). ×46.

### Non-régressions

- `isNafCompatibleWithFamille` toujours utilisé par `siret-resolver.ts`
  (Resolver V2 inchangé). Les 3 cas FINESS 920028487/920028685/920000643
  ne passent pas par `rpps_in_radius`.
- 1281 unit tests verts (les tests `rpps-db.test.ts` sont mockés, n'exécutent
  pas le SQL changé).

### Application en prod

Migration appliquée manuellement via Supabase Dashboard SQL editor (canal
V0.12.3 — format `YYYYMMDDTHHMMSS_*.sql` rejeté par `supabase db push`).
Validation post-fix par `EXPLAIN ANALYZE BUFFERS` sur le cas démo Neuilly
avant le commit du code.

## [0.13.2] — 2026-05-21 (Gate NAF↔familles `finess_sirene_coverage_in_radius`)

### Fixed — Couverture FINESS↔SIRENE biaisée par les familles co-localisées

L'outil `finess_sirene_coverage_in_radius` retournait un ratio de couverture
trompeur sur deux fronts, identifiés en prod :

1. **Ratio par défaut faussé** — un appel `(naf=8690B)` sans `familles` à
   Neuilly comptait ~200 sites FINESS (hôpital + EHPAD + labos + IFSI…)
   contre une douzaine de SIRET labos DINUM → ratio ~17 alors que la
   sémantique du tool promet « à périmètre équivalent ».

2. **Matching croisé sur co-localisation** — Hôpital Franco-Britannique
   (4 rue Kléber) : 7 entités FINESS partagent l'adresse, dont un IFSI
   (famille `enfance_protection`) et un labo (famille `labo`). Le matching
   greedy best-first sur Dice 1.0 appariait l'IFSI au SIRET labo selon
   l'ordre d'insertion — fausse sous-déclaration DREES côté `finess_only`.

### Added — Gate NAF↔familles en 2 couches consolidées (additif, non-breaking)

- **Nouvelle fonction `nafToCompatibleFamilles(naf)`** dans
  `src/sante/naf-finess-mapping.ts` : inverse de `nafsForFamille`, retourne
  les familles FINESS compatibles avec un NAF (many-to-many — `8610Z` →
  8 familles hospitalières ; `8690B` → `["labo"]` uniquement). Réutilise
  la même table que `nafsForFamille` (one source of truth, round-trip
  invariant testé). Filtre défensif `DELIBERATELY_NO_NAF`.

- **Auto-derive du scope FINESS** : si caller ne passe pas `familles`,
  `getFinessInRadius` est appelé avec les familles dérivées du NAF. Le
  champ `familles_auto_derivees` (nullable, exposé dans le résultat) trace
  la décision pour le caller LLM. Cas Neuilly : `finess_sites` passe de
  ~200 à la douzaine de labos réels.

- **Intersection si `familles` explicite** : si caller passe `familles`,
  intersection avec `nafToCompatibleFamilles(naf)`. Les familles écartées
  sont exposées via `familles_excluees_naf` + caveat textuel — jamais de
  silence muet. Court-circuit (`finess_sites=0` + caveat fort) si toutes
  les familles passées sont incompatibles.

- **Pre-filter du pool FINESS** : après `getFinessInRadius`, filtre
  défensif `nafCompatiblesSet.has(famille)` → garantit que `finess_sites`,
  `finess_only_samples` et le ratio ne reflètent QUE des FINESS dans le
  scope NAF. L'IFSI Franco-Britannique disparaît du rapport (au lieu
  d'apparaître comme sous-déclaration). `console.warn` ops si jamais des
  lignes hors scope sont retournées (régression possible du restrict côté
  RPC `getFinessInRadius`).

- **Nouveau champ typé `coverage_status: CoverageStatus`** (toujours
  présent dans `CoverageResult`) :
  - `"computed"` — calcul nominal (peut retourner `finess_sites=0` sur
    rayon vide, mais le périmètre est valide).
  - `"scope_empty_unknown_naf"` — NAF non mappé vers une famille connue.
    Court-circuit ; `console.warn` ops qualifié (format invalide vs hors
    périmètre santé).
  - `"scope_empty_familles_incompatible"` — caller a passé `familles`,
    toutes incompatibles avec le NAF. Court-circuit.

  Permet au caller LLM de router sans parser les `caveats[]`. Le caveat
  textuel reste exposé en parallèle (lecture humaine).

### Internal — refactoring code-reuse

- `normalizeNafCode` extrait + exporté depuis `naf-finess-mapping.ts`,
  réutilisé dans `coverage.ts` (`etabMatchesNaf` consomme désormais le
  helper partagé au lieu d'un `normalizeNafForCompare` local quasi-identique).

- Helper privé `buildEmptyCoverageResult` factorise les 16 champs du
  shape `CoverageResult` à 0 (anti-drift quand un futur champ est ajouté
  au type).

### Acceptance prod

- **Franco-Britannique (4 rue Kléber)** avec `naf=8690B` : doit
  `matched_count=1` (labo seul), `finess_sites=1`, IFSI absent de tout
  le rapport, `coverage_status="computed"`.
- **Neuilly** avec `naf=8690B` sans `familles` : doit
  `familles_auto_derivees=["labo"]` visible, `finess_sites` réduit à la
  douzaine de labos (au lieu de ~200 sites tous types).

### Tests

- 8 nouveaux tests `nafToCompatibleFamilles` (many-to-many, normalisation,
  invariants `DELIBERATELY_NO_NAF` + round-trip).
- 9 nouveaux tests `coverage.ts` (gate Franco-Britannique, auto-derive
  many-to-many 8610Z, familles incohérentes, intersection partielle,
  3 cas `coverage_status`).
- Tests 920028487/920028685/920000643 du Resolver V2 inchangés
  (`coverage.ts` n'importe pas `siret-resolver.ts` ; pas de risque
  régression).

### Non-régressions garanties

- Resolver V2 / `verifier_site_actif` / `inspect_site` / Reconciler RPPS
  intacts (gate `isNafCompatibleWithFamille` toujours utilisé par
  `siret-resolver.ts` côté DINUM `/near_point`, non touché).
- Suite unit complète : 1281 tests verts (vs 1278 avant la release —
  3 nouveaux tests `coverage_status`).

## [0.13.1] — 2026-05-21 (Raffinements désambiguïsation Resolver V2)

### Added — Sous-score nom + succession SIRET dans `verifier_site_actif`

Le fallback géo V0.13.0 (DINUM `/near_point` + gate NAF) tranchait sur
score d'adresse seul : insuffisant pour 2 cas observés en prod sur FINESS
920028487 (LBM EYLAU UNILABS Victor Hugo, chemin fallback car biologistes
non RPPS-déclarés) :

1. **Co-locataire NAF-compatible hors-sujet** — un cabinet PMA (CHOUAIEB,
   SIRET 93354857000029, NAF 8690B) à la même adresse passait le gate NAF
   et créait une ambiguïté `disambiguation_status: "ambiguous"` alors que
   sa raison sociale n'avait aucun rapport avec le labo EYLAU.

2. **Succession temporelle de SIRET** — deux SIRET du même SIREN 784652026
   EYLAU UNILABS à la même adresse (27 Bd Victor Hugo), l'un fermé (...070,
   ouvert 2013), l'autre actif (...419, ouvert 2025-09-08). Pas une
   ambiguïté d'entreprise — juste une réorganisation administrative.

V0.13.1 corrige ces 2 cas via une cascade de désambiguïsation enrichie :

- **Nouveau champ `score_nom: number | null`** sur `SiretCandidate` (type
  public exposé via `verifier_site_actif.candidates[]` /
  `inspect_site.statut_site` / `reconcilier_finess_sirene.candidates[]`).
  Score Sørensen-Dice nom FINESS ↔ raison sociale UL (`raison_sociale_ul`).
  `null` quand `raison_sociale_ul` absent (RPPS-only sans cross-vérification
  DINUM) — l'absence ne disqualifie pas.

- **Constante `NAME_DISQUALIFY_THRESHOLD = 0.2`** appliquée uniquement dans
  `tryAddressFallback` (jamais sur le chemin RPPS direct où le signal métier
  prime). Seuil très bas pour préserver les cas M&A (rebranding type
  DIAGNOVIE → BIOGROUP NORD, Dice ~0.1 mais protégé par le chemin RPPS).

- **2 nouveaux variants `DisambiguationStatus`** :
  - `"by_name_score"` : ≥ 1 candidat disqualifié par score nom, 1 seul reste
  - `"by_active_succession"` : > 1 candidat post-gate partagent (SIREN,
    adresse normalisée), ≥ 1 actif → on retient l'actif le plus récent
    (`date_creation` desc, tie-break SIRET asc pour déterminisme)

- **Cascade 5 étapes factorisée** dans `disambiguateFallbackCandidates`
  (helper privé) : `single_after_gate` → `by_name_score` → `by_active_succession`
  → `by_rpps_signal` → `ambiguous`. Préserve strictement les cas pré-V0.13.1
  (test "2 labos co-localisés ex-aequo → ambiguous" reste vert).

- **Tie-breaker sur `compareByScoreDesc`** : tri `score_adresse desc → score_nom desc
  → siret asc` pour stabilité des snapshots quand 2 candidats ont des scores
  d'adresse identiques. N'affecte pas les cas single-candidat (Chérest 920028685
  ferme, Franco-Britannique 920000643 actif : non-régressions gardées par tests).

- **`console.warn` audit ops** quand le name filter élimine TOUS les
  candidats post-gate NAF (cas pathologique : gate NAF anormalement
  permissif). Préfixe `[france-data-mcp]` conforme convention lib OSS.

- **5 nouveaux tests** dans `cross-source.test.ts > "Resolver V2 fallback géo"` :
  - Raffinement #2 : CHOUAIEB hors-sujet écarté par score nom
  - Raffinement #3 : succession SIRET fermé+actif retient l'actif
  - Cas combiné EYLAU Victor Hugo (3 candidats : 2 EYLAU + 1 CHOUAIEB)
  - Garde-fou `score_nom: null` (raison_sociale_ul absente → non disqualifié)
  - Garde-fou Chérest non-régression chemin RPPS direct (verdict ferme préservé)

### Fixed — Gate adresse fallback (prod-validé sur EYLAU 920028487)

Le 1er passage de V0.13.1 (commit `b0be43f`) ne tranchait PAS le cas réel
EYLAU 920028487 en prod (test live `scripts/test-live-v0131.ts` : verdict
restait `indetermine` + `ambiguous`, 4 candidats). Cause-racine prouvée par
dump live des candidats :

- 3 SIRET EYLAU (SIREN 784652026) co-existent à Neuilly : `...070 fermé`
  + `...419 actif` au 27 Bd Victor Hugo + `...039 actif` au 34 Avenue du
  Roule (autre site EYLAU à ~150 m, capté par /near_point).
- Le candidat ...039 (score_adresse 0.568, score_nom 0.6) passait le name
  filter (`score_nom >= 0.2`) mais l'active succession ne se déclenchait
  pas (adresse différente du groupe Victor Hugo) → cascade tombait en
  `by_rpps_signal` (échec : RPPS vide) → `ambiguous`.

**Fix prod-validé** : nouveau gate adresse en étape 0 de
`disambiguateFallbackCandidates` (seuil `BEST_MATCH_THRESHOLD = 0.6`,
aligné sur le chemin RPPS direct). Un candidat fallback qui n'atteint pas
ce seuil n'est PAS considéré pour le best_match (mais reste dans
`candidates[]` pour audit caller). Élimine SIRET ...039 → 2 candidats au
27 Bd Victor Hugo → succession déclenche → best_match = SIRET ...419 actif.

Discipline appliquée : **prouver-par-la-prod avant push** (cf. memory
`prove-rootcause-by-prod`). Le commit initial passait /simplify + /review
P1+P2 mais le test live a réfuté l'inférence "name filter + succession
suffisent". Une inférence /review-validée reste une inférence — `b0be43f`
shippé tel quel aurait raté EYLAU en prod. Le script `scripts/test-live-v0131.ts`
est conservé pour future référence (suppression possible après confirmation
prod en V0.13.2+).

- **Test garde-fou** : `Raffinement gate adresse fallback — site même SIREN
  hors-périmètre écarté du best_match` reproduit exactement le pool prod
  EYLAU (3 SIRET, dont 1 hors-périmètre adresse) et asserte que le best_match
  est le SIRET actif Victor Hugo, pas l'Avenue du Roule.

- **Test artificiel "labo/école Franco-Britannique"** aligné : le mock fixait
  des adresses DINUM divergentes du FINESS fake — l'invariant testé étant le
  gate NAF (école écartée), les adresses sont maintenant cohérentes avec le
  FINESS fake (passe le gate adresse 0.6 + reste valide pour le gate NAF).

### Changed

- **Helper `computeNameScore(finessNomNorm, nomComplet)`** : factorise les
  2 sites historiques de calcul score nom (`mergeOrInsertDinumCandidate` +
  bloc d'injection fallback). Garantit la sémantique partagée "nomComplet
  absent → score null" sans dérive.

- **Helper `compareNullableDesc(a, b)`** : factorise le tri descendant
  null-tolérant (nulls en queue). Utilisé 2× dans `compareByScoreDesc`
  pour la double comparaison `score_adresse` puis `score_nom`.

- **Helper `disambiguateFallbackCandidates(candidates, rppsSirets)`** :
  extraction de la cascade 5 étapes hors de `tryAddressFallback` (était
  ~25 lignes inline, devient ~50 lignes lisibles avec invariants explicites).

### Type contract (note)

`SiretCandidate.score_nom` est **un champ requis** (non-optionnel) ajouté
au type public exporté. Les consommateurs npm qui construisent un littéral
`SiretCandidate` voient un break TS strict. Lib en V0.x (semver libre) →
acceptable mais documenté.

## [0.13.0] — 2026-05-21

### Added — Resolver V2 (chantier majeur croisement FINESS↔SIRENE)

Le pivot RPPS→DINUM V0.7 couvre mal certains cas pourtant courants :
laboratoires de biologie dont les biologistes ne déclarent pas leur site
au RPPS, EHPAD/pharmacies/centres techniques sans titulaire RPPS rattaché,
et déménagements (PMA Chérest → Ambroise Paré : SIRENE sait au 1er septembre
2025, mais V0.7 ne pouvait pas le détecter sans pivot RPPS exploitable).

V0.13 introduit un **fallback géographique** déclenché quand `best_match`
reste null après la cascade V0.7 ET que DINUM a répondu sans erreur. Le
fallback appelle DINUM `/near_point` (rayon 150 m sur les coords FINESS)
filtré par les NAF compatibles avec la famille FINESS du site source.
Un **gate d'activité** (mode many-to-many) éliminate les candidats hors
secteur, préservant le garde-fou Franco-Britannique (un labo ne sera jamais
rattaché à un IFSI co-localisé).

- **Nouveau module `src/sante/naf-finess-mapping.ts`** : table NAF ↔ famille
  FINESS many-to-many calibrée sur la nomenclature NAF rév.2 + taxonomie
  DREES. Helpers publics `nafsForFamille()` + `isNafCompatibleWithFamille()`.
  Familles `groupement` (GCS/GCSMS) et `autre` listées dans
  `DELIBERATELY_NO_NAF` → fallback désactivé pour elles (skip silencieux,
  préserve le garde-fou). Imagerie inclut 8622A (radio libérale) + 8690F
  (centres en SCM/SEL). 20 tests d'invariant (couverture complète des
  familles, parité NAF_SANTE, normalisation casse/point/espace).

- **Traçabilité Resolver V2 exposée** sur les 3 tools publics
  (`verifier_site_actif`, `historique_etablissement`, `reconcilier_finess_sirene`)
  + propagation dans `inspect_site.statut_site` :
  - `method`: `"rpps"` (V0.7 nominal) / `"address_fallback"` (RPPS vide) /
    `"mixed"` (RPPS partiel + fallback complète)
  - `fallback_reason`: `"no_rpps"` / `"no_best_match_with_clean_dinum"` /
    `"no_naf_mapping_for_famille"` / `"no_finess_coords"` / `null`
  - `naf_filter_used`: NAF passés à `/near_point` (audit + observabilité)
  - `disambiguation_status`: `"single_after_gate"` / `"by_rpps_signal"` /
    `"ambiguous"` / `"not_applicable"`

- **Préfixe LLM-friendly dans `explication`** : quand le SIRET vient du
  fallback, le texte commence par
  `[Resolver V2 : SIRET résolu via fallback géographique DINUM /near_point —
  NAF 8690B, single_after_gate]`. Cas nominal V0.7 : pas de préfixe.

- **Désambiguïsation `ambiguous`** : message d'explication dédié quand
  plusieurs candidats matchent la famille FINESS via fallback géo sans
  signal RPPS pour départager (`best_match: null` + candidats listés pour
  intervention manuelle).

- **8 nouveaux tests dédiés fallback** dans `cross-source.test.ts > "Resolver
  V2 fallback géo"` + **2 fixtures cas réels** :
  - Eylau Victor Hugo (RPPS vide labo → fallback retrouve le SIRET labo)
  - PMA Chérest (déménagement détecté, `method="mixed"`, ancien + nouveau
    SIRET exposés)
  - Hôpital Franco-Britannique 4 rue Kléber (co-localisation labo/école →
    gate écarte l'école 8542Z)
  - 2 labos co-localisés ex-aequo → `disambiguation_status: "ambiguous"`
  - Famille `groupement` GCS → fallback skip silencieux (`searchEntreprises`
    JAMAIS appelée)
  - Famille `autre` → skip silencieux
  - `coords: null` → skip silencieux
  - DINUM en erreur → fallback ne se déclenche pas (Q1 verrouillée)
  - Non-régression V0.7 (best_match RPPS direct → pas de fallback déclenché)

### Changed

- **Suppression de l'early return RPPS vide dans `resolveSiretsForFiness`** :
  le cas `rppsSirets.length === 0` tombe maintenant naturellement dans la
  branche fallback (cascade DINUM = no-op sur liste vide). Sémantique
  publique non-breaking (la résolution finale reste cohérente), mais le
  comportement de résultat CHANGE : un FINESS qui retournait `indetermine`
  V0.7 retournera désormais souvent `actif`/`ferme` via fallback géo. Effet
  voulu, à monitorer en prod.

- **Factorisation cascade `inspect_site` (`SiteContext`)** : `verifierSiteActif`
  et `historiqueEtablissement` acceptent un paramètre optionnel
  `context?: SiteContext` pour partager FINESS + résolution pré-chargés.
  `inspect_site` charge maintenant le contexte une seule fois et le passe
  aux 2 sous-appels (économie ~600 ms + 50 % de la charge rate-limit
  DINUM par invocation). Architecture en 2 phases : Phase A
  (`getFinessByNumFiness` + `getRppsDansEtablissement` en parallèle) →
  Phase B (`verifierSiteActif(context)` + `historiqueEtablissement(context)`
  en parallèle). Backward-compat strict : les callers MCP qui passent
  `verifierSiteActif(numFiness)` directement gardent le comportement V0.10.

- **Désync FINESS↔RPPS détectée AVANT la cascade** : la branche
  "FINESS absent + PS RPPS rattachés" est désormais détectée par
  `inspect_site` AVANT d'appeler la cascade RPPS→DINUM (au lieu d'après le
  verifier), économisant l'appel DINUM gaspillé dans ce cas pathologique
  (latence DREES 1-2 mois). Le warning console reste émis pour le signal
  opérationnel.

### Added — Fix #4 (étiquette `geo_precision` dynamique)

`rpps_in_radius` retournait systématiquement
`geo_precision: "centroide_commune_ans_mixte"` même quand 100 % des résultats
étaient en précision exacte (`adresse` BAN ou `etablissement_finess`). Un
caller LLM lisait l'étiquette globale au lieu d'inspecter chaque row et
sous-estimait la qualité des données. Bug reporté par Claude.ai lors du test
utilisateur initial.

- **Nouveau helper `refineRppsGeoPrecisionLabel(rows, baseMeta)`** dans
  `src/core/query-metadata.ts` (factory pure) qui post-calcule l'étiquette
  globale selon la distribution effective des rows. 2 nouvelles valeurs
  `GeoPrecision` :
  - `centroide_commune_ans_precis_uniquement` (100 % rows précis)
  - `centroide_commune_ans_centroide_uniquement` (100 % rows centroïde)
  - Mixte effectif → étiquette `mixte` préservée (comportement V0.12 strict).
- **`CENTROID_PRECISIONS` converti en `Record<GeoPrecision, boolean>` via
  `satisfies`** : TS compile-fail si une future valeur de `GeoPrecision`
  n'est pas classée explicitement (même garde-fou que `SOURCE_NOTE`).
- **Filtre note `shortRadiusMixed` mensongère** : la note injectée par
  `rppsRadiusMetadata` quand radius < 3 km dit "la branche précise (~68,5 %)
  reste fiable, passer `precise_only: true`" — devient MENSONGÈRE après
  refine vers `_centroide_uniquement` (0 % de précis). Filtrée via la
  signature `"La branche précise"`. Test garde-fou bidirectionnel.
- **`console.warn` LOUD sur drift RPC** : row sans `geo_precision` typé
  (régression RPC, ancien dump pré-V0.12.0) émet un warn
  `[france-data-mcp]` avant return `baseMeta`. Test garde-fou ajouté.

### Added — Fix #5 (toggle `includeDirigeants` sur `entreprises_in_radius`)

Pour les groupes type Biogroup avec 20+ dirigeants par entité, l'énumération
volume gonflait inutilement le payload (tokens LLM Geo Intel).

- **Nouveau paramètre `includeDirigeants?: boolean`** (défaut `true`,
  backward-compat strict V0.12). À `false`, strip côté handler
  `api/tools.ts` (la lib `searchEntreprises` reste neutre — cohérent avec le
  découpage `src/` ≠ `api/` de CLAUDE.md).
- **`coerceBoolean` au lieu d'un strict `!== false`** : un caller LLM qui
  stringifie `"false"` (très fréquent en JSON tool-call) voit son intention
  respectée. Uniforme avec les 12+ autres params booléens du fichier
  (`precise_only`, `dedupe_by_ps`, etc.). Garbage → `RangeError` mappé
  JSON-RPC `-32602`.

## [0.12.3] — 2026-05-20

### Added

- **Helpers défensifs uniformes pour `writeIngestLog`** : 2 nouveaux helpers
  partagés dans `scripts/ingest/shared.ts` ferment la classe de silent
  failures sur les chemins d'audit ingest :
  - `writeIngestLogFailureFallback(log, source, client?)` factorise le
    pattern défensif inline-only de `cds.ts` (stderr fallback structuré
    AVANT writeIngestLog + try/catch interne pour éviter
    `UnhandledRejection` qui avalerait `process.exit(1)`). Les 3 callers
    `rpps.ts`/`finess.ts`/`ameli.ts` qui avaient l'ordre inverse
    (writeIngestLog AVANT fallback) sont désormais protégés contre un
    throw DB qui aurait perdu le snapshot structuré.
  - `writeIngestLogSuccessSafe(log, source, client?)` clôt la dette
    symétrique sur les chemins SUCCESS : un throw catastrophique de
    `writeIngestLog` sur un run réussi côté prod (env Supabase coupée,
    réseau brut post-SWAP) perdait silencieusement l'audit row sans
    signal opérateur (pire qu'un failed perdu — l'ops croit que le cron
    n'a pas tourné). Émet `[source][ingest_log_success_fallback]`
    distinct du failed path en cas de throw. Les 5 sites success
    migrent : `rpps.ts`, `finess.ts`, `ameli.ts`, `cds.ts` +
    `shortCircuitIfSameChecksum` (court-circuit same-checksum).

- **Type `IngestStderrPrefix`** distinct d'`IngestSource` : `"finess" |
  "ameli" | "rpps" | "cds"` (vs `"ameli_ps"` côté DB). Convention
  humaine pour les logs stderr (pas grep automatique aujourd'hui),
  ancrée pour éviter typo opérateur silencieuse.

### Changed

- **`safeSerializeIngestLog` triple-safety net** : le fallback flat
  `Object.entries(log).map(String(v))` est désormais wrappé dans son
  propre try/catch, retournant une string LITTÉRALE FIXE
  `"[serialize-triple-fallback-unrenderable]"` (zéro accès dynamique sur
  `log`) si même le fallback flat throw (cas adversarials : Proxy
  révoqué sur `log.status`, `Symbol.toPrimitive` throwant). Défense
  additionnelle au CALL SITE via `serializeLogSafelyAtCallSite` privé
  qui wrappe `safeSerializeIngestLog` lui-même — garantit aux 2 helpers
  défensifs qu'ils ont TOUJOURS une string à logguer, même dans le
  scénario adversariel où `safeSerializeIngestLog` throw avant
  d'atteindre son triple-fallback.

- **`shortCircuitIfSameChecksum`** : signature durcie `tag: string` →
  `tag: IngestStderrPrefix`. Permet l'injection du paramètre `client?`
  optionnel (testabilité). Tous les callers existants compatibles
  (littéraux conformes).

### Removed

- **`pnpm db:push`** retiré du `package.json` (alias mort depuis V0.4.4 :
  le CLI Supabase rejette le format de migration `YYYYMMDDTHHMMSS_*.sql`
  utilisé par les 52 migrations récentes). Canal d'apply réel = dashboard
  SQL editor manuel — documenté dans CLAUDE.md projet section Ingestion.
  L'auto-apply via GitHub Actions a été audité et parqué (mémoire
  `migration-autoapply-deferred` — risque moyen sur les données, préférence
  safe).

### Notes maintainers

- Convention nouvelle : **tout nouveau caller ingest qui écrit dans
  `ingest_log` DOIT utiliser les helpers défensifs** (`writeIngestLogFailureFallback`
  branche échec, `writeIngestLogSuccessSafe` branche succès), pas
  `writeIngestLog` direct. Source unique du pattern de survie audit.
- Dette résiduelle parquée : `getLastSuccessChecksum` peut throw via
  `getIngestLogClient` sans try/catch dédié (silent gap noté par
  silent-failure-hunter mais hors scope V0.12.3 — pas une régression
  introduite). À traiter dans une V0.13+ ou si une trace prod apparaît.

## [0.12.2] — 2026-05-20

### Added

- **Marqueur `forced` dans `ingest_log` (P1 backlog cleanup).** Un run
  déclenché via `FORCE_REINGEST=1` (workflow_dispatch) qui réingère
  pleinement alors que le CSV upstream est byte-identique au dernier
  success était jusqu'ici indistinguable d'un cron normal en audit.
  Ajout d'une colonne `forced BOOLEAN NOT NULL DEFAULT FALSE` peuplée
  par `shortCircuitIfSameChecksum(..., force=true)` (chokepoint unique).
  Audit : `SELECT * FROM ingest_log WHERE forced=true`. Index partiel
  `WHERE forced=true` (rare → minimal). Migration
  `20260520T140000_ingest_log_forced.sql`.

- **Helper `expectSingleRow()` partagé (P2 dette /simplify).** Le pattern
  defense-in-depth « RPC censée retourner ≤ 1 row, warne LOUD si N > 1 »
  était dupliqué inline dans `finess-db.ts` (`finess_by_num_finess`) et
  `cds-db.ts` (`centres_sante_by_finess`). Factorisé dans
  `src/sante/db-helpers.ts` — signature `(rpc, rows, identifier, hint)`,
  le hint d'investigation reste propre à chaque RPC (préserve grep ops).

- **JSON-RPC `-32700 Parse error` propre sur JSON malformé (P2 backlog
  cleanup).** Le `catch` root de `api/mcp.ts` route maintenant les
  `SyntaxError` (JSON body malformé caller-side) vers une réponse 400
  JSON-RPC `-32700` conforme spec §5.1, **sans `captureMcpError`**
  (faute caller ≠ erreur serveur). Complète le drop bot-noise
  `beforeSendEvent` côté Sentry en évitant l'appel tout court. Path
  Sentry préservé pour toute autre exception (test garde-fou).

### Changed

- **`writeIngestLog` durci contre PGRST204 transitoire.** Si la migration
  ajoutant un champ optionnel (`forced`, `ban_eligible_distinct`,
  `ban_to_geocode_distinct`) n'est pas encore appliquée en prod au moment
  où le code TS écrit dans `ingest_log`, PostgREST renvoie `PGRST204`
  (colonne inconnue) et le log entier était jusqu'ici avalé
  silencieusement (`writeIngestLog` ne throw pas). Retry défensif unique
  qui re-tente l'insert sans les champs listés dans
  `PGRST204_RECOVERABLE_FIELDS` — les marqueurs récents sont sacrifiés
  mais le reste de l'audit survit. `console.warn` explicite mentionne
  les champs droppés pour le diagnostic ops. **Convention** : tout
  nouveau champ optionnel dans `IngestLogEntry` DOIT être ajouté à
  cette liste jusqu'à propagation de sa migration en prod (puis peut
  être retiré).

- **`writeIngestLog` accepte un client optionnel en injection** pour
  faciliter le test (pattern symétrique à `runCanaryCheck`). Default
  inchangé (`getIngestLogClient()`), rétrocompat callers préservée.

### Notes maintainers

- Pour la prochaine release, **appliquer `20260520T140000_ingest_log_forced.sql`
  en prod AVANT de déployer le code TS** (best-effort — le retry défensif
  protège la fenêtre transitoire si l'ordre est inversé, mais le marqueur
  `forced` est perdu pendant cette fenêtre).
- 8 items du backlog technique initial ont été audités comme **déjà
  soldés** dans le code (`buildListQueryResult` migré, `insertStagingBatched`
  factorisé, `getUntypedAnonClient` substitué au `null as unknown as
  string`, `resolveCategorieCodes` utilisé partout, `drop-stale-previous`
  existant, circuit breaker Axiom existant, tests 429 INSEE+ANS
  existants). 1 item droppé (`count_rpps.sql` divergence — artefact
  session précédente). 1 item écarté par règle prod-first (`searchEntreprises`
  400 retry — aucune trace Sentry, défense préventive refusée).

## [0.12.1] — 2026-05-20

### Changed

- **Descriptions tools RPPS refondues pour la clarté LLM (-31 % de chars
  sur 4 tools, ~680 tokens économisés par session client MCP).** Pas de
  changement de logique runtime — refactor strings uniquement. Triggers
  d'usage et hiérarchie d'info repensés pour un LLM client (Claude.ai,
  Cursor, agents) :
  - **Action-first opening** sur les 5 tools RPPS (« Trouve », « Liste »,
    « Récupère ») — cohérence verbale, décision LLM en <30 mots.
  - **`precise_only` hoisté en lead** dans `professionnels_rpps_in_radius`
    (bloc « **Param critique** — Défaut `false` ... À `true` ... »
    AVANT les détails sur les filtres et catégories). Le défaut est
    annoncé avant le comportement opt-in.
  - **Constant `RPPS_GEO_PRECISION_HINT` factorisé** sur 3 consommateurs
    (`professionnels_rpps_par_dept`, `rpps_search_by_name`,
    `professionnel_by_rpps`) — DRY symétrique à
    `RPPS_INCLUDE_CATEGORIES_HINT`. Le tool `professionnels_rpps_in_radius`
    documente la sémantique étendue (precise_only + branches hybrides +
    couverture %) inline et n'utilise PAS ce hint court — intent volontaire
    documenté en JSDoc + gardé par test de parité.
  - **`RPPS_INCLUDE_CATEGORIES_HINT` compressé** de ~140 à ~50 mots
    (5 consommateurs bénéficiaires, bonus pour les tools non touchés
    `rpps_dans_etablissement` + `densite_professionnels_sante`).
  - **`inputSchema.precise_only.description` ne re-documente plus la
    sémantique du tool** (anti-drift inter-edits) — 1 ligne pointant la
    description du tool. Le marqueur `V0.12.0 —` parasite retiré.
  - **`rpps_dans_etablissement` documente coords:null** + pointe le pivot
    `etablissement_by_finess` (ferme l'asymétrie LLM des 5 tools RPPS).
  - Markdown unifié : backticks pour identifiants techniques, ASCII pour
    exemples de prose (suppression des `« »` français en doc technique).
  - Suppression des `(V0.12.0)` parasites dans les prose LLM-facing
    (sans intérêt pour un caller, marqueurs internes seulement).
- **`RawRppsRow.geo_precision` réutilise `PerResultGeoPrecision`** (cohérent
  avec V0.12.0, source unique de vérité).

### Added

- **Tests régression renforcés** :
  - Assertion `precise_only.description` durcie : passe de regex tautologique
    (`/centroide commune|distance_km/i` matchait n'importe quoi grâce à
    l'alternation et l'accent manquant) à 4 assertions structurelles
    (verbe d'exclusion, `centro[iï]de commune`, `distance_km`,
    `défaut false`) + borne anti-rebond drift (<300 chars).
  - Nouveau test direct sur la constante `RPPS_GEO_PRECISION_HINT` :
    verrouille les 3 valeurs canoniques + la nuance `~3 km` centroïde
    présentes dans les 3 callsites. Ferme la classe « régression de la
    constante propagée silencieusement aux 3 consommateurs ».
  - Nouveau test sur `rpps_dans_etablissement` : verrouille la note
    `coords/distance_km = null` + le pointeur `etablissement_by_finess`.
    Sans cette assertion, un dev qui simplifie la description en futur
    edit pourrait retirer la ligne et casser l'asymétrie LLM
    silencieusement.
- **`.gitignore` allowlist `.claude/*`** au lieu d'entry-par-entry —
  évite N commits `.gitignore` futurs à chaque nouveau fichier généré
  par le harness Claude Code (settings.local, scheduled_tasks.lock,
  cache/, transcripts/…). Exceptions explicites possibles via
  `!.claude/<chemin>` (note dans le commentaire : parent + fichier requis
  pour les sous-dossiers).

### Tests

- **1 191 tests verts** (était 1 189 V0.12.0). +2 nouveaux régression :
  garde-fou constante `RPPS_GEO_PRECISION_HINT`, garde-fou
  `rpps_dans_etablissement` coords:null.

### Discipline post-fix

Cycle complet appliqué sur ce refactor pourtant léger (4 commits) :
- /simplify (3 agents reuse/quality/efficiency en parallèle) : 4 H + 4 M
  + 4 L appliqués (commit `bc58938`).
- /review Passe 1 (3 agents code-reviewer + silent-failure-hunter +
  code-simplifier) : 2 H + 3 S, fixes appliqués (commit `92a6022`).
- /review Passe 2 (2 agents) : GO unanime + 1 S de polissage gitignore
  (commit `<this>`).
- 4 commits cumulés, traçabilité fine.

### Migration notes (op)

Aucune migration SQL (refactor strings uniquement). Aucune action prod
requise au-delà du redéploiement Vercel automatique sur push main.

## [0.12.0] — 2026-05-20

### Added

- **`geo_precision` exposée par-résultat sur 4 RPC RPPS + paramètre
  `precise_only` pour ne renvoyer que les PS géolocalisés précisément.**
  La précision conquise par la PR #23 (FINESS join, V0.10.x) et le `ban_join`
  keyset (V0.11.0) était calculée en DB mais JETÉE à la sortie : le mapping
  TS `toResult` (`src/sante/rpps-db.ts:719`) hardcodait `geo_precision:
  "centroide_commune"` pour TOUS les PS, même les ~68,5 % géolocalisés
  précisément (BAN rue/bâtiment ou FINESS site). L'audit factuel produit
  2026-05-20 a établi : 3 tools renvoyaient cette valeur hardcodée, 2
  descriptions publiques contredisaient la réalité produit (« tous les PS
  d'une même commune ont la MÊME `distance_km` » — faux pour les ~68,5 %
  `finess_join`/`ban_address`).
  - 4 RPC élargies pour propager `geo_precision` ∈ {`adresse`,
    `etablissement_finess`, `centroide_commune`} :
    - `rpps_in_radius` (V0.11.0 déjà étendue via `20260516T050000`).
    - `rpps_search_by_name` — migration `20260520T110000`.
    - `rpps_par_specialite_dept` — migration `20260520T120000`.
    - `rpps_lookup_by_id` — migration `20260520T130000`.
    Mapping `CASE WHEN geom_source` IDENTIQUE sur les 4, gardé par
    `scripts/ingest/rpps-geo-precision-mapping-parity.test.ts` (5 tests
    structurels sans DB, pattern aligné sur `ban-eligibility-predicate-parity`).
  - Type TS `PerResultGeoPrecision` élargi aux 3 valeurs, mapping `toResult`
    lit `row.geo_precision` au lieu de hardcoder (fallback OMISSION, jamais
    `centroide_commune` silencieux qui masquerait une régression DB).
  - Nouveau alias metadata `centroide_commune_ans_mixte` (`src/core/query-metadata.ts`)
    avec note explicite « précision MIXTE par-résultat, lire `geo_precision`
    PAR PS ». Note nuancée injectée à `radius_km < 3 km` qui pointe
    `precise_only` plutôt que la note Ameli générique (cette dernière
    affirme à tort « TOUS les PS d'une commune en bloc » — faux pour la
    branche précise hybride).
- **Param `precise_only: boolean` sur `professionnels_rpps_in_radius`.**
  Migration `20260520T100000_rpps_in_radius_precise_only.sql` ajoute
  `p_precise_only BOOLEAN DEFAULT FALSE`. Quand `true`, la CTE centroïde
  commune est entièrement court-circuitée (`WHERE NOT p_precise_only`),
  aucun PS au centroïde n'est inclus, le tri est 100 % par distance exacte
  BAN/FINESS. La sentinelle P0002 matview vide est sautée puisque la
  branche précise ne dépend pas de la matview. Quand `false` (défaut),
  contrat V0.11.0 préservé BYTE-pour-byte. Cas d'usage typique : rayons
  courts (<3 km), classement intra-commune fiable, « médecins à <500 m
  d'une adresse ». Trade-off documenté : ~31,5 % de PS invisibles en
  `precise_only=true`.
- **Descriptions LLM des 4 tools RPPS réécrites.** Mentionnent
  explicitement les 3 valeurs `geo_precision`, la part de précision
  conquise (~68,5 %), le paramètre `precise_only` et la nuance
  intra-commune (qui reste pertinente uniquement pour la branche
  centroïde résiduelle en mode hybride par défaut).
- **Garde runtime côté lib `toResult`** : `assertGeoPrecision(row)` throw
  bruyamment si la RPC renvoie une valeur hors set canonique (drift RPC =
  contract violation, jamais silencieux). `warnIfAnomalous(row, coords)`
  warn explicitement si la RPC émet une `geo_precision` sur un PS sans
  coordonnées exploitables (invariant amont violé observable, plus mangé
  sans signal). Couvre les 2 cas (geom null ET coordinates malformé).
- **Note metadata explicite quand `precise_only=true && count=0`** :
  distingue zone désertique légitime d'une régression GiST partielle (cf.
  CLAUDE.md gotcha `rpps-in-radius-57014-partial-gist-decouple`) — le LLM
  peut alors suggérer le mode hybride au user.

### Changed

- `RawRppsRow` gagne `geo_precision?: PerResultGeoPrecision | null` (additif,
  non breaking) — réutilise le type pour éviter une 2e source de vérité.
- Test régression B5 (`api/tools.test.ts`) réécrit pour V0.12.0 — verrouille
  les 3 valeurs canoniques + la narration `precise_only` (pas juste le mot)
  + le taux `31,5 %` (sentinelle anti-régression de la description).
- `centroide_commune_ans` (alias V0.10.x) marqué `@deprecated` — plus aucune
  RPC ne le produit, conservé pour rétrocompat de clients qui auraient
  caché la string `query_metadata.geo_precision`.
- Handler `professionnels_rpps_in_radius` utilise désormais
  `coerceBoolean(args.precise_only, "precise_only")` (pattern dominant du
  fichier : un client JSON-RPC stringifiant `"true"` est correctement
  reconnu ; `"yes"` throw `RangeError` actionnable plutôt que retomber
  silencieusement en hybride).
- Lib publique `getRppsInRadius` validate `typeof input.preciseOnly`
  (cohérent avec `validateCoords`/`validateRadiusKm`) — protection caller
  npm hors MCP qui n'a pas le filet `coerceBoolean`.

### Tests

- 1 189 tests passent (était 1 159 V0.11.0). +30 tests dédiés à V0.12.0 :
  - 5 dans `rpps-db.test.ts` — propagation 3 valeurs, omission contrôlée
    quand RPC ne renvoie pas la colonne (anti-hardcode), propagation
    param `preciseOnly` true/false strict, contract violation runtime,
    warn invariant amont, note metadata 0 résultats, garde boundary lib.
  - 6 dans `tools.test.ts` — descriptions 4 tools, schema `precise_only`,
    narration utile asserée, taux 31,5 %, boundary MCP `"yes"` → throw.
  - 6 dans `query-metadata.test.ts` — note Ameli pure vs RPPS mixte
    nuancée, seuil exact 3 km, alias mixte propagé.
  - 5 dans `rpps-geo-precision-mapping-parity.test.ts` (nouveau guard
    structurel) — verrouille byte-identique le mapping `geom_source →
    geo_precision` sur les 4 RPC + le hardcode `'centroide_commune'::text`
    de la branche centroïde de `rpps_in_radius`, regex LARGE sur source
    ET valeur (filet contre l'ajout silencieux d'un 4e `geom_source`).

### Migration notes (op)

- Les 4 migrations sont au format T (`YYYYMMDDTHHMMSS_*.sql`). Pattern
  documenté du projet : application prod **manuelle** via SQL Editor
  Supabase (la CLI `supabase db reset` les skip côté local — cf.
  `ban-geocode-parity.integration.test.ts:311`). Ordre d'application :
  `T100000` (rpps_in_radius précise_only) → `T110000` (search_by_name)
  → `T120000` (par_specialite_dept) → `T130000` (lookup_by_id).
- DROP+CREATE obligatoire sur les 4 RPC (RETURNS TABLE change, +1 colonne
  `geo_precision`) — ERROR Postgres `42P13` sinon. Les `GRANT EXECUTE TO
  anon` sont re-posés dans chaque migration (DROP les révoque).
- Aucun changement de matview ni d'index. Pas de bombe OID (toutes les
  matviews sont reconstruites post-swap, pas refresh-only — V0.11.0).

## [0.11.0] — 2026-05-20

### Added

- **Phase 1 mesure du delta BAN mensuel (brique observabilité pré-automatisation).**
  Nouvelle RPC `rpps_measure_ban_to_geocode(p_source_table)` retournant 2
  comptages atomiques (en 1 passe planner via `count(*)` + `count(*) FILTER`) :
  (a) `eligible_distinct` = adresses distinctes éligibles BAN dans la source
  whitelistée, (b) `to_geocode_distinct` = sous-ensemble NON encore résolu/capé
  dans `geocoded_addresses`. Appelée par `scripts/ingest/rpps.ts` entre
  l'enrichment FINESS (5b) et `ban_join` (5c), **best-effort** : un échec
  (timeout, RPC absente, contrat cassé) → `console.warn` + log NULL dans
  `ingest_log` + run continue (Phase 1 = observabilité, JAMAIS gating). 2
  colonnes `INTEGER` nullable ajoutées à `ingest_log` (`ban_eligible_distinct`,
  `ban_to_geocode_distinct`). Pattern aligné sur `rpps_count_ban_eligible_rows`
  (SECURITY DEFINER + REVOKE FROM PUBLIC + whitelist CASE source_table +
  `SET statement_timeout='55s'` sous cap passerelle PostgREST 60s). Garde-fous
  étendus : `ban-eligibility-predicate-parity` 7e site (le prédicat de la
  mesure DOIT rester byte-identique aux 6 autres — sinon la mesure
  dimensionne Phase 2 sur un set différent de celui que `ban_join` traite),
  `enrichment-statement-timeout` 2 nouveaux tests anti-drift. Discipline
  complète : /simplify 3 agents (4 fixes), /review Passe 1 (3 agents, 4
  corrections), /review Passe 2 (2 agents, GO unanime). 1165 tests verts.
  But : permettre de dimensionner la future Phase 2 (automatisation du
  re-géocodage récurrent) sur le **vrai chiffre prod du delta mensuel** au
  bout d'1-2 cycles, en respectant « prouver par la prod avant de coder ».

### Fixed

- **Acceptation BAN par PRÉCISION au lieu d'un gate binaire 0,7 —
  ~34k adresses récupérables, prouvé prod.** Cause-racine vérifiée
  (code + 500 rejetées re-géocodées + doc BAN) : `ban-bulk-client.ts`
  n'acceptait un géocodage que si `result_score ≥ 0,7` ET
  `result_type ∈ {housenumber, street}` ; tout le reste → `accepted=false`,
  coords mises à NULL par `ban-backfill.mjs`, et ~40k médecins retombaient
  au centroïde commune (~3 km) alors que la BAN renvoyait un point
  rue/bâtiment CORRECT (81 % des rejetées ont des coords ; ~90 % des
  `housenumber` 0,5–0,7 sont le bon bâtiment — score bas = abréviations
  RPPS `R`/`BD`/`AV` + accents, PAS une mauvaise localisation). `result_type`
  est la garantie de précision géographique ; `result_score` n'est qu'une
  confiance fuzzy-match. Règle produit : un point rue/lieu-dit est
  STRICTEMENT meilleur que le centroïde commune. Fix : seuil
  `BAN_ACCEPT_SCORE` 0,7 → **0,5** (`scripts/ban-backfill.mjs`) +
  acceptation `type ∈ {housenumber, street, locality}` (`municipality`
  exclu = aucun gain vs centroïde) dans `src/core/ban-bulk-client.ts`.
  Recovery cache-only prouvée prod : **66 % d'acceptation** sur les
  rejetées (vs 0 % avant), cache `geocoded_addresses` re-rempli ; le
  `ban_join` du cron mensuel posera ces coords (écriture cache-only, hors
  swap, idempotent — aucune écriture `rpps` hors cron). Garde-fou test
  `ban-bulk-client.test.ts` (housenumber|street|locality acceptés ≥ seuil,
  `municipality` rejeté). L'ancien commentaire « JAMAIS 0.5 » (leçon
  audit-P2) valait pour l'accept binaire-précis ; ici la sémantique est
  « upgrade vs centroïde », documentée inline.

### Added

- **Levier `force` (Option B) — ré-ingestion RPPS forcée malgré checksum
  identique.** Input booléen typé `force` du `workflow_dispatch` de
  `ingest-rpps.yml` → env `FORCE_REINGEST` → helper pur
  `isForceReingestEnv` (accepte `"1"`/`"true"`, trim, casse-insensible ;
  tout le reste = pas de forçage, échec sûr) → 5ᵉ param `force` de
  `shortCircuitIfSameChecksum` (chokepoint partagé ; early-return AVANT
  tout I/O, audit intact ; opt-in RPPS uniquement, 3 autres sources
  inchangées). But : réappliquer en prod le cache BAN géocodé (266 049
  adresses acceptées) jamais posé, le fichier ANS n'ayant pas changé
  (court-circuit SHA256 sinon permanent). Garde-fou : test `it.each`
  10 cas verrouillant le contrat de la var d'env ; commentaire YAML
  durci interdisant `github.event.inputs.force` (stringifie → `"false"`
  truthy → force à chaque cron). Backlog connu (hors-scope, non
  bloquant) : pas de marqueur `forced` distinct en `ingest_log` — un run
  forcé sur source identique se loggue comme un run complet normal ;
  l'opérateur le voit via le `console.warn` mais pas l'analyste DB.

### Fixed

- **Bombe OID matview Ameli — dette P1 close (symétrique du fix RPPS).**
  `ameli_nomenclature_stats` (`FROM annuaire_ameli`) + `REFRESH`-only
  post-swap suivait l'OID (désync 1er cron) puis subissait le `DROP CASCADE`
  du 2e swap → `lister_specialites_ameli`/`lister_types_ps_ameli` down
  masqué en `partial`. Ameli étant HEBDO, le risque était réel (non masqué
  durablement par `shortCircuitIfSameChecksum`). Réplication 1:1 du patron
  prouvé prod `ingest_rebuild_rpps_matviews` : nouvelle RPC
  `ingest_rebuild_ameli_matviews` (migration `20260519T200000`,
  build-new + RENAME atomique, `FROM annuaire_ameli` résolu PAR NOM ;
  SELECT + UNIQUE INDEX verbatim de la matview canonique `20260515T020100`).
  `refreshAmeliMatviews`→`rebuildAmeliMatviews` (transitoire→`partial` sans
  throw ; structurel→throw LOUD, durcit l'ancien `42P01` avalé). DROP sans
  CASCADE prouvé prod (les 2 RPC `LANGUAGE sql` ≠ dépendance catalogue).
  Garde-fou `ameli-matview-rebuild.test.ts` + `staging-parity` adapté.
  `/simplify` + `/review` P1+P2 = RAS (réplication patron prouvé).
- **Régression PROUVÉE prod `rpps_in_radius` 57014 en commune dense
  (hotfix + durabilité).** La fonction hybride `rpps_in_radius` (CTE
  `precise` filtrée `geom_source IN ('finess_join','ban_address')`) exige
  le GiST PARTIEL `rpps_geog_precise_gist`. Le désamorçage du timeout cron
  (`20260518T140000`) recopiait verbatim la def `main` de
  `ingest_create_rpps_staging` créant le GiST **global**
  `rpps_staging_geog_gist` → au 1er swap, le RENAME revertait
  `rpps_geog_precise_gist` → `rpps_geog_gist` global, et la CTE `precise`
  scannait alors tout le cluster co-localisé `commune_centroid` (Paris
  1 km : 77 381 lignes dont 76 940 jetées en Filter pour 225 résultats)
  → SQLSTATE 57014. Deux firefights concurrents (BAN-rearm vs
  désamorçage cron) avaient découplé la fonction hybride de son index
  compagnon. **Hotfix prod 2026-05-19** : `DROP INDEX rpps_geog_gist` +
  `CREATE INDEX rpps_geog_precise_gist ... WHERE geom_source IN
  ('finess_join','ban_address')` (transaction atomique, vérifié : Paris
  1 km / 10 km sans filtre → OK).
- **Durabilité : migration `20260519T160000_rpps_staging_geog_precise_gist`**
  — `ingest_create_rpps_staging` (recopie VERBATIM de `20260518T140000`,
  SEULE diff intentionnelle) crée désormais `rpps_staging_geog_precise_gist`
  (GiST partiel, prédicat byte-identique RPC ↔ `20260516T050000` ↔
  garde-fou) au lieu du GiST global. Au swap, `ingest_atomic_swap` le
  renomme `rpps_geog_precise_gist` → le fix d'index survit au cron mensuel.
  À appliquer manuellement en prod (naming `YYYYMMDDThhmmss`, sauté par la
  CLI Supabase).

### Changed

- **Refonte BAN → `ban_join` (pose ensembliste keyset, prouvée prod).** Le
  step BAN du cron RPPS (build d'index Unicode-lourd via RPC PostgREST +
  géocodage API) était **structurellement impossible** : Supabase plafonne
  tout appel Client API à 60 s en dur (réfuté prod run #26087010166). Le
  cache `geocoded_addresses` (266 049 adresses) étant rempli hors cron
  (`ban-backfill.mjs`, inchangé), il devient « une table à joindre » comme
  FINESS. Nouvelle RPC `ingest_apply_rpps_ban_join_batch(p_after, p_limit)`
  (migration `20260519T180000`, `statement_timeout='55s'`) : `UPDATE
  rpps_staging ⟕ geocoded_addresses` sur la clé d'adresse normalisée,
  **piloté curseur keyset** (jamais sentinelle — prouvé prod : sentinelle =
  re-scan quadratique → 57014 fin de parcours ; keyset = ~4,8 s/lot
  constant, ~11 min linéaire). Helper générique `runKeysetRpc`
  (`shared.ts`, garde de non-progression + anti-hang). Steps 5c/5d/5e
  supprimés du cron ; `runBanGeocodeStep` + 8 constantes/imports BAN
  supprimés. Garde-fous parité étendus à `ban_join` (6ᵉ site prédicat,
  expression via WRAPPER, `statement_timeout` ≤55 s) + test d'intégration
  DB locale (HIT/MISS/non-éligible/idempotence). Hors scope (décidé PO) :
  `ban-backfill.mjs` inchangé ; automatisation backfill = feature
  ultérieure (dette tracée : dépend des index BAN sur `rpps`). Spec/plan :
  `docs/plans/2026-05-19-ban-join-{design,implementation-plan}.md`.
- **Garde-fou `scripts/ingest/staging-parity.test.ts` durci** (le guard
  `indexColumnLists` historique était AVEUGLE : global et partiel
  normalisent à la même liste de colonnes `geog`). Nouvelle assertion
  forme POSITIVE sur CHAQUE GiST `rpps_staging(geog)` (exige le prédicat
  partiel) — résiste à `IF NOT EXISTS` / `public.` / `WITH (...)` /
  coexistence partiel+global ; parité consommateur croisée vs
  `rpps_in_radius` ; lecteur STRICT tag-aware
  `latestFunctionBody(..., {stripComments:true})` du module (ferme les
  faux VERT « prédicat en commentaire inline » et « def future `$tag$` →
  corps mort »).


**Ré-armement du géocodage BAN sur le socle stabilisé (fix A+B+C `0.10.9`).
Les 2 index BAN ne sont plus créés dans `ingest_create_rpps_staging` (cause
du rallongement du run) ni post-swap sur la table servie, mais par une RPC
dédiée `ingest_build_rpps_staging_ban_indexes()` exécutée APRÈS l'enrichment
FINESS et AVANT le swap, sur `rpps_staging` (qui ne sert aucune lecture prod
→ `CREATE INDEX` bloquant classique sans impact). Les index voyagent dans
`rpps` via le RENAME du swap ; reconstruits à chaque cron. Doctrine
PostgreSQL « Populating a Database » (indexer APRÈS le chargement). Branche
`feat/rpps-ban-rearm` (re-port chirurgical depuis `main`, PAS un merge de la
branche bombée). Cache `geocoded_addresses` (266 049 adresses) réutilisé,
jamais re-géocodé.**

### Added

- **RPC `ingest_build_rpps_staging_ban_indexes()`** (`SECURITY DEFINER`,
  `SET statement_timeout='10min'`, migration `20260519T100000`) : crée les 2
  index fonctionnels partiels BAN (`rpps_staging_ban_eligible_normkey_idx`
  clé-seule + `..._id_idx` composite) sur `rpps_staging`, expression
  `rpps_address_key_for_index(adresse, code_postal, code_insee)` + prédicat
  d'éligibilité byte-identiques à la RPC skip-scan / au count / à
  `ingest_apply_rpps_ban_geocoding_batch` (parité gardée). JAMAIS
  `CONCURRENTLY` (table non servie ; interdit en plpgsql).
- **Étape BAN ré-injectée dans le cron RPPS** (`scripts/ingest/rpps.ts`) :
  séquence `analyze → enrichment → build_ban_indexes (fail-loud) →
  re-analyze → runBanGeocodeStep('rpps_staging') (best-effort) → swap →
  rebuildMatviews`. Les positions précises (`geom_source='ban_address'`)
  voyagent dans `rpps` au swap et sont capturées par la reconstruction des
  matviews.

### Changed

- **`ingest_create_rpps_staging` ne crée plus AUCUN index BAN** dans les
  migrations `20260517T120000` / `20260517T130000` (corps remplacé par la
  def canonique BAN-free `main`, byte-identique à `20260518T140000`) :
  ré-appliquer ces migrations ne peut plus ré-introduire la bombe 57014.
  Formes `CREATE INDEX … ON rpps` autonomes « CI/local » retirées.
- `scripts/ingest/migration-sql.ts` : module union (familles BAN stricte +
  ingestion lâche) ; `latestFunctionBody` de `main` renommé
  `latestFunctionBodyLoose` (les deux contrats coexistent volontairement).
- **Bornes anti-hang sur le cron RPPS non surveillé** (durcissement /review) :
  les RPC fail-loud 5a/5c/5d (`ingest_analyze_rpps_staging`,
  `ingest_build_rpps_staging_ban_indexes`) et l'application batch step 7
  (`runBatchedRpc`/`ingest_apply_rpps_ban_geocoding_batch`) sont désormais
  bornées par `withTimeout` (un socket figé pendait sinon jusqu'au kill
  GitHub Actions, sans `partial` ni `ingest_log`). Un dépassement →
  `IngestError` fail-loud (5a/5c/5d, tue le run avec trace) ou `partial`
  best-effort (step 7). Helpers partagés `src/core/with-timeout.ts` +
  `src/core/parse-rpc-count.ts` (dédup des jumeaux `rpps.ts`↔`ban-backfill.mjs`).


**Remédiation crise cron RPPS mensuel : 3 correctifs CONJOINTS (A+B+C)
prouvés prod. A (désamorçage index BAN) + B (robustesse matview/swap) +
C (statement_timeout fonction + ANALYZE post-COPY). Le cron de validation
A+B (run #26046475566) a RÉFUTÉ l'hypothèse « index BAN = cause du 57014 » :
même échec, prouvant une cause-racine distincte (budget 8s hérité +
absence d'ANALYZE). Les 3 s'appliquent ensemble (jamais l'un sans les
autres : désamorcer un défaut refait réussir le cron et arme les suivants).**

### Fixed

- **Désamorçage timeout 57014 du cron RPPS mensuel.** Le GATE de la feature
  BAN (branche non mergée) avait, en s'appliquant manuellement en prod,
  remplacé `ingest_create_rpps_staging` par un superset créant 2 index
  fonctionnels BAN Unicode-lourds (`rpps_staging_ban_eligible_normkey_idx`
  / `..._id_idx`). L'UPDATE de masse `ingest_apply_rpps_finess_enrichment_
  batch` recalcule alors la normalisation Unicode par ligne updatée × ~1,8 M
  → `statement_timeout` (SQLSTATE 57014) en phase `validate`, AVANT le swap
  atomique (données `rpps` intactes mais cron mensuel cassé « tout seul »
  chaque mois). Prouvé : run GitHub Actions #26029698016. Fix : migration
  `20260518T140000` = `CREATE OR REPLACE ingest_create_rpps_staging`,
  recopie VERBATIM de la dernière définition `main` (`20260516T020000`,
  dette #3), sans les 2 index BAN. + `DROP INDEX CONCURRENTLY` des 2 index
  BAN sur la table `rpps` (hors migration, non transactionnel).
- **Robustesse matviews RPPS au swap atomique (défaut OID).** Les 3 matviews
  `rpps_savoir_faire_stats` / `rpps_count_stats` / `rpps_commune_centroids`,
  définies `FROM rpps`, suivent l'**OID** de la table. La rotation par
  RENAME de `ingest_atomic_swap` + un post-swap REFRESH-only
  (`ingest_refresh_matview`) ⇒ 1er cron réussi : matviews désynchronisées
  silencieusement (données périmées servies par `rpps_in_radius` /
  `densite_professionnels_sante` / `lister_specialites_medicales`,
  status `success`) ; 2e cron : `DROP ... _previous_OLD CASCADE` les
  DÉTRUIT → `42P01` avalé en `partial`, tools santé DOWN. Jamais exercé
  (0 cron RPPS réussi depuis le 9 mai), réveillé par le désamorçage
  ci-dessus. Fix : migration `20260518T150000` = `ingest_rebuild_rpps_
  matviews` qui RECONSTRUIT les 3 matviews post-swap (build-new
  `<m>_rebuild` peuplée + index + `GRANT` puis `DROP <m>` + `RENAME`
  atomique, 1 transaction PL/pgSQL → MVCC, fenêtre nulle pour les
  lecteurs) ; `CREATE ... FROM rpps` résout la table PAR NOM (= la
  nouvelle) → corrige À LA FOIS la désync (1er cron) et la destruction
  (2e cron), et répare un état déjà dégradé (`DROP ... IF EXISTS`).
  `scripts/ingest/rpps.ts` : `refreshRppsMatviews` → `rebuildRppsMatviews`,
  contrat d'erreur DURCI (transitoire {55P03, 40P01, 57014, 53300} →
  `partial` sans throw, l'ancienne matview survit par rollback ;
  structurel / 42P01 / code absent → throw `IngestError` → `failed` +
  `process.exit(1)`, fin de l'avalement silencieux). Garde-fous : nouveau
  `scripts/ingest/rpps-matview-rebuild.test.ts` (reconstruction + parité
  DDL anti-drift) ; helpers de parsing migrations extraits dans
  `scripts/ingest/migration-sql.ts`. Défaut SYMÉTRIQUE
  `ameli_nomenclature_stats` identifié (masqué fortuitement par
  `shortCircuitIfSameChecksum`) → **backlog P1**, NON corrigé ici.
- **Cause-racine RÉELLE du timeout 57014 enrichment (le fix A seul s'est
  révélé insuffisant — prouvé prod).** Le cron de validation A+B
  (run #26046475566) a re-échoué EXACTEMENT pareil
  (`ingest_apply_rpps_finess_enrichment_batch` 57014, phase `validate`),
  réfutant l'inférence « index BAN = cause ». Cause prouvée par
  convergence (doc Supabase + `pg_roles` prod + `EXPLAIN ANALYZE`) :
  (1) le cron appelle l'enrichment via clé SERVICE_ROLE → PostgREST →
  rôle `service_role` dont `rolconfig` est NULL → il hérite du
  `statement_timeout` de `authenticator` = **8 s** ; or
  `ingest_apply_rpps_finess_enrichment_batch` (def `20260509T210000`,
  inchangée) **n'avait AUCUN `SET statement_timeout` fonction** — seule
  RPC longue du projet sans ; (2) **aucun `ANALYZE rpps_staging`** entre
  le bulk COPY (~2,24 M lignes, table fraîchement créée) et le 1er batch
  d'enrichment → planner sans statistiques → plan dégradé → un batch de
  10 K dépasse 8 s → 57014 déterministe. Les index BAN n'étaient qu'un
  **aggravant** (INSERT ralenti). Fix C (migration `20260518T160000`,
  CONJOINT avec A+B) : (C1) `CREATE OR REPLACE
  ingest_apply_rpps_finess_enrichment_batch`, corps **VERBATIM** de
  `20260509T210000` + `SET statement_timeout = '55s'` au niveau fonction
  (best practice Supabase ; `55s` < cap passerelle PostgREST ~60 s → un
  dérapage donne un 57014 propre/diagnosticable, pas un timeout
  passerelle opaque) ; (C2) RPC `ingest_analyze_rpps_staging`
  (`ANALYZE rpps_staging` + son propre `SET statement_timeout = '55s'`
  pour ne pas ré-hériter du 8 s racine), appelée par
  `scripts/ingest/rpps.ts` APRÈS le COPY et AVANT l'enrichment (échec →
  `IngestError` LOUD → `failed` + `exit(1)`). Garde-fou statique :
  `scripts/ingest/enrichment-statement-timeout.test.ts` (présence + valeur
  ≤ 55 s sur les 2 fonctions, corps verbatim anti-drift, ordre d'appel).

## [0.10.8] — 2026-05-16

**4e vague audit qualité claude.ai (stress test des 35 tools) : 7 corrections
de bugs réels (3 anomalies écartées : faux positifs / limites amont).**

### Fixed

- **A1 — `rpps_search_by_name` timeout (SQLSTATE 57014) sur nom commun sans
  `departement`.** Root cause : la RPC n'avait aucun `SET statement_timeout`
  (héritait du défaut bas du rôle `anon` ~3 s) ET le `LIMIT` s'appliquait
  APRÈS le calcul `similarity()` + top-N heapsort sur l'intégralité du
  candidate set trigram (des dizaines de milliers de lignes pour DUPONT/
  MARTIN sur 2,2 M). Le diagnostic externe « seq scan » était faux (l'index
  GIN est bien utilisé). Fix : migration `20260516T030000` — CTE qui cape le
  candidate set (`LIMIT 2000`) AVANT similarity/tri + `SET statement_timeout
  = '10s'` explicite (pattern canonique repo, cf. `rpps_in_radius`). Le
  wrapper TS mappe un 57014 résiduel en `RangeError` actionnable (JSON-RPC
  `-32602` « affiner avec departement=/prenom= » au lieu d'un `-32603`
  opaque), loggé avant le throw (panne DB réelle restant grep-able). Note
  metadata : sur nom très commun sans filtre, résultat = échantillon
  plafonné non exhaustif (à affiner).
- **A2/A4 — filtre `radius_km` silencieusement inopérant sous la résolution
  centroïde commune.** `professionnels_in_radius` / `professionnels_rpps_in
  _radius` / `centres_sante_in_radius` ont des coordonnées au centroïde
  commune : un `radius_km` < ~3 km soit retourne TOUTE la commune
  (`distance_km≈0` non discriminant), soit 0 résultat (centroïde hors rayon
  = FAUX négatif, pas un désert médical), sans aucun avertissement. Ajout
  d'une note `query_metadata` conditionnelle (`radius_km <
  CENTROIDE_COMMUNE_RESOLUTION_KM`) explicitant le piège dans les deux sens.
  Pas de clamp silencieux du rayon (principe repo).
- **A3 — `population_par_commune` sur arrondissement PLM (75101…) : message
  générique inutile.** Le garde-fou PLM (`parentCommuneInsee`/`plmDept`,
  source unique `commune-index`) existait mais n'était pas branché ici.
  Désormais un code arrondissement renvoie un `lookupNotFound` explicite
  orientant vers la commune-mère (75056/69123/13055) ou
  `population_par_departement`. La commune-mère reste un code valide.
- **A5 — `compare_adresse_cnam_vs_finess` : faux `divergent_after_
  normalization` sur simple abréviation de voie** (« 3 R THENARD » vs « 3
  RUE THENARD » = même adresse). Nouveau statut
  `match_after_abbreviation_normalization` via une expansion d'abréviations
  FR (R/RUE, BD/BOULEVARD, AV/AVENUE…) LOCALE au tool — `normalizeForCompare`
  partagé (cross-source/siret/coverage/geocode) n'est volontairement PAS
  modifié (blast radius scoring).
- **A8 — libellé secteur conventionnel Ameli trompeur** : le CSV CNAM
  étiquette le code « 3 » (Secteur 2 + droit permanent à dépassement) sous
  le même libellé « Secteur 2 » que le code « 2 ». Helper
  `clarifySecteurLibelle` (même discipline drift-detection que
  `clarifyTypePsLibelle` : ne réécrit pas une source qui a drifté) appliqué
  à la restitution → « Secteur 2 + droit permanent à dépassement (S2+DP) ».
- **A9 — doc `population_par_departement` mensongère sur Mayotte (976)** :
  la docstring annonçait « DOM 971-976 » mais 976 est absent de
  DS_POPULATIONS_REFERENCE → 404 INSEE Melodi non géré (le catch ne traitait
  que 400 → `throw` brut). Docstring corrigée + catch étendu `400 || 404` →
  `lookupNotFound` (absence de donnée, pas une panne).
- **A10 — `reverse_geocode` hors couverture (ex. New York) → `null`
  silencieux.** Description du tool documentée (couverture France
  métropolitaine + DOM, `null` = absence, pas erreur) + `console.warn`
  agrégé serveur quand l'IGN ne renvoie aucune feature (parallèle au warn
  `usableGeocodeResults`). Pas de migration vers `LookupResult` (breaking,
  la famille géo a sa propre convention `confidence_low`/`match_partial`).

### Internal

- Constante `PG_STATEMENT_TIMEOUT` (`db-helpers`) — fin du littéral SQLSTATE
  « 57014 » dispersé (boundary lib + tests).
- `isSubCommuneRadius` type guard (`query-metadata`) — prédicat nommé pour
  la note radius sous-commune.

**Anomalies écartées (pas des bugs réels)** : A6
(`entreprise_by_siren("999999999")` payload creux — SIREN synthétique de
test ; les SIREN diffusion-partielle sont absents de DINUM, jamais
`found:true` creux) ; A7 (PS RPPS `coords:null` non flaggés — donnée amont
légitime, visible par site, pas un bug) ; A11 (libellés FINESS tronqués —
déjà documenté, code fidèle à DREES amont).

## [0.10.7] — 2026-05-16

**3e vague audit qualité claude.ai (test des 35 tools) : 3 corrections +
solde des dettes techniques backlog.**

### Changed

- **BREAKING (mineur, OSS pré-1.0) — P1 : `raison_sociale` déplacé de
  `AmeliResult.identite` vers `AmeliResult.adresse`.** La raison sociale est
  un attribut de SITE (la structure d'exercice), pas d'identité : un
  praticien exerçant sous deux raisons sociales était scindé en deux entrées
  par `dedupe_by_ps` (`professionnels_par_specialite_dept`,
  `professionnels_in_radius`) au lieu d'être regroupé en une personne avec
  `sites[]`. `raison_sociale` est désormais sous `adresse` (donc présent par
  site dans chaque entrée de `sites[]`) et retiré de la clé de déduplication
  (clé = nom + prénom + civilité + spécialité + type PS). La sortie des tools
  Ameli porte donc `adresse.raison_sociale` au lieu de `identite.raison_sociale`.
  La suggestion d'exposer un `rpps_id` joignable n'est PAS retenue : la source
  Annuaire Ameli ne porte aucun identifiant PS pérenne (cross-référencer ANS
  RPPS côté caller).

### Fixed

- **P2 : `geocode_adresse` — seuil `confidence_low` par type de match IGN
  + flag `match_partial`.** Un seuil global unique (0,5) laissait passer des
  faux `housenumber` plausibles (l'IGN substitue une autre voie au même
  numéro avec un score ~0,55-0,65 présenté comme fiable). Seuils désormais
  propres au type : `housenumber` 0,7, `street`/`locality` 0,6,
  `municipality`/inconnu 0,5. Nouveau champ `match_partial` (Dice < 0,7 entre
  l'adresse demandée normalisée et le libellé IGN) : capte le « score
  correct mais l'IGN a répondu une AUTRE adresse ». Conservateur par
  construction (query brute vs label complet) — à traiter comme « re-vérifier »,
  pas « erreur certaine ». Absent en géocodage inverse.
- **P3 : message d'erreur amont actionnable + retry des réponses non-JSON
  transitoires.** Une `HttpError` (502/503 geo.api.gouv.fr, INSEE…) remontait
  en `-32603` avec un message opaque : le caller ne pouvait pas distinguer
  « bug serveur » de « dépendance amont transitoire, réessaie ». Le message
  caller-facing expose désormais le HOST + le STATUT amont (infrastructure
  publique, ni la query — input du caller — ni le body ne fuient ; détail
  complet préservé côté Sentry). Une `SyntaxError` JSON (page HTML d'erreur
  amont) est désormais RETRYÉE comme un 5xx (transitoire, bornée par
  `maxRetries`) au lieu d'échouer immédiatement.

### Internal (dette technique soldée, sans impact API)

- 5 call-sites manuels `expectRpcRows → slice → map` (`finess-db`,
  `ameli-db`, `rpps-db` ×3) migrés vers le helper partagé
  `buildListQueryResult` (source unique du contrat `QueryResult`).
- Boucle insert-staging + retry schema-cache miss (dupliquée à l'identique
  dans `finess.ts`/`ameli.ts`/`rpps.ts`/`cds.ts`) factorisée en
  `insertStagingBatchWithRetry` (`scripts/ingest/shared.ts`) — préserve la
  `cause` Supabase complète (FINESS la perdait), codes PGRST205/204 nommés.
- `normalizeForCompare`/`diceCoefficient` extraits vers `core/text-match.ts`
  (consommés par `sante/` ET `territoire/` — résout l'inversion de couche ;
  `address-match.ts` les ré-exporte, consommateurs historiques inchangés).
- Prédicat `isTransientHttpStatus` (`core/http.ts`) : source unique de la
  sémantique « 429/5xx = transitoire » (était dupliquée 3×).
- Filets de sécurité : test verrouillant l'invariant RPPS « geom NOT NULL
  ⟹ code_insee NOT NULL » (dont dépend le LATERAL early-stop de
  `rpps_in_radius`) ; test verrouillant qu'un échec de refresh
  `rpps_commune_centroids` bascule `last_attempt_status='partial'` en le
  nommant (pas de rayon figé silencieux).

## [0.10.6] — 2026-05-16

**Backlog Robustesse : 2 garde-fous anti-panne-silencieuse + nettoyage index
prod + bump CI Node 24.**

### Added

- **Dette #1 — validation nomenclature ANS au boundary.**
  `densite_professionnels_sante` avec un `profession_code` / `savoir_faire_code`
  inexistant — ou un code Ameli homographe (`specialite_code`/`type_ps_code`,
  nomenclature DISTINCTE) passé à un paramètre ANS — renvoyait `countPs:0` →
  densité 0 **silencieuse et indistinguable d'un vrai zéro** (faux « désert
  médical » plausible). La description MCP (audit B3) prévenait le LLM mais ne
  protégeait pas un caller programmatique npm. Nouveau garde-fou exécutable :
  RPC `rpps_nomenclature_exists` (valide les 2 codes contre la matview
  **non filtrée** `rpps_count_stats` = source réelle de `count_rpps` ;
  matview vide → `known=true` pour ne jamais bloquer un code valide) + helper
  lib `assertKnownRppsCodes` appelé dans `densiteProfessionnelsSante` AVANT
  les counts, **no-op (zéro I/O) si aucun code explicite fourni**. Code
  inconnu → `RangeError` (JSON-RPC `-32602`) orientant vers
  `lister_specialites_medicales`. Lève l'asymétrie historique (la densité
  throw déjà si population introuvable, jamais si code inconnu).

### Fixed

- **Dette #2 — `geocode` : coordonnées IGN dégradées propagées
  silencieusement.** `toGeocodeResult` déstructurait `feature.geometry
  .coordinates` sans validation → `lon/lat` `undefined` poussés dans `point`
  (même anti-pattern que le score, fix B1). Désormais validé via le helper
  partagé `parseCoordinates` ; une feature inexploitable est écartée
  (`toGeocodeResult` → `null`, `geocodeMany` filtre, `reverseGeocode` itère
  jusqu'au 1er candidat valide au lieu de prendre aveuglément `features[0]`).
  Warn `[france-data-mcp]` par feature + warn **agrégé** quand l'IGN renvoie
  des features mais qu'AUCUNE n'est exploitable (un résultat vide n'est alors
  PAS « adresse introuvable » : anomalie payload remontée, plus de
  mauvaise attribution côté caller type `coverage.ts`).

### Changed

- **Dette #3 (ops) — suppression de l'index `rpps_insee_idx (code_insee)`**
  rendu redondant par le composite `rpps_insee_id_idx (code_insee, id)`
  (V0.10.2). `DROP INDEX` prod + `ingest_create_rpps_staging` recréée en
  superset strict MOINS l'index mono-colonne (parité staging conservée :
  sans ça le swap mensuel le ré-introduisait). Garde-fou
  `scripts/ingest/staging-parity.test.ts` généralisé : `liveIndexColumnLists`
  honore désormais `DROP INDEX` PAR NOM (set prod *vivant* = creates − drops),
  regex de drop ancrée sur le `;` terminal pour qu'une prose de commentaire
  (« drop index X someday ») ne dé-tracke pas silencieusement un index vivant.
- **Dette #4 (infra) — bump GitHub Actions vers des runtimes Node 24.**
  `actions/checkout@v6`, `actions/setup-node@v6`, `pnpm/action-setup@v6`,
  `actions/github-script@v9`, `supabase/setup-cli@v2` sur les 6 workflows
  (le runtime Node 20 des actions était déprécié pour juin 2026).

## [0.10.5] — 2026-05-16

**2e vague audit qualité claude.ai (P1→P4, re-test post-0.10.4) : garde-fou
PLM, endpoint DINUM proximité, primitive divergence d'adresse CDS. 933 tests.**

### Changed

- **BREAKING (mineur, OSS pré-1.0) — P3 : `entreprises_in_radius` recherche
  de proximité.** La recherche géographique (`lat`+`lon`+`radiusKm`) utilise
  désormais l'endpoint DINUM dédié `/near_point` au lieu de `/search`
  (qui rejetait `lat/long/radius` en HTTP 400 — `q + lat/lon` était cassé).
  Conséquences : `naf + lat/lon` fonctionne **nativement** (plus de fallback
  reverseGeocode + Haversine + plafond 25/département) ; la sortie ne porte
  plus `fallback` ni `truncated_by_per_page` (pagination native DINUM) ;
  `q + lat/lon` et `codePostal|departement + lat/lon` lèvent une `RangeError`
  explicite (modes exclusifs, endpoints DINUM distincts) au lieu d'un 400
  opaque ou d'un résultat non géolocalisé silencieux. `searchByNafInRadius`
  (workaround désormais sans objet) supprimé.

### Fixed

- **P1+P2 — Paris/Lyon/Marseille : densité/panorama par commune.**
  `densite_professionnels_sante` et `panorama_sante_territoire` avec un code
  PLM (commune-mère 75056/69123/13055 OU arrondissement 75101-75120 etc.)
  renvoyaient soit une densité 0 silencieuse trompeuse (faux « désert
  médical »), soit une `RangeError` au message faux (« commune fusionnée »).
  Garde-fou `assertNotPlmCommune` (avant tout appel DB/Melodi) → `RangeError`
  explicite orientant vers `code_dept`. Détection PLM centralisée dans
  `plmDept` (territoire/commune-index, source unique). Exemples `code_insee`
  trompeurs (`"75108" Paris 8e`…) retirés des descriptions de
  `densite_professionnels_sante`, `panorama_sante_territoire`,
  `population_par_commune`.

### Added

- **P4 — `compare_adresse_cnam_vs_finess`** (tool + `compareAdresseCnamVsFiness`).
  Parallèle à `compare_raison_sociale_finess_vs_rpps` : compare l'adresse CNAM
  (centre de santé) vs FINESS DREES pour un même `num_finess`. Primitive
  brute, statut tri-état (`match` / `divergent_after_normalization` /
  `finess_absent`) + `score_dice` (`null` si non comparable, jamais `0`
  trompeur). Helper `buildAdresseLibelle` factorisé (address-match.ts).

## [0.10.4] — 2026-05-16

**Patch — corrections audit qualité externe claude.ai (B1→B10, 34 tools
testés) : code spécialité ANS faux, transparence géo, collision de
nomenclatures, verbosité, méthodologie, doc. 913 tests verts.**

### Fixed

- **B4 — `RPPS_SAVOIR_FAIRE.DERMATO_VENEREOLOGIE` était `SM26` (faux).**
  `SM26` = « Qualifié en Médecine Générale » (61 273 PS), PAS la dermato.
  Corrigé en `SM15` (« Dermatologie et vénéréologie », 7 594 PS) ; ajout
  `MEDECINE_GENERALE: "SM26"`. La description MCP `savoir_faire_code` de
  `densite_professionnels_sante` propageait l'erreur (un appel densité
  dermato avec `SM26` renvoyait l'effectif médecine générale, 8× faux,
  silencieusement). Valeurs vérifiées sur dump prod le 2026-05-15 via
  `lister_specialites_medicales`. Garde-fou : `rpps-types.test.ts`.

### Added

- **B1 — `GeocodeResult.confidence_low`** (booléen) : `true` quand
  `score < 0.5` (match douteux, souvent fallback rue/commune sans rapport).
  Calculé dans `toGeocodeResult` (couvre `geocode`/`geocodeMany`/
  `reverseGeocode`). Robuste à un `score` absent/`NaN` du payload IGN
  (`score?: number` typé honnête, `confidence_low: true` par prudence +
  `console.warn` préfixé — pas de faux négatif silencieux). Description MCP
  `geocode_adresse` enrichie (interprétation du score).
- **B5 — `geo_precision?: PerResultGeoPrecision`** par PS dans les résultats
  Ameli (`professionnels_in_radius`) et RPPS (`professionnels_rpps_in_radius`,
  etc.), présent quand `coords` non-null. Rappelle, au niveau de chaque PS,
  que `coords`/`distance_km` sont au centroïde commune : tous les PS d'une
  même commune ont la MÊME `distance_km` (ne discrimine pas un praticien).
  Type partagé dans `src/core/query-metadata.ts`. Descriptions MCP des 2
  tools radius explicitées.
- **B3 — `NOMENCLATURE_COLLISION_WARNING`** injecté dans les descriptions de
  `densite_professionnels_sante`, `professionnels_rpps_par_dept`,
  `professionnels_rpps_in_radius` : avertit que les codes Ameli
  (`specialite_code`/`type_ps_code`) et ANS (`profession_code`/
  `savoir_faire_code`) sont des nomenclatures DISTINCTES à valeurs
  numériques homographes (ex : `10` = Médecin ANS vs Neurochirurgien Ameli).

**Patch — corrections audit qualité externe (lot 3-4, B2/B6/B7/B8/B10) :
verbosité, méthodologie, doc.**

### Changed

- **BREAKING (mineur, OSS pré-1.0) — B2 : `lister_specialites_ameli`,
  `lister_types_ps_ameli`, `lister_specialites_medicales` sont paginés.**
  Param `limit` (défaut **50**, max 1000, triés par fréquence). Le contrat de
  sortie passe à `{ count, total, truncated, results }` : `count` = taille de
  l'échantillon renvoyé (était l'effectif total), `total` = effectif réel,
  `truncated` = il en reste. Un caller qui lisait `count` comme "nombre total
  de codes" doit lire `total`. `total` déclaré dans
  `QUERY_RESULT_OUTPUT_SCHEMA` (optionnel). Réduit ~6-10K tokens par appel.
- **B7 — `densite_professionnels_sante.methodologie` paramétrée.** Le champ
  reprenait toujours « médecins en activité régulière » même pour infirmiers
  /pharmaciens (copier-coller). Désormais interpolé selon `profession_code` /
  `savoir_faire_code` ; texte par défaut (médecin, méthodo DREES) inchangé.

### Added

- **B2 — `lister_types_ps_ameli` : param `include_specialites`** (défaut
  `true`). `false` remplace le sous-tableau `specialites_presentes` par
  `nb_specialites` (payload léger, ~6K tokens en moins).
- **`inspect_site` : param `historique_detail`** (défaut `true`). `false` =
  payload allégé (~7K tokens) : `historique` porte un `resume`
  (`sirets`, `periodes_total`, `sirets_en_erreur`) + pointeur vers
  `historique_etablissement` au lieu des timelines SIRENE complètes.
  `sirets_en_erreur` lève l'ambiguïté `periodes_total: 0` vs SIRENE
  injoignable.
- **B6 — note de troncature DREES** dans les descriptions de
  `etablissement_by_finess`, `etablissements_finess_in_radius`,
  `etablissements_finess_by_categorie` : `raison_sociale` est abrégée
  (~38 car.) en amont DREES — cross-check SIREN/SIRET pour le nom complet.

### Fixed

- **B8 — `rpps_search_by_name` : wording désambiguïsation.** La description
  conseillait à tort « utiliser `match_score` pour trier » alors que des
  homonymes exacts ont tous le même score ~1.0. Oriente désormais vers le
  filtre `departement`/`prénom` et explique `truncated`.
- **B10 — `data_freshness` : `inputSchema.additionalProperties: false`.**
  Le `properties: {}` vide ambigu pouvait gêner les clients LLM strict-mode.

## [0.10.3] — 2026-05-15

**Patch — fix ingestion CDS (centres de santé) : pivot FINESS pour la
résolution commune, échec prod 7,20 % `unmatched_locality` sur adresses
CEDEX.**

### Root cause

La 1ʳᵉ ingestion CDS réelle (GitHub Actions run 25927997008) a échoué au
seuil `unmatched_locality` (7,20 % > 5 %). Cause : le CSV CNAM porte des
adresses CEDEX (`DIJON CEDEX`, code postal CEDEX `21078`…) non matchables
contre l'index `(code_postal, ville)` de geo.api.gouv. Le message d'erreur
suggérait à tort un « INSEE commune drift ».

### Fix

- **Pivot FINESS autoritaire** : la commune (`code_insee`/dept/`geom`) est
  désormais résolue via la table `finess` déjà ingérée (`num_finess →
  code_insee`), le géocodage DREES étant fiable et immunisé contre les
  adresses CEDEX. Fallback `(cp, ville)` conservé pour les CDS pas encore
  dans FINESS (latence sync bimestrielle DREES).
- **Fold arrondissement → commune** (`parentCommuneInsee`) : FINESS porte
  l'INSEE arrondissement (Paris 75101-75120, Lyon 69381-69389, Marseille
  13201-13216) que geo.api.gouv `/communes` n'expose pas — sans ce repli le
  pivot ratait 100 % des CDS de ces 3 villes (cohort le plus dense).
- **Index `byInsee`** ajouté à `CommuneIndex` (résolution O(1) par code INSEE).
- **Garde-fous anti-silent-failure** : seuil drop-ratio `code_insee` null
  dans `finess` (`FINESS_NULL_INSEE_THRESHOLD` 2 %, dénominateur = lignes
  fetchées), plancher index relevé 50K → 70K, compteur orphan-INSEE
  (FINESS présent mais code_insee absent de l'index commune) séparé de la
  latence DREES et thresholdé (`ORPHAN_INSEE_THRESHOLD` 1 %) avant l'atomic
  swap. Log de résolution discriminé `via_finess / fallback_drees_lag /
  fallback_orphan_insee`.
- Message d'erreur `unmatched_locality` corrigé (pointe la fraîcheur FINESS
  puis le format source, plus le faux « INSEE drift »).

## [0.10.2] — 2026-05-15

**Patch — fix P0 `professionnels_rpps_in_radius` (timeout 57014 dans les
communes denses) + 2 corrections de cohérence + garde-fou généralisé.**

### Fix P0 — `rpps_in_radius` timeout systématique en commune dense

Symptôme : `professionnels_rpps_in_radius` renvoyait systématiquement
`57014: canceling statement due to statement timeout` dès que le point de
recherche tombait près du centroïde d'une commune dense.

Root cause **prouvée** (EXPLAIN ANALYZE prod, transaction ROLLBACK) : les
coordonnées RPPS sont des centroïdes commune. Les communes denses empilent
des dizaines de milliers de lignes au **point géographique identique**
(Paris/75056 = 76 798 lignes, Marseille = 29 993, Toulouse = 21 695,
Lyon = 17 276). L'index GiST `rpps_geog_gist` ne peut rien élaguer (tous les
points identiques passent le `&&` bbox) → recalcul `ST_DWithin`/`ST_Distance`
géographique **par ligne sur les ~77 k lignes co-localisées** = **15 913 ms**
mesurés → dépasse le `statement_timeout=3s` du rôle `anon`. Ni régression de
code, ni index perdu (`rpps_geog_gist` présent 163 MB), ni stats périmées
(analyze 2026-05-13), ni generic plan (custom plan littéral AUSSI à 15,9 s).
Bug latent de scaling O(lignes/commune) : un point rural résout en 198 ms.

Fix (`20260515T030000_rpps_in_radius_commune_centroids.sql`) : nouvelle
matview `rpps_commune_centroids` (1 centroïde représentatif par commune,
~milliers de lignes, GiST dédié) ; `rpps_in_radius` réécrite pour résoudre
d'abord les communes dans le rayon (KNN instantané sur la petite matview)
puis récupérer ≤ `p_limit` lignes **par commune** en early-stop déterministe
(`CROSS JOIN LATERAL` + `ORDER BY r.id` adossé au nouvel index
`rpps_insee_id_idx (code_insee, id)`) — aucun calcul géo par-ligne sur le
cluster. Sentinelle `P0002` si la matview est vide (doctrine anti-"0
silencieux" héritée de `count_rpps`). Mesuré end-to-end en prod :
**15 913 ms → 63 ms (~250×)**. Signature,
colonnes `RETURNS TABLE`, GRANT, contrat MCP **strictement inchangés**.
Trade-off documenté : filtrage rayon à la granularité commune (cohérent avec
la précision centroïde ~3 km déjà documentée du tool ; vérifié : 0 ligne
`geog NOT NULL` sans `code_insee` → résolution complète, aucune perte).
Matview wirée dans le refresh post-swap (`scripts/ingest/rpps.ts`) +
whitelist `ingest_refresh_matview`.

### Garde-fou staging-parity généralisé à RPPS (bug latent corrigé)

`scripts/ingest/staging-parity.test.ts` étendu à la table `rpps` (était
limité à `annuaire_ameli`) + découverte matview élargie (`_stats`|
`_centroids`) + ancre `rpps_commune_centroids`. Ce garde-fou a **révélé un
bug latent pré-existant** : 3 index prod `rpps` créés après la dernière
`ingest_create_rpps_staging` (20260510T020000) n'y étaient pas répliqués —
`rpps_nom_trgm_idx`, `rpps_prenom_trgm_idx` (→ `rpps_search_by_name` cassé
au swap mensuel), `rpps_profession_savoir_faire_partial_idx`. Corrigé :
`ingest_create_rpps_staging` recréée en superset strict (section 4 de la
migration).

### Cohérence `categorieCodes` densité (panorama vs standalone)

`densiteProfessionnelsSante` retombait sur `?? []` → la RPC appliquait son
propre défaut `['C','M']` quand aucune catégorie n'était passée (chemin
`panorama_sante_territoire`), alors que le tool standalone
`densite_professionnels_sante` passe `['C']` explicite — MÊME commune,
densités différentes selon le chemin. Résolu sur la source unique
`CATEGORIE_CODES_DEFAUT` (`['C']`, Civil seul) dans `buildRppsFilters`,
appliqué à TOUS les callers ; le param échoué `parametres.categorieCodes`
reflète désormais exactement ce qui est compté.

### `centres_sante_*` : `include_freshness` désormais honoré

`cds` ajouté à `INGEST_SOURCES` (+ cadence hebdo). `centres_sante_in_radius`
honorait un `include_freshness` exposé au schéma mais ignoré silencieusement
(no-op) ; `centres_sante_by_finess` n'avait pas le param (asymétrie vs
`etablissement_by_finess`). Les deux wirent maintenant `withFreshness(['cds'])`
(symétrie `not_found` sans freshness). `data_freshness` liste désormais CDS.

Migrations : `20260515T030000_rpps_in_radius_commune_centroids.sql` (4
sections : matview + RPC + whitelist + staging-create superset). Lib (`src/`)
modifiée → package npm bumpé. 873 tests verts.

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
