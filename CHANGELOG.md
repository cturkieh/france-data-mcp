# Changelog

Toutes les modifications notables apparaissent ici. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; le projet suit
SemVer (la branche `0.x` autorise les breaking changes mineurs documentés).

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
