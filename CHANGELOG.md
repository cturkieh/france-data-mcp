# Changelog

Toutes les modifications notables apparaissent ici. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; le projet suit
SemVer (la branche `0.x` autorise les breaking changes mineurs documentés).

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
