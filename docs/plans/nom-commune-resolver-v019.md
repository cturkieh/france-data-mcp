# V0.19.0 — `nom_commune` resolver (Geo Intel friendly)

> **Statut** : design validé (brainstorming Cyril × Claude, 2026-05-23). Spec source de vérité pour writing-plans + exécution. Lecture archive technique ; pour validation visuelle, voir `nom-commune-resolver-v019.html`.

## TL;DR

Sur 3 tools MCP (`etablissements_finess_by_categorie`, `panorama_sante_territoire`, `densite_professionnels_sante`), on ajoute un paramètre `nom_commune` (string) accepté comme alternative à `code_insee`. Le serveur résout le nom → code INSEE via `geo.api.gouv.fr` (déjà utilisé par `searchCommunes` / `autocomplete_commune`) et passe au calcul existant. Économie Geo Intel : **2 round-trips MCP → 1 (~5s/appel)**. Rétro-compatibilité totale `code_insee` + `departement`. Bump V0.19.0.

---

## 1. Contexte & motivation

### Le problème actuel (Geo Intel)

Le consommateur principal du MCP (Geo Intel) doit faire **2 appels successifs** pour répondre à une question type « combien de labos à Lille » :

1. `autocomplete_commune({ nom: "Lille" })` → reçoit `{ code: "59350", … }`
2. `etablissements_finess_by_categorie({ categorie: "labo", code_insee: "59350" })` → reçoit la liste

Coût réseau mesuré : **~5 secondes** par requête à cause du round-trip MCP supplémentaire (sérialisation + transport + désérialisation × 2). Sur un usage conversationnel (10 questions / minute), c'est lourd.

### La solution (V0.19.0)

Le tool accepte directement le nom de ville :

```json
{ "categorie": "labo", "nom_commune": "Lille" }
```

Le serveur résout en interne (même source `geo.api.gouv.fr`) et renvoie le résultat. **1 seul appel**. Sémantique transparente pour le LLM caller : la réponse renvoie le code INSEE résolu dans le contexte de la réponse (le caller voit toujours le `code_insee` effectif).

### Compatibilité avec le scope V0.18.0 et antérieur

- Aucune modification de schéma DB
- Aucune nouvelle dépendance npm
- Lib `src/sante/` non touchée
- Une seule modif lib mineure (extension de `searchCommunes` pour accepter `codeDepartement`, rétro-compatible)

---

## 2. Décisions de design (avec rationale)

### Décision 1 — Scope = 3 tools (pas 4)

Audit terrain (2026-05-23) :

| Tool | Accepte `code_insee` aujourd'hui ? | Ajoute `nom_commune` ? |
|---|---|---|
| `etablissements_finess_by_categorie` | ✅ Oui (en plus de `departement`) | ✅ V0.19.0 |
| `panorama_sante_territoire` | ✅ Oui (seul param zone) | ✅ V0.19.0 |
| `densite_professionnels_sante` | ✅ Oui (XOR avec `code_dept`) | ✅ V0.19.0 |
| `densite_etablissements_sante` | ❌ Non — `required: ["code_dept", "famille"]` | 🔜 V0.20+ |

**Pourquoi pas le 4ème** : `densite_etablissements_sante` ne sait calculer qu'au niveau département. Ajouter `nom_commune` exigerait d'abord un nouveau RPC SQL `count_finess_by_commune` + métadata population commune + gestion PLM. C'est un chantier distinct (~2× l'effort) qui mérite son propre ticket (entry backlog V0.20).

### Décision 2 — Helper boundary partagé, pas un par tool

`resolveNomCommune()` placé dans `api/_lib/resolve-commune.ts` (nouveau fichier, sibling de `args.ts`). Trois raisons :

1. **DRY** : 3 tools × ~30 lignes de validation/normalisation = duplication garantie de drift.
2. **Cohérence DX LLM** : mêmes erreurs, mêmes formes, mêmes wordings sur les 3 tools. Le LLM apprend une fois, applique partout.
3. **Testabilité** : le helper est testable unitairement avec mock de `searchCommunes`. Les boundary tests des tools restent focalisés sur leur câblage, pas sur la résolution.

### Décision 3 — `departement` comme désambiguïsateur (combinable avec `nom_commune`)

Cas LLM typique : « combien de labos à Saint-Martin dans les Ardennes (08) ». Le LLM a déjà le contexte département (souvent fourni par l'utilisateur ou inféré). XOR strict obligerait 2 appels même quand l'intent est sans ambiguïté.

**Sémantique adoptée** :

| Cas | Comportement |
|---|---|
| `nom_commune` seul, 1 match unique | Résout silencieusement, calcul sur la commune trouvée |
| `nom_commune` seul, N matches | Erreur `ambiguous_commune` (liste candidats) |
| `nom_commune` + `departement` cohérents (1 match) | Résout silencieusement, `departement` ignoré pour le calcul (juste filtre resolver) |
| `nom_commune` + `departement` incohérents (0 match dans le dept) | Erreur `commune_not_in_department` |
| `nom_commune` + `departement`, toujours ambigu dans le dept | Erreur `ambiguous_commune` (candidats filtrés sur dept) |
| `nom_commune` + `code_insee` simultanés | Erreur `redundant_commune_params` (XOR strict) |
| `code_insee` seul (rétrocompat) | Pass-through, comportement inchangé |
| `departement`/`code_dept` seul (rétrocompat) | Pass-through (scope = dept entier), comportement inchangé |

**Important sur `densite_professionnels_sante`** : `code_dept` a aujourd'hui une sémantique unique de **scope de calcul** (densité dept entier). Avec V0.19.0, sa sémantique devient **conditionnelle** :
- `code_dept` seul → scope calcul (densité dept entier, comme avant)
- `code_dept` + `nom_commune` → hint resolver (densité de la commune résolue dans ce dept)

Cette sémantique conditionnelle est **documentée explicitement** dans la description du tool (LLM-facing doc).

### Décision 4 — Match exact case-insensitive + accents normalisés (pas de fuzzy)

Test live `geo.api.gouv.fr` (2026-05-23) :

| Input | Résultat API |
|---|---|
| `lille` (minuscules) | ✅ Lille #1 score 1.81 |
| `Saint-Etienne` (sans accent) | ✅ Saint-Étienne #1 score 0.84 |
| `St-Martin` (abréviation tiret) | ❌ 0 résultat (l'API ne fait pas `St → Saint`) |
| `St Martin` (espace) | ❌ 0 résultat |

L'API gère **nativement** la casse et les accents. Pour le matching côté boundary, on **filtre les résultats en match exact case-insensitive sur la version normalisée** (NFD + suppression diacritiques) du `nom` retourné par l'API. Ça élimine le bruit fuzzy (`Mont-Saint-Martin` quand on cherche `Saint-Martin`) tout en gardant la tolérance API native.

**Pas de gestion `St → Saint`** en V0.19.0 (YAGNI) :
- Si le LLM tape `St-Martin`, il reçoit `unknown_commune` avec un hint pédagogique : « Utiliser le nom officiel complet, ex. "Saint-Martin" ».
- Le LLM apprend vite (un round-trip d'erreur).
- Si en prod c'est un vrai pain point (mesurer Sentry sur `unknown_commune` répétés), V0.19.1 ajoutera la normalisation `St/Ste`.

### Décision 5 — Erreurs structurées via `RangeError(msg, { cause })` → JSON-RPC `error.data`

Forme alignée sur la machinerie existante :

- Lib/boundary throw `RangeError(message, { cause: { kind, ... } })` (signature ES2022 standard, pas de hack `as unknown as ErrorOptions`)
- Catch root `api/mcp.ts:384-393` capture le `RangeError`, extrait `err.cause`, le passe au 4ème arg de `error(id, code, message, data)` (la fonction `error()` accepte déjà ce param, ligne 499-506 — il faut juste le brancher)
- Le caller MCP voit `error.data` avec le payload structuré (`kind`, `candidates`, `total_matches`, `truncated`)

**Patch minimal** sur `api/mcp.ts` (3 lignes) :

```typescript
// Avant
if (err instanceof RangeError) {
  const message = err.message;
  // ...
  return error(id, -32602, message);
}

// Après
if (err instanceof RangeError) {
  const message = err.message;
  const data = err.cause; // ← NEW : propage le payload structuré
  // ...
  return error(id, -32602, message, data); // ← passe au 4ème arg
}
```

Garde-fou test : nouveau test `api/mcp-handler-error-cause.test.ts` qui assert qu'un `RangeError` avec `cause` propage bien le payload dans `error.data`.

### Décision 6 — Cap candidats : top 10 par population décroissante + flag `truncated`

`searchCommunes()` accepte déjà `limit` (clamp 1-30) et `boostPopulation: true`. On utilise `limit: 30` (max API) puis on coupe à top 10 après filtre exact + dept éventuel, avec `total_matches: number, truncated: boolean`.

Aligné avec le pattern existant `buildFinessQueryResult` (`+1 to detect truncation`).

### Décision 7 — XOR strict introduit dans `by_categorie` au passage

Aujourd'hui (`api/tools.ts:1461-1500`), `etablissements_finess_by_categorie` accepte `departement` ET `code_insee` simultanés sans erreur — les 2 sont passés au RPC `finess_by_categorie` comme filtres AND. C'est une sémantique latente et trompeuse.

V0.19.0 introduit le XOR strict (cohérent avec `densite_professionnels_sante` V0.9) :
- `departement` seul → scope dept
- `code_insee` seul → scope commune
- `nom_commune [+ departement]` → scope commune (résolu)
- 2+ simultanés (hors `nom_commune + departement` qui est légitime) → erreur explicite

**Cassure mineure documentée** : un caller (s'il y en a) qui passait `departement + code_insee` simultanément reçoit désormais une erreur claire au lieu d'un AND silencieux. Cohérent avec le contrat des autres tools.

---

## 3. Architecture du helper

### Signature et type discriminé

Fichier : `api/_lib/resolve-commune.ts` (nouveau, sibling de `args.ts`).

```typescript
import type { Commune } from "../../src/territoire/communes.js";

/**
 * Résultat discriminé de la résolution `nom_commune → code_insee`.
 * Pattern aligné sur `LookupResult<T>` (src/core/lookup-result.ts).
 */
export type ResolveCommuneResult =
  | { resolved: true; commune: Commune }
  | { resolved: false; error: ResolveCommuneError };

export type ResolveCommuneError =
  | {
      kind: "unknown_commune";
      input: { nom_commune: string; departement?: string };
      hint: string;
    }
  | {
      kind: "ambiguous_commune";
      input: { nom_commune: string; departement?: string };
      candidates: ResolveCandidate[];
      total_matches: number;
      truncated: boolean;
    }
  | {
      kind: "commune_not_in_department";
      input: { nom_commune: string; departement: string };
      matches_in_other_dept: ResolveCandidate[]; // top 10
    };

export type ResolveCandidate = {
  code: string;
  nom: string;
  codeDepartement: string;
  population: number | null;
};

/**
 * Résout un nom de commune en code INSEE via geo.api.gouv.fr.
 * Filtre les résultats en match exact case-insensitive + accents normalisés.
 * Si `departement` fourni, filtre côté API (param `codeDepartement` natif).
 *
 * Ne throw jamais — retourne toujours un résultat discriminé.
 */
export async function resolveNomCommune(input: {
  nom: string;
  departement?: string;
  signal?: AbortSignal;
}): Promise<ResolveCommuneResult>;
```

### Algorithme

```text
1. Trim + early-fail si nom vide → RangeError direct au caller (avant helper)
2. Normaliser le nom recherché : toLowerCase + NFD + suppression diacritiques
3. Appeler searchCommunes({ nom, codeDepartement?, limit: 30, boostPopulation: true })
4. Filtrer les résultats en match exact normalisé (commune.nom === input normalisé)
5. Selon le compte filtré :
   a. 1 match → { resolved: true, commune: match }
   b. 0 match + dept fourni :
      - Refaire searchCommunes SANS dept (limit: 30)
      - Filtrer en match exact
      - Si N>0 matches dans d'autres dept → commune_not_in_department avec ces matches
      - Si 0 → unknown_commune
   c. 0 match sans dept → unknown_commune avec hint pédagogique
   d. N>1 matches → ambiguous_commune avec top 10 (déjà trié par boost=population)
```

**Note implémentation** : la double requête en cas b (avec dept puis sans dept) est nécessaire pour distinguer « nom inexistant nulle part » de « nom existe mais pas dans ce dept ». Coût ≤ 2 round-trips API (cas rare). Acceptable vs valeur pédagogique de l'erreur structurée.

### Petite extension de `searchCommunes` (lib)

Modif `src/territoire/communes.ts` :

```typescript
export type SearchCommunesOptions = {
  nom?: string;
  codePostal?: string;
  code?: string;
  codeDepartement?: string; // ← NEW : filtre côté API (param natif geo.api.gouv.fr)
  limit?: number;
  boostPopulation?: boolean;
  signal?: AbortSignal;
};
```

Implémentation : ajout simple dans la construction des `URLSearchParams` :

```typescript
if (codeDepartement) params.set("codeDepartement", codeDepartement);
```

Rétro-compatible (param optionnel). Test ajouté dans `communes.test.ts` (un cas avec `codeDepartement` + assertion sur l'URL appelée).

---

## 4. Câblage par tool

### `etablissements_finess_by_categorie` (`api/tools.ts:1429-1500`)

Avant (extrait) :

```typescript
const departement = asString(args.departement);
const codeInsee = asString(args.code_insee);
const input: Parameters<typeof getFinessByCategorie>[0] = { famille };
if (departement) input.departement = departement;
if (codeInsee) input.code_insee = codeInsee;
```

Après :

```typescript
const departement = asString(args.departement);
const codeInsee = asString(args.code_insee);
const nomCommune = asString(args.nom_commune);

// XOR strict + résolution nom_commune
const resolved = await applyCommuneResolver({
  nomCommune,
  codeInsee,
  departement,
  acceptsDepartementAsScope: true, // by_categorie accepte dept seul comme scope FR-partiel
  requireScope: false,             // by_categorie accepte aussi rien (= France entière)
});
// resolved retourne { codeInsee?, departement? } prêt à câbler

const input: Parameters<typeof getFinessByCategorie>[0] = { famille };
if (resolved.departement) input.departement = resolved.departement;
if (resolved.codeInsee) input.code_insee = resolved.codeInsee;
```

`applyCommuneResolver` est un helper du boundary qui (sémantique du flag `departement`) :
1. Si `nomCommune` fourni → `departement` est traité comme **hint resolver** (filtre côté `geo.api.gouv.fr`), pas comme scope de calcul. Le tool reçoit uniquement `{ codeInsee }`.
2. Si `nomCommune` absent et `departement` fourni → si `acceptsDepartementAsScope: true`, pass-through (scope dept). Sinon erreur explicite.
3. Si `nomCommune` + `codeInsee` simultanés → throw `RangeError({cause:{kind:"redundant_commune_params"}})`.
4. Si rien fourni et `requireScope: true` → throw erreur explicite "scope requis". Si `requireScope: false`, retourne `{}` (FR entière OK pour ce tool).

### `panorama_sante_territoire` (`api/tools.ts:2204-2284`)

Avant : `code_insee` est `required: true`. Après : on le rend optionnel et on autorise `nom_commune` comme alternative. `required` du schema devient `[]` (validation côté handler via `applyCommuneResolver({ requireScope: true })` qui throw si aucun de `code_insee`/`nom_commune` fourni).

`panorama` n'a pas de scope de calcul département (commune uniquement) → câblage : `acceptsDepartementAsScope: false`. Donc `departement` n'est utilisable QUE comme hint resolver combiné à `nom_commune` (filtre les candidats homonymes), jamais comme scope autonome (un `departement` seul lèvera une erreur explicite "scope dept non supporté sur panorama, utiliser code_insee ou nom_commune").

```typescript
const resolved = await applyCommuneResolver({
  nomCommune,
  codeInsee,
  departement,
  acceptsDepartementAsScope: false, // panorama = commune uniquement
  requireScope: true,               // panorama exige une commune
});
// resolved garanti d'avoir codeInsee (validé par requireScope)
const input: Parameters<typeof panoramaSanteTerritoire>[0] = { codeInsee: resolved.codeInsee! };
```

### `densite_professionnels_sante` (`api/tools.ts:2050-2128`)

Le plus subtil : tool actuel a un XOR strict `code_dept` vs `code_insee` géré par `resolveZone` (lib `densite.ts:230`). On étend :

- `nom_commune` seul → résolu en `code_insee` → passe à `resolveZone` qui voit `codeInsee` seul → OK
- `nom_commune` + `code_dept` → `code_dept` agit en **hint resolver** (filtre les candidats), résolu en `code_insee` → passe à `resolveZone` qui voit `codeInsee` seul (le `code_dept` n'est PAS réinjecté en scope) → OK
- `code_dept` seul → pass-through (scope dept entier, comme avant)
- `code_insee` seul → pass-through (scope commune, comme avant)
- `code_dept` + `code_insee` → erreur XOR (comme avant, géré par `resolveZone`)
- `nom_commune` + `code_insee` → erreur `redundant_commune_params` (nouveau, géré par `applyCommuneResolver`)

Câblage :

```typescript
const resolved = await applyCommuneResolver({
  nomCommune,
  codeInsee,
  departement: codeDept,
  acceptsDepartementAsScope: true, // dept seul = scope dept entier (densité dept)
  requireScope: false,             // resolveZone (lib) throw si rien, on le laisse parler
});
// IMPORTANT : si nom_commune fourni, resolved retourne SEULEMENT { codeInsee }
// (le codeDept est consommé comme hint resolver et N'EST PAS réinjecté en scope).
// resolveZone (lib) prend le relais pour le XOR final code_dept vs code_insee.
const input: Parameters<typeof densiteProfessionnelsSante>[0] = { categorieCodes: ... };
if (resolved.codeInsee) input.codeInsee = resolved.codeInsee;
if (resolved.departement) input.departement = resolved.departement;
```

Description du tool mise à jour pour expliquer la sémantique conditionnelle de `code_dept` (scope dept entier si seul, hint resolver si combiné avec `nom_commune`).

### `searchCommunes` extension (lib)

Modification mineure dans `src/territoire/communes.ts` (cf. §3). Aucun impact sur les callers existants.

---

## 5. Forme des erreurs JSON-RPC

### `ambiguous_commune`

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "error": {
    "code": -32602,
    "message": "Commune ambiguë : 5 communes correspondent à 'Saint-Martin'. Préciser le département via `departement`, ou choisir un code INSEE dans candidates.",
    "data": {
      "kind": "ambiguous_commune",
      "input": { "nom_commune": "Saint-Martin" },
      "candidates": [
        { "code": "97801", "nom": "Saint-Martin", "codeDepartement": "978", "population": 31160 },
        { "code": "65392", "nom": "Saint-Martin", "codeDepartement": "65", "population": 436 },
        { "code": "32389", "nom": "Saint-Martin", "codeDepartement": "32", "population": 434 },
        { "code": "67426", "nom": "Saint-Martin", "codeDepartement": "67", "population": 374 },
        { "code": "54480", "nom": "Saint-Martin", "codeDepartement": "54", "population": 53 }
      ],
      "total_matches": 5,
      "truncated": false
    }
  }
}
```

### `commune_not_in_department`

```json
{
  "error": {
    "code": -32602,
    "message": "Commune 'Lyon' introuvable dans le département '13'. Trouvée dans d'autres départements (voir matches_in_other_dept).",
    "data": {
      "kind": "commune_not_in_department",
      "input": { "nom_commune": "Lyon", "departement": "13" },
      "matches_in_other_dept": [
        { "code": "69123", "nom": "Lyon", "codeDepartement": "69", "population": 522969 }
      ]
    }
  }
}
```

### `unknown_commune`

```json
{
  "error": {
    "code": -32602,
    "message": "Commune 'St-Martin' inconnue. Astuce : utiliser le nom officiel complet (ex. 'Saint-Martin'). Les abréviations 'St'/'Ste' ne sont pas reconnues.",
    "data": {
      "kind": "unknown_commune",
      "input": { "nom_commune": "St-Martin" },
      "hint": "Utiliser le nom officiel complet (ex. 'Saint-Martin'). Les abréviations 'St'/'Ste' ne sont pas reconnues."
    }
  }
}
```

### `redundant_commune_params`

```json
{
  "error": {
    "code": -32602,
    "message": "Paramètres redondants : passer SOIT `code_insee` SOIT `nom_commune`, pas les deux.",
    "data": {
      "kind": "redundant_commune_params",
      "input": { "nom_commune": "Lyon", "code_insee": "69123" }
    }
  }
}
```

---

## 6. Tests garde-fous

### Helper unitaire (`api/_lib/resolve-commune.test.ts`)

Couvre la matrice 9 cas avec `vi.spyOn(communes, "searchCommunes")` :

| # | Cas | Assertion |
|---|---|---|
| 1 | `nom="Lille"` (unique) | `resolved: true, commune.code === "59350"` |
| 2 | `nom="Saint-Martin"` (5 matches) | `kind: "ambiguous_commune", candidates.length === 5, total_matches: 5` |
| 3 | `nom="Saint-Martin", dept="08"` (0 dans 08, mais 5 ailleurs) | `kind: "commune_not_in_department", matches_in_other_dept.length === 5` |
| 4 | `nom="Saint-Martin", dept="65"` (1 dans 65) | `resolved: true, commune.code === "65392"` |
| 5 | `nom="XXXINEXISTANT"` | `kind: "unknown_commune"` |
| 6 | `nom="St-Martin"` (abréviation) | `kind: "unknown_commune", hint contient "officiel"` |
| 7 | `nom="lille"` (minuscules) | `resolved: true` (case-insensitive) |
| 8 | `nom="Saint-Etienne"` (sans accent) | `resolved: true, commune.nom === "Saint-Étienne"` |
| 9 | Cap : nom matche > 10 candidats (mock 12) | `total_matches: 12, truncated: true, candidates.length === 10` |

### Boundary par tool (`api/tools.test.ts` étendu)

- `nom_commune` seul → résolu via spy `searchCommunes`, passé en `code_insee`
- `nom_commune` + `dept` cohérent → résolu, dept passé en filtre resolver
- `nom_commune` + `code_insee` → `RangeError` `redundant_commune_params` (sans appeler `searchCommunes`)
- `nom_commune` ambigu → `RangeError` `ambiguous_commune` propagée
- Rétro-compat : tous les tests existants `code_insee` seul / `departement` seul / 0 zone passent inchangés

### XOR strict `by_categorie` (`api/tools-v019.test.ts` nouveau)

- `departement + code_insee` simultanés (sans `nom_commune`) → `RangeError` XOR (nouveau comportement, à régression-tester)
- Le test existant qui passait `departement + code_insee` accidentellement (s'il y en a) doit être adapté

### Garde-fou propagation `error.cause` (`api/mcp-handler-error-cause.test.ts` nouveau)

- Mock un tool qui throw `RangeError("msg", { cause: { kind: "test_kind", x: 1 } })`
- Appelle le handler JSON-RPC
- Assert : `response.error.data === { kind: "test_kind", x: 1 }`
- Sans ce test, une régression future (oubli du 4ème arg) brise silencieusement le contrat Geo Intel

### Extension `searchCommunes` (`src/territoire/communes.test.ts` étendu)

- Appel avec `codeDepartement: "08"` → assertion sur l'URL générée (`?nom=...&codeDepartement=08&...`)

---

## 7. Implémentation technique — snippets clés

### `api/_lib/resolve-commune.ts` (squelette)

```typescript
import { searchCommunes, type Commune } from "../../src/territoire/communes.js";

export type ResolveCandidate = {
  code: string;
  nom: string;
  codeDepartement: string;
  population: number | null;
};

export type ResolveCommuneError =
  | { kind: "unknown_commune"; input: { nom_commune: string; departement?: string }; hint: string }
  | { kind: "ambiguous_commune"; input: { nom_commune: string; departement?: string }; candidates: ResolveCandidate[]; total_matches: number; truncated: boolean }
  | { kind: "commune_not_in_department"; input: { nom_commune: string; departement: string }; matches_in_other_dept: ResolveCandidate[] };

export type ResolveCommuneResult =
  | { resolved: true; commune: Commune }
  | { resolved: false; error: ResolveCommuneError };

const CAP_CANDIDATES = 10;
const SEARCH_LIMIT = 30;

/** Normalize for case-insensitive + accent-insensitive comparison. */
function normalizeName(s: string): string {
  return s.trim().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function toCandidate(c: Commune): ResolveCandidate {
  return {
    code: c.code,
    nom: c.nom,
    codeDepartement: c.codeDepartement ?? "",
    population: c.population ?? null,
  };
}

export async function resolveNomCommune(input: {
  nom: string;
  departement?: string;
  signal?: AbortSignal;
}): Promise<ResolveCommuneResult> {
  const wantedKey = normalizeName(input.nom);
  if (!wantedKey) {
    // Caller boundary should have caught this — defensive.
    return {
      resolved: false,
      error: {
        kind: "unknown_commune",
        input: { nom_commune: input.nom, ...(input.departement ? { departement: input.departement } : {}) },
        hint: "Le paramètre `nom_commune` doit être un nom de commune non vide.",
      },
    };
  }

  const all = await searchCommunes({
    nom: input.nom,
    limit: SEARCH_LIMIT,
    boostPopulation: true,
    ...(input.departement ? { codeDepartement: input.departement } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const exact = all.filter((c) => normalizeName(c.nom) === wantedKey);

  if (exact.length === 1) {
    return { resolved: true, commune: exact[0] };
  }

  if (exact.length > 1) {
    const capped = exact.slice(0, CAP_CANDIDATES);
    return {
      resolved: false,
      error: {
        kind: "ambiguous_commune",
        input: { nom_commune: input.nom, ...(input.departement ? { departement: input.departement } : {}) },
        candidates: capped.map(toCandidate),
        total_matches: exact.length,
        truncated: exact.length > CAP_CANDIDATES,
      },
    };
  }

  // exact.length === 0 → distinguish "not_in_dept" vs "unknown" if dept was filter
  if (input.departement) {
    const fallback = await searchCommunes({
      nom: input.nom,
      limit: SEARCH_LIMIT,
      boostPopulation: true,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const exactGlobal = fallback.filter((c) => normalizeName(c.nom) === wantedKey);
    if (exactGlobal.length > 0) {
      return {
        resolved: false,
        error: {
          kind: "commune_not_in_department",
          input: { nom_commune: input.nom, departement: input.departement },
          matches_in_other_dept: exactGlobal.slice(0, CAP_CANDIDATES).map(toCandidate),
        },
      };
    }
  }

  return {
    resolved: false,
    error: {
      kind: "unknown_commune",
      input: { nom_commune: input.nom, ...(input.departement ? { departement: input.departement } : {}) },
      hint:
        "Utiliser le nom officiel complet (ex. 'Saint-Martin' et non 'St-Martin'). Les abréviations 'St'/'Ste' ne sont pas reconnues. Si le nom contient un tiret, le conserver.",
    },
  };
}
```

### `api/_lib/apply-commune-resolver.ts` (helper boundary)

```typescript
import { resolveNomCommune, type ResolveCommuneError } from "./resolve-commune.js";

export type CommuneResolverArgs = {
  nomCommune: string | undefined;
  codeInsee: string | undefined;
  departement: string | undefined;
  /** True si le tool sait calculer au niveau département (by_categorie, densite_professionnels).
   *  False pour panorama qui ne calcule qu'au niveau commune. */
  acceptsDepartementAsScope: boolean;
  /** True si le tool exige un scope (panorama). False pour ceux qui acceptent FR entière
   *  (by_categorie) ou qui ont une validation propre côté lib (densite_professionnels via resolveZone). */
  requireScope: boolean;
};

export type CommuneResolverResult = {
  codeInsee?: string;
  departement?: string;
};

/**
 * Validates XOR + applies nom_commune resolution at the MCP boundary.
 * Throws RangeError (with structured cause) on any validation/resolution error.
 */
export async function applyCommuneResolver(
  args: CommuneResolverArgs,
): Promise<CommuneResolverResult> {
  const { nomCommune, codeInsee, departement, acceptsDepartementAsScope, requireScope } = args;

  // Branch 1 : nom_commune + code_insee → always redundant
  if (nomCommune && codeInsee) {
    throw new RangeError(
      "Paramètres redondants : passer SOIT `code_insee` SOIT `nom_commune`, pas les deux.",
      { cause: { kind: "redundant_commune_params", input: { nom_commune: nomCommune, code_insee: codeInsee } } },
    );
  }

  // Branch 2 : code_insee + departement → redundant (only if dept is a calc scope on this tool;
  // densite_professionnels has its own XOR enforced upstream by resolveZone, so we delegate to it
  // by passing acceptsDepartementAsScope=true and letting the lib throw).
  if (codeInsee && departement && acceptsDepartementAsScope) {
    // Don't throw here for densite_professionnels — resolveZone will. For by_categorie
    // (no resolveZone equivalent), we DO throw to surface the XOR violation explicitly.
    // Simplest design: always throw at boundary. resolveZone becomes defense-in-depth.
    throw new RangeError(
      "Paramètres redondants : passer SOIT `code_insee` (scope commune) SOIT `departement` (scope département), pas les deux.",
      { cause: { kind: "redundant_commune_params", input: { code_insee: codeInsee, departement } } },
    );
  }

  // Branch 3 : nom_commune → resolve (departement, si présent, agit comme hint resolver, pas comme scope)
  if (nomCommune) {
    const result = await resolveNomCommune({ nom: nomCommune, ...(departement ? { departement } : {}) });
    if (!result.resolved) {
      throw new RangeError(formatResolveError(result.error), { cause: result.error });
    }
    return { codeInsee: result.commune.code };
  }

  // Branch 4 : code_insee seul → pass-through
  if (codeInsee) {
    return { codeInsee };
  }

  // Branch 5 : departement seul → pass-through si tool l'accepte, sinon erreur message-only
  // (pas de `cause` structurée : aligné avec le pattern existant requireString/requireOneOf qui
  // throw RangeError sans cause — `error.data` sera undefined, le message texte suffit pour ce cas).
  if (departement) {
    if (acceptsDepartementAsScope) {
      return { departement };
    }
    throw new RangeError(
      "Scope département non supporté par ce tool (calcul commune uniquement). Utiliser `code_insee` ou `nom_commune`.",
    );
  }

  // Branch 6 : nothing fourni
  if (requireScope) {
    throw new RangeError(
      "Scope requis : passer `code_insee` (5 chiffres) ou `nom_commune` (nom officiel).",
    );
  }
  return {};
}

function formatResolveError(err: ResolveCommuneError): string {
  switch (err.kind) {
    case "ambiguous_commune":
      return `Commune ambiguë : ${err.total_matches} commune${err.total_matches > 1 ? "s" : ""} correspond${err.total_matches > 1 ? "ent" : ""} à '${err.input.nom_commune}'${err.input.departement ? ` dans le département '${err.input.departement}'` : ""}. Préciser le département via \`departement\`, ou choisir un code INSEE dans \`candidates\`.`;
    case "commune_not_in_department":
      return `Commune '${err.input.nom_commune}' introuvable dans le département '${err.input.departement}'. Trouvée dans d'autres départements (voir \`matches_in_other_dept\`).`;
    case "unknown_commune":
      return `Commune '${err.input.nom_commune}' inconnue. ${err.hint}`;
  }
}
```

### Patch `api/mcp.ts:384-393`

```typescript
if (err instanceof RangeError) {
  const message = err.message;
  const data = err.cause; // ← NEW (was implicitly undefined)
  console.warn(`[france-data-mcp] bad_request on ${request.method}: ${message}`);
  emit(ctx, start, request.method, {
    status: 400,
    outcome: "bad_request",
    level: "warn",
    extra: { error: message },
  });
  return error(id, -32602, message, data); // ← NEW : 4th arg
}
```

---

## 8. Périmètre exclu (YAGNI)

| Item | Pourquoi exclu | Trigger d'inclusion future |
|---|---|---|
| Normalisation `St → Saint` | YAGNI, pédagogique via `unknown_commune` | Si Sentry compte > 50 `unknown_commune` répétés/mois sur input commençant par `St-`/`St ` |
| Extension `densite_etablissements_sante` au niveau commune | Chantier RPC SQL distinct (~2× effort) | Ticket V0.20 backlog |
| Cache local des 35K communes | Coût mémoire (~4 MB) + invalidation COG annuelle ; geo.api.gouv.fr est rapide (~50ms p50) | Si p99 latence resolver > 500ms en prod |
| Support `code_postal` comme alternative | Hors scope demande Geo Intel | Si demande explicite |
| Support `lat/lon` comme alternative | Déjà couvert par les tools `*_in_radius` | — |
| Support codes EPCI / cantons / arrondissements PML | Sémantique distincte (zone administrative ≠ commune) | Chantier séparé si besoin |

---

## 9. Risques & mitigations

| Risque | Probabilité | Impact | Mitigation |
|---|---|---|---|
| `geo.api.gouv.fr` indispo ou lent (single point of dep) | Faible (gov, SLA bon historiquement) | Tool fail soft : `unknown_commune` au lieu de timeout opaque | Reuse `searchCommunes` qui a déjà `fetchJson` + `signal` + timeout. Ajouter test mock `network error → ResolveCommuneError` ? Hors scope V0.19.0, déjà couvert par catch root. |
| Double round-trip API en cas `commune_not_in_department` (rare) | Faible (cas erreur) | +50ms sur erreur uniquement | Acceptable, valeur pédagogique > coût |
| Régression XOR `by_categorie` casse un caller silencieux | Très faible (sémantique latente non documentée) | Caller reçoit erreur claire au lieu d'AND silencieux | CHANGELOG explicite + test garde-fou |
| Test `error.cause` propagation oublié → silence régression future | Moyenne | Geo Intel perd le payload structuré silencieusement | Test obligatoire `api/mcp-handler-error-cause.test.ts` (étape 5 spec) |
| Description tool trop longue → blocage LLM context | Faible | LLM ignore le nouveau param | Wording concis, exemples courts dans `description` du schema |

---

## 10. Plan d'exécution (référence)

Voir `docs/plans/nom-commune-resolver-v019-plan.md` (généré par `superpowers:writing-plans` après validation de ce design).

Phases macro :

1. **Lib extension** : `searchCommunes` accepte `codeDepartement` + test
2. **Helper resolver** : `api/_lib/resolve-commune.ts` + tests unitaires (9 cas matrice)
3. **Helper boundary** : `api/_lib/apply-commune-resolver.ts` + tests unitaires
4. **Patch `api/mcp.ts`** : propagation `error.cause` + test garde-fou
5. **Câblage `by_categorie`** : ajout `nom_commune`, XOR strict, description, tests boundary
6. **Câblage `panorama_sante_territoire`** : ajout `nom_commune`, description, tests boundary
7. **Câblage `densite_professionnels_sante`** : ajout `nom_commune`, description, tests boundary
8. **Discipline post-fix** : `/simplify` × 3 agents + `/review` Passe 1 (3 agents) + `/review` Passe 2 (2 agents)
9. **Documentation** : CHANGELOG + CLAUDE.md + README si applicable + entry backlog V0.20 (`densite_etablissements_sante` commune)
10. **Bump version** : `package.json` + `server.json` + `src/core/version.ts` → 0.19.0
11. **Commit + tag** : `git commit -a` + `git tag -a v0.19.0` + `git push --follow-tags`
12. **Vercel auto-deploy** + `/healthz` check (HTTP endpoint)
13. **Stop** : Cyril prend la main pour `pnpm publish` (npm OTP 2FA) + `mcp-publisher publish` (GitHub OAuth)

---

## 11. Annexes

### A. Tests live geo.api.gouv.fr (2026-05-23)

```bash
# Filtre codeDepartement natif
$ curl -s "https://geo.api.gouv.fr/communes?nom=Saint-Martin&codeDepartement=08&fields=nom,code&limit=5" | jq
[
  { "nom": "Mont-Saint-Martin", "code": "08308" },
  { "nom": "Hannogne-Saint-Martin", "code": "08209" }
]
# (Note : aucune commune exactement "Saint-Martin" dans 08 → cas commune_not_in_department)

# Casse + accents → géré par API
$ curl -s "https://geo.api.gouv.fr/communes?nom=Saint-Etienne&boost=population&limit=1" | jq
[{ "nom": "Saint-Étienne", "code": "42218", ... }]

$ curl -s "https://geo.api.gouv.fr/communes?nom=lille&boost=population&limit=1" | jq
[{ "nom": "Lille", "code": "59350", ... }]

# Abréviations → NON gérées
$ curl -s "https://geo.api.gouv.fr/communes?nom=St-Martin&codeDepartement=08&limit=5" | jq
[]
```

### B. Calcul effort

| Étape | Effort estimé |
|---|---|
| Lib extension (`searchCommunes`) | 20 min |
| Helper resolver + tests | 1h |
| Helper boundary + tests | 1h |
| Patch `api/mcp.ts` + test | 20 min |
| Câblage 3 tools + descriptions + tests | 1h30 |
| Discipline post-fix (`/simplify` + `/review` × 2) | 1h |
| Doc (CHANGELOG + CLAUDE.md + backlog V0.20) | 30 min |
| Bump version + commit + tag + push | 10 min |
| **TOTAL** | **~5h** |

### C. Glossaire

- **Boundary** : couche `api/` (handlers MCP). Distincte de la lib `src/` (OSS publiable).
- **XOR strict** : exactement un des params attendus, sinon `RangeError`.
- **PML** : Paris / Marseille / Lyon (arrondissements vs commune-mère).
- **PMUN** : Population Municipale, recensement INSEE.
- **Match exact normalisé** : comparaison après `NFD + suppression diacritiques + toLowerCase`.

### D. Sources

- `geo.api.gouv.fr` documentation : https://geo.api.gouv.fr/decoupage-administratif/communes
- Pattern `LookupResult<T>` : `src/core/lookup-result.ts`
- Pattern `requireOneOf` / `requireString` : `api/_lib/args.ts`
- Pattern XOR `resolveZone` (V0.9 densités) : `src/sante/densite.ts:230`
- Pattern `error.data` JSON-RPC 2.0 §5.1
- Mémoire `feedback-double-livraison-md-html.md`
