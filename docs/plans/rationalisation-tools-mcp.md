# Phase A — Rationalisation des tools MCP (3 fusions)

> **Cadrage pré-implémentation.** Cible release **0.21.0** (breaking, documenté).
> Jumeau visuel : `rationalisation-tools-mcp.html`. Date : 2026-05-28.
> **Phase A d'un chantier en 2 temps** : A = rationalisation (ce doc) ; B = IRIS
> infracommunal (`iris-infracommunal.md`). A précède B (l'IRIS atterrit DANS les
> tools consolidés ici).

---

## 1. Contexte (langage simple)

Le MCP expose **35 tools**. Plus il y en a, plus le LLM client a du mal à
choisir le bon : son moteur de recherche d'outils (`tool_search`) classe par
similarité de mots, et des outils trop proches **se masquent mutuellement**.
On l'a prouvé cette session : `lister_specialites_ameli` ne « remontait » pas
côté claude.ai car son jumeau ANS le surclassait — faux diagnostic « outil
absent ». Avant d'ajouter l'IRIS (Phase B), on **range la maison** : moins de
tools, mieux nommés, sans rien perdre.

## 2. Objectif

Passer de **35 à 31 tools** via **3 fusions**, en **rupture nette** (la branche
0.x autorise les breaking changes mineurs documentés — choix validé Cyril : pas
d'alias de compat). Zéro perte de fonctionnalité. Poser le terrain pour l'IRIS
(`population` multi-granularité).

## 3. Les 3 fusions

La **couche lib (`src/`) ne change PAS** : les handlers des nouveaux tools
appellent exactement les mêmes fonctions qu'aujourd'hui. Le changement est
localisé à `api/tools.ts` (définitions), `api/_lib/args.ts` (parsing des
nouveaux paramètres discriminants) et les tests.

### A1 — `lister_nomenclature`

| | |
|---|---|
| **Remplace** | `lister_specialites_ameli`, `lister_types_ps_ameli`, `lister_specialites_medicales` |
| **Param discriminant** | `referentiel` (requis, enum) : `ameli_specialites` \| `ameli_types_ps` \| `rpps_savoir_faire` |
| **Params conservés** | `limit`, `include_freshness` (tous) ; `include_specialites` (si `ameli_types_ps`) ; `profession_code` (si `rpps_savoir_faire`) |
| **Handler** | dispatch → `listAmeliSpecialites` / `listAmeliTypesPs` / `listSavoirFaireRpps` (lib inchangée) |

**Bénéfice clé** : élimine **structurellement** la classe de collision de
ranking — un seul tool de découverte, plus de jumeaux à se masquer. Les
cross-pointeurs anti-confusion (ANS↔Ameli) deviennent une section de la
description unique.

### A2 — `population`

| | |
|---|---|
| **Remplace** | `population_par_commune`, `population_par_departement` |
| **Param** | `code` (requis). **Granularité auto-détectée par forme** : 5 car. = commune INSEE ; 2-3 car. (`01`-`95`, `2A`/`2B`, `971`-`978`) = département. (Phase B : 9 car. = IRIS.) |
| **Alias entrée conservés** | `code_insee`/`insee` et `code_dept`/`dept`/`departement`/`code_departement` → `code` |
| **Retour** | `LookupResult` discriminé, `PMUN`/`PCAP`/`PTOT` (INSEE Melodi) — **inchangé** |
| **Caveats préservés** | Mayotte `976` (dept) → `not_found` (absente de Melodi) ; commune fusionnée → `not_found` + orientation `autocomplete_commune` |
| **Validation** | code ne matchant ni forme commune ni dept → `RangeError` explicite (→ JSON-RPC `-32602`) |

Auto-détection par **longueur** : commune = exactement 5 ; dept = 2 ou 3 ;
toute autre longueur (4, 6-8) → `RangeError`. Pensé pour que l'IRIS (9 car.)
s'ajoute en Phase B sans nouveau tool ni rupture.

### A3 — `densite_sante`

| | |
|---|---|
| **Remplace** | `densite_professionnels_sante`, `densite_etablissements_sante` |
| **Param discriminant** | `cible` (requis, enum) : `professionnels` \| `etablissements` |
| **Params partagés** | scope `code_dept` \| `code_insee` \| `nom_commune` (exactement un), `compare_national`, `include_freshness` |
| **Params conditionnels** | `professionnels` → `profession_code`, `savoir_faire_code`, `mode_exercice_codes` ; `etablissements` → `famille` (requis pour cette cible) |
| **Handler** | dispatch → `densiteProfessionnelsSante` / `densiteEtablissementsSante` (lib inchangée) |
| **Garde-fous préservés** | Paris/PLM `RangeError` (densité commune indisponible), méthodo DREES PMUN, `NOMENCLATURE_COLLISION_WARNING` (cible PS), CGU |
| **Validation croisée** | filtre PS (`profession_code`…) passé avec `cible=etablissements` → `RangeError` ; `famille` manquante avec `cible=etablissements` → `RangeError` (et inverse) |

## 4. Ce qu'on NE fusionne PAS (frontière)

La famille **`*_in_radius`** (6 tools : entreprises, finess, centres_sante,
professionnels, professionnels_rpps, finess_sirene_coverage). Leurs filtres et
sorties sont **hétérogènes** (FINESS catégories vs Ameli spécialités vs SIRENE
NAF vs RPPS professions). Un méga-tool conditionnel deviendrait illisible pour
le LLM = perte de qualité. Le partage se fait déjà **au niveau du code**
(helpers radius communs), pas au niveau du tool. C'est la limite de la
consolidation intelligente.

## 5. Inventaire avant / après

| | Avant | Après |
|---|---|---|
| **Total tools** | 35 | **31** |
| Découverte nomenclature | 3 | 1 (`lister_nomenclature`) |
| Population | 2 | 1 (`population`) |
| Densité | 2 | 1 (`densite_sante`) |
| Reste | 28 | 28 (inchangés) |

## 6. Breaking change & migration (⚠️ pour les consommateurs — ex. GEO Intel)

Rupture nette : les **5 anciens noms sont supprimés**. Table de migration à
publier dans le CHANGELOG (section « BREAKING ») :

| Ancien appel | Nouveau appel |
|---|---|
| `lister_specialites_ameli({limit})` | `lister_nomenclature({referentiel:"ameli_specialites", limit})` |
| `lister_types_ps_ameli({include_specialites})` | `lister_nomenclature({referentiel:"ameli_types_ps", include_specialites})` |
| `lister_specialites_medicales({profession_code})` | `lister_nomenclature({referentiel:"rpps_savoir_faire", profession_code})` |
| `population_par_commune({code:"75056"})` | `population({code:"75056"})` |
| `population_par_departement({code:"75"})` | `population({code:"75"})` |
| `densite_professionnels_sante({code_dept, savoir_faire_code})` | `densite_sante({cible:"professionnels", code_dept, savoir_faire_code})` |
| `densite_etablissements_sante({code_dept, famille})` | `densite_sante({cible:"etablissements", code_dept, famille})` |

Bump **0.21.0** sur les 3 sources (`package.json`, `server.json`,
`src/core/version.ts`).

## 7. Architecture / impact fichiers

- `api/tools.ts` — supprimer 5 défs, créer 3 défs (descriptions riches portant
  les spécificités par référentiel/cible).
- `api/_lib/args.ts` — parsing/validation des params discriminants (`referentiel`,
  `cible`) + auto-détection de granularité de `code` pour `population`.
- `api/tools.test.ts` — renommer/refactor les blocs de test ; assertions de
  comportement **préservées** par référentiel/cible ; garde-fou rupture
  (`findTool("population_par_commune")` → `undefined`).
- **Aucune** migration DB, **aucun** changement lib `src/`.

## 8. Méthodologie de preuve

- **TDD** : tests adaptés AVANT refactor (rouge → vert). Couverture par
  référentiel (3) et par cible (2), plus la validation croisée (filtre PS +
  `cible=etablissements` → throw) et l'auto-détection `population`
  (commune/dept/longueur invalide).
- typecheck (2 tsconfigs) + lint + `test:unit` verts.
- Pipeline `/review` (simplify + code-reviewer + silent-failure-hunter).
- **Acceptance prod post-deploy** : appel réel des 3 nouveaux tools + vérif que
  les 5 anciens noms renvoient bien « method/tool not found ».

## 9. Risques

| Risque | Mitigation |
|---|---|
| Tool paramétré moins auto-documenté qu'un tool dédié | Description riche (specificités par référentiel/cible inline) |
| Rupture des clients existants (claude.ai, Cursor, GEO Intel) | Assumé (choix Cyril) + table de migration CHANGELOG + bump mineur 0.x |
| Régression de comportement à la fusion | Lib inchangée + assertions de comportement préservées en TDD |

## 10. Hors scope (→ Phase B, `iris-infracommunal.md`)

Granularité `iris` de `population` (code 9 car.), bloc démo IRIS dans
`panorama_sante_territoire`, nouveau tool `profil_iris(point, rayon_km?)`.
Net après B : 31 + 1 = **32 tools** (on ajoute tout l'IRIS et on reste sous 35).
