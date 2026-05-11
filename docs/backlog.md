# Backlog

Items priorisés, mis à jour au fil des audits / reviews. Items terminés migrés au [CHANGELOG](../CHANGELOG.md).

## P0 — Bloquant prochain release

_Vide._

## P1 — Limites fonctionnelles connues

### V0.7.1 — Fallback INSEE `/siret?q=siren:XXX` quand DINUM partial

**Symptôme** : sur les SIREN multi-sites (≥ ~20 établissements, ex: Biogroup Nord = 38 sites), DINUM `getEntrepriseBySiren` retourne `enrichmentStatus: "partial"` et liste **uniquement le siège** dans `etablissements[]`. Conséquences sur `verifier_site_actif` / `historique_etablissement` / `reconcilier_finess_sirene` :

- Sur FINESS 590048997 (Biogroup Bd Bizet, fermé 2024-02-16 côté SIRENE), le SIRET physique fermé `50781594200218` est invisible — le resolver ne ramène que le siège actif `50781594200333`.
- `verdict_site` reste `indetermine` au lieu de `ferme`.
- Audit Villeneuve-d'Ascq (11/05/2026) : S5/Z1/Z2 = ⚠ partiel pour cette cause.

**Fix proposé** : dans `src/sante/siret-resolver.ts`, après le lookup DINUM, si `lookup.enrichmentStatus !== "success"`, fallback automatique vers `lookupSiretsByInsee(siren)` (nouveau helper INSEE `/siret?q=siren:XXX` paginé). Coût : 1 appel INSEE supplémentaire par SIREN partial (rate limit 30/min, déjà géré). Effort ~1-2h + tests + /review.

**Test régression à pin** : `verifier_site_actif("590048997")` doit retourner `verdict_site: "ferme"` et `best_match.siret === "50781594200218"`.

## P2 — UX / DX

### preset métier dans `lister_specialites_ameli` (Z3 audit Claude.ai)

Refusé en V0.7.0 (Cyril 11/05 : « ça doit marcher pour tout le monde »). Si une demande client récurrente émerge pour grouper bio / pharma / dentaire / etc., reconsidérer un endpoint `presets_metier` neutre — pas spécifique bio.

### Métrique couverture FINESS vs SIRENE (Test 4 audit)

L'audit compare des **sites** FINESS (1 ligne par SIRET physique agréé LBM) à des **UL** SIRENE (1 ligne par SIREN). Métriques biaisées par construction. Si Cyril veut un tool « FINESS-coverage » fiable, exposer un endpoint qui compte les SIRET DINUM physiques (pas les UL) dans le rayon.

### Optimisation INSEE call dans `reconcilierFinessSirene`

Audit `/simplify` efficiency : la fonction appelle INSEE pour chaque candidate alors que DINUM (via le resolver) a déjà `Entreprise.nomComplet` (= raison sociale UL). Économie possible : N calls INSEE par réconciliation. Coût rate limit INSEE divisé par ~5.

Fix : passer `nomComplet` dans `SiretCandidate` depuis le resolver, sauter l'INSEE call quand DINUM a fourni l'info.

## P3 — Données / Référentiels externes

### INSEE Melodi (séries macro)

Backlogué V0.5.4. `api.insee.fr/melodi` libre (sans clé) — séries macro INSEE (démographie, économie, emploi). Use case : enrichir `consulter_budget_commune` / analyses territoriales.

### FHIR ANS PractitionerRole

`lookupPractitionerByRpps` renvoie un `Practitioner` sans `PractitionerRole` (rattachements site). Pour les PS absents de la DB locale (snapshot mensuel J-30) avec fallback FHIR ANS, on retourne juste l'identité + nom — pas les sites d'exercice. Faire un 2e appel FHIR `PractitionerRole?practitioner=...` pour enrichir. Coût : 1 appel ANS supplémentaire si fallback déclenché (rare, <1 % des lookups).

### `parsedCoordRejected` flag

Mentionné dans `docs/ingestion.md:160`. Drapeau d'observabilité ingest CSV non encore exposé dans `data_freshness`. Décision à prendre : utile ou pas pour le caller MCP public ?

## P4 — Promotion / Discoverabilité

### Smithery listing

Backlogué V0.5.7 avant promo LinkedIn / blog. Le MCP est rate-limité + observabilité OK, prêt à listing public. Demander à Smithery un add manuel ou via auto-discovery (vérifier critères).

### Promo LinkedIn / blog technique

Article positionnement : « Premier MCP qui croise 6 référentiels publics FR — détecte les SIRET fermés invisibles côté DREES ». Use cases prospection santé, audit territorial, civic-tech.

## P5 — Refactoring / Dette

### Élargir tests integration sans Supabase local

19 tests integration (`*.integration.test.ts`) skippent en CI sans Supabase configuré. Mettre en place un Supabase de CI dédié (free tier) ou mock RPC fixtures pour passer en vert sans setup local.

### `mergeOrInsertDinumCandidate` — invariant SIRENE

Pass 1 reviewer (confidence 82) : le helper unconditionally overwrite `score_adresse` si DINUM ramène le même SIRET deux fois. Bug théorique uniquement (l'invariant SIRENE garantit SIRET ↔ SIREN unique). Ajouter une assertion défensive `if (existing.score_adresse !== null) console.warn(...)` pour détecter une régression SIRENE silencieuse.
