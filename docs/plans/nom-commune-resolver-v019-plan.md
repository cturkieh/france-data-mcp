# V0.19.0 — `nom_commune` resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un paramètre `nom_commune` (string) accepté en alternative à `code_insee` sur 3 tools MCP, avec résolution interne via `geo.api.gouv.fr`. Économie Geo Intel : 2 round-trips MCP → 1 (~5s/appel). Rétro-compat totale.

**Architecture:** Un helper boundary partagé `applyCommuneResolver()` (XOR + format erreurs) consomme un helper sous-jacent `resolveNomCommune()` (résolution + match exact). Erreurs structurées propagées via `RangeError(msg, { cause })` → `error.data` JSON-RPC (patch 3 lignes sur `api/mcp.ts`). XOR strict introduit dans `etablissements_finess_by_categorie` au passage.

**Tech Stack:** TypeScript strict + Node serverless (Vercel `api/`) + lib pure (`src/`) + pnpm + vitest + biome. Aucune migration DB, aucune nouvelle dépendance npm.

**Référence design source:** `docs/plans/nom-commune-resolver-v019.md` (commit f96f01e) + jumeau `.html`.

**Stratégie de commits:**
- Le projet a une **discipline post-fix lourde** (simplify 3 agents + review × 2 = 5 agents). Au lieu d'invoquer 25+ agents avec un commit atomique par étape, on regroupe en **3 commits release-ready** :
  1. `feat(v019): nom_commune resolver sur 3 tools` — TOUT le code (lib + helpers + patch mcp + 3 câblages + tests) après discipline post-fix complète appliquée au working tree
  2. `docs(v019): CHANGELOG + CLAUDE.md + backlog`
  3. `chore(release): 0.19.0` (bump des 3 sources version)
- Le TDD reste step-by-step **dans la session** (red → green → refactor) ; les commits ne tombent qu'aux frontières propres.

---

## File Structure

### Nouveaux fichiers

| Fichier | Responsabilité |
|---|---|
| `api/_lib/resolve-commune.ts` | Helper `resolveNomCommune()` + types `ResolveCommuneResult` / `ResolveCommuneError` |
| `api/_lib/resolve-commune.test.ts` | 9 cas matrice + cas pathologiques |
| `api/_lib/apply-commune-resolver.ts` | Helper boundary `applyCommuneResolver()` + format messages erreurs |
| `api/_lib/apply-commune-resolver.test.ts` | Toutes branches du helper boundary |
| `api/mcp-handler-error-cause.test.ts` | Garde-fou propagation `err.cause` → `error.data` JSON-RPC |
| `api/tools-v019.test.ts` | Tests boundary nouveaux comportements `nom_commune` + XOR strict by_categorie |

### Fichiers modifiés

| Fichier | Modification |
|---|---|
| `src/territoire/communes.ts` | Ajouter `codeDepartement?: string` à `SearchCommunesOptions` + transmission `URLSearchParams` |
| `src/territoire/communes.test.ts` | 1 test du nouveau param `codeDepartement` |
| `api/mcp.ts:384-393` | Propagation `err.cause` au 4ème arg de `error()` (3 lignes) |
| `api/tools.ts:1429-1500` | `etablissements_finess_by_categorie` : ajout `nom_commune`, XOR strict, description |
| `api/tools.ts:2204-2284` | `panorama_sante_territoire` : ajout `nom_commune`, `required: []`, description |
| `api/tools.ts:2050-2128` | `densite_professionnels_sante` : ajout `nom_commune`, sémantique conditionnelle `code_dept`, description |
| `CHANGELOG.md` | Section V0.19.0 |
| `CLAUDE.md` (projet) | Convention `applyCommuneResolver` + sémantique conditionnelle code_dept |
| `docs/backlog.md` | Entry V0.20 « étendre `densite_etablissements_sante` au niveau commune » |
| `package.json`, `server.json`, `src/core/version.ts` | Bump 0.18.0 → 0.19.0 |

---

## Task 1 : Extension lib `searchCommunes` — accepter `codeDepartement`

**Files:**
- Modify: `src/territoire/communes.ts:37-53` (type `SearchCommunesOptions`) + `:91-113` (impl)
- Test: `src/territoire/communes.test.ts` (append 1 nouveau `it`)

- [ ] **Step 1.1 — Écrire le test failing**

Append à `src/territoire/communes.test.ts` (dans le `describe("searchCommunes", ...)` existant) :

```typescript
it("transmet codeDepartement à l'API geo.api.gouv.fr quand fourni", async () => {
  const fetchMock = vi.spyOn(global, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify([{ nom: "Mont-Saint-Martin", code: "08308", codeDepartement: "08" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await searchCommunes({ nom: "Saint-Martin", codeDepartement: "08" });
  expect(fetchMock).toHaveBeenCalledOnce();
  const url = String(fetchMock.mock.calls[0]?.[0] ?? "");
  expect(url).toContain("nom=Saint-Martin");
  expect(url).toContain("codeDepartement=08");
  fetchMock.mockRestore();
});
```

- [ ] **Step 1.2 — Run le test, vérifier qu'il échoue**

```bash
pnpm exec vitest run src/territoire/communes.test.ts -t "transmet codeDepartement"
```

Expected: FAIL avec message type "Property 'codeDepartement' does not exist on type 'SearchCommunesOptions'" OU le test passe mais l'URL ne contient pas `codeDepartement` (depend if TS strict mode).

- [ ] **Step 1.3 — Étendre le type `SearchCommunesOptions`**

Dans `src/territoire/communes.ts:37-53`, ajouter une ligne :

```typescript
export type SearchCommunesOptions = {
  nom?: string;
  codePostal?: string;
  code?: string;
  /** Filtre par département (param natif geo.api.gouv.fr). Combinable avec `nom`. */
  codeDepartement?: string; // ← NEW
  limit?: number;
  boostPopulation?: boolean;
  signal?: AbortSignal;
};
```

- [ ] **Step 1.4 — Transmettre le param dans l'URL**

Dans `src/territoire/communes.ts:91-113` (fonction `searchCommunes`), après la ligne `if (code) params.set("code", code);` (~ligne 104), ajouter :

```typescript
const { nom, codePostal, code, codeDepartement, limit = 10, boostPopulation = false, signal } = options;
// ...
if (codeDepartement) params.set("codeDepartement", codeDepartement);
```

Penser à étendre le destructuring `const { ... } = options;` en haut de fonction pour inclure `codeDepartement`.

- [ ] **Step 1.5 — Run le test, vérifier qu'il passe**

```bash
pnpm exec vitest run src/territoire/communes.test.ts -t "transmet codeDepartement"
```

Expected: PASS

- [ ] **Step 1.6 — Run tous les tests communes**

```bash
pnpm exec vitest run src/territoire/communes.test.ts
```

Expected: tous PASS (aucune régression)

- [ ] **Step 1.7 — `pnpm typecheck` clean**

```bash
pnpm typecheck
```

Expected: no errors

---

## Task 2 : Helper `resolveNomCommune()` + types

**Files:**
- Create: `api/_lib/resolve-commune.ts`
- Create: `api/_lib/resolve-commune.test.ts`

- [ ] **Step 2.1 — Écrire les 9 tests failing en TDD**

Créer `api/_lib/resolve-commune.test.ts` :

```typescript
import { describe, expect, it, vi } from "vitest";
import * as communes from "../../src/territoire/communes.js";
import { resolveNomCommune } from "./resolve-commune.js";

const mockCommunes = (list: Partial<communes.Commune>[]) => {
  return vi.spyOn(communes, "searchCommunes").mockImplementation(async (opts) => {
    // Le helper fait potentiellement 2 appels (avec dept puis sans). On retourne
    // la même liste filtrée par dept si fourni — simule le filtre API natif.
    const all = list.map((c) => ({
      code: c.code ?? "",
      nom: c.nom ?? "",
      codesPostaux: c.codesPostaux ?? [],
      ...(c.codeDepartement !== undefined ? { codeDepartement: c.codeDepartement } : {}),
      ...(c.population !== undefined ? { population: c.population } : {}),
    })) as communes.Commune[];
    return opts.codeDepartement
      ? all.filter((c) => c.codeDepartement === opts.codeDepartement)
      : all;
  });
};

describe("resolveNomCommune", () => {
  it("Cas 1 — 1 match unique → resolved: true", async () => {
    mockCommunes([{ code: "59350", nom: "Lille", codeDepartement: "59", population: 238246 }]);
    const result = await resolveNomCommune({ nom: "Lille" });
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.commune.code).toBe("59350");
  });

  it("Cas 2 — N matches → ambiguous_commune avec candidates", async () => {
    mockCommunes([
      { code: "97801", nom: "Saint-Martin", codeDepartement: "978", population: 31160 },
      { code: "65392", nom: "Saint-Martin", codeDepartement: "65", population: 436 },
      { code: "32389", nom: "Saint-Martin", codeDepartement: "32", population: 434 },
    ]);
    const result = await resolveNomCommune({ nom: "Saint-Martin" });
    expect(result.resolved).toBe(false);
    if (!result.resolved && result.error.kind === "ambiguous_commune") {
      expect(result.error.candidates).toHaveLength(3);
      expect(result.error.total_matches).toBe(3);
      expect(result.error.truncated).toBe(false);
    } else throw new Error("expected ambiguous_commune");
  });

  it("Cas 3 — nom + dept, 0 dans dept mais N ailleurs → commune_not_in_department", async () => {
    mockCommunes([
      { code: "97801", nom: "Saint-Martin", codeDepartement: "978", population: 31160 },
      { code: "65392", nom: "Saint-Martin", codeDepartement: "65", population: 436 },
    ]);
    const result = await resolveNomCommune({ nom: "Saint-Martin", departement: "08" });
    expect(result.resolved).toBe(false);
    if (!result.resolved && result.error.kind === "commune_not_in_department") {
      expect(result.error.matches_in_other_dept).toHaveLength(2);
      expect(result.error.input.departement).toBe("08");
    } else throw new Error("expected commune_not_in_department");
  });

  it("Cas 4 — nom + dept, 1 match dans dept → resolved: true", async () => {
    mockCommunes([
      { code: "65392", nom: "Saint-Martin", codeDepartement: "65", population: 436 },
      { code: "97801", nom: "Saint-Martin", codeDepartement: "978", population: 31160 },
    ]);
    const result = await resolveNomCommune({ nom: "Saint-Martin", departement: "65" });
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.commune.code).toBe("65392");
  });

  it("Cas 5 — nom inexistant → unknown_commune", async () => {
    mockCommunes([]);
    const result = await resolveNomCommune({ nom: "ZZZINEXISTANT" });
    expect(result.resolved).toBe(false);
    if (!result.resolved) expect(result.error.kind).toBe("unknown_commune");
  });

  it("Cas 6 — abréviation (St-Martin) → unknown_commune avec hint pédagogique", async () => {
    mockCommunes([]); // API geo.api.gouv.fr renvoie 0 pour St-Martin
    const result = await resolveNomCommune({ nom: "St-Martin" });
    expect(result.resolved).toBe(false);
    if (!result.resolved && result.error.kind === "unknown_commune") {
      expect(result.error.hint).toMatch(/officiel|Saint/i);
    } else throw new Error("expected unknown_commune");
  });

  it("Cas 7 — casse différente (lille) → resolved (case-insensitive)", async () => {
    mockCommunes([{ code: "59350", nom: "Lille", codeDepartement: "59", population: 238246 }]);
    const result = await resolveNomCommune({ nom: "lille" });
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.commune.code).toBe("59350");
  });

  it("Cas 8 — accents (Saint-Etienne) → resolved (NFD normalisation)", async () => {
    // L'API geo.api.gouv.fr gère les accents nativement : on simule donc une réponse
    // avec le nom canonique accentué Saint-Étienne, alors que l'input n'a pas d'accent.
    mockCommunes([{ code: "42218", nom: "Saint-Étienne", codeDepartement: "42", population: 173136 }]);
    const result = await resolveNomCommune({ nom: "Saint-Etienne" });
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.commune.code).toBe("42218");
  });

  it("Cas 9 — cap candidates à 10 + truncated:true si N>10", async () => {
    const list = Array.from({ length: 12 }, (_, i) => ({
      code: `0${i}001`,
      nom: "Saint-Martin",
      codeDepartement: String(i + 10),
      population: 1000 - i,
    }));
    mockCommunes(list);
    const result = await resolveNomCommune({ nom: "Saint-Martin" });
    if (!result.resolved && result.error.kind === "ambiguous_commune") {
      expect(result.error.total_matches).toBe(12);
      expect(result.error.candidates).toHaveLength(10);
      expect(result.error.truncated).toBe(true);
    } else throw new Error("expected ambiguous_commune");
  });

  it("Garde — input vide → unknown_commune défensif", async () => {
    mockCommunes([]);
    const result = await resolveNomCommune({ nom: "   " });
    expect(result.resolved).toBe(false);
    if (!result.resolved) expect(result.error.kind).toBe("unknown_commune");
  });

  it("Garde — filtre exact élimine le bruit fuzzy (Mont-Saint-Martin ne matche pas Saint-Martin)", async () => {
    mockCommunes([
      { code: "08308", nom: "Mont-Saint-Martin", codeDepartement: "08", population: 88 },
      { code: "08209", nom: "Hannogne-Saint-Martin", codeDepartement: "08", population: 445 },
    ]);
    const result = await resolveNomCommune({ nom: "Saint-Martin", departement: "08" });
    // Filtré exact dans dept = 0 → fallback global appelé, mais notre mock retourne aussi 0 dans le fallback
    // (le mock ne filtre par dept que si codeDepartement passed → ici fallback sans dept renvoie les 2 noms,
    // mais NORMALIZE-EXACT échoue donc 0). Résultat: unknown_commune.
    expect(result.resolved).toBe(false);
    if (!result.resolved) expect(result.error.kind).toBe("unknown_commune");
  });
});
```

- [ ] **Step 2.2 — Run les tests, vérifier qu'ils échouent**

```bash
pnpm exec vitest run api/_lib/resolve-commune.test.ts
```

Expected: FAIL — `Cannot find module './resolve-commune.js'`

- [ ] **Step 2.3 — Implémenter `resolve-commune.ts`**

Créer `api/_lib/resolve-commune.ts` :

```typescript
/**
 * Resolver `nom_commune` → `code_insee` via geo.api.gouv.fr.
 *
 * Source de la sémantique : `docs/plans/nom-commune-resolver-v019.md` §3.
 *
 * Ne throw jamais — retourne toujours un résultat discriminé `ResolveCommuneResult`.
 * Le caller (boundary `applyCommuneResolver`) traduit en `RangeError({cause})` pour JSON-RPC.
 */

import { searchCommunes, type Commune } from "../../src/territoire/communes.js";

export type ResolveCandidate = {
  code: string;
  nom: string;
  codeDepartement: string;
  population: number | null;
};

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
      matches_in_other_dept: ResolveCandidate[];
    };

export type ResolveCommuneResult =
  | { resolved: true; commune: Commune }
  | { resolved: false; error: ResolveCommuneError };

const CAP_CANDIDATES = 10;
const SEARCH_LIMIT = 30;
const UNKNOWN_HINT =
  "Utiliser le nom officiel complet (ex. 'Saint-Martin' et non 'St-Martin'). Les abréviations 'St'/'Ste' ne sont pas reconnues. Si le nom contient un tiret, le conserver.";

/** Normalize for case-insensitive + accent-insensitive comparison. */
function normalizeName(s: string): string {
  return s.trim().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function toCandidate(c: Commune): ResolveCandidate {
  return {
    code: c.code,
    nom: c.nom,
    codeDepartement: c.codeDepartement ?? "",
    population: c.population ?? null,
  };
}

function buildInput(input: { nom: string; departement?: string }): { nom_commune: string; departement?: string } {
  return {
    nom_commune: input.nom,
    ...(input.departement ? { departement: input.departement } : {}),
  };
}

export async function resolveNomCommune(input: {
  nom: string;
  departement?: string;
  signal?: AbortSignal;
}): Promise<ResolveCommuneResult> {
  const wantedKey = normalizeName(input.nom);

  // Garde défensive — caller boundary devrait avoir validé non-vide
  if (!wantedKey) {
    return {
      resolved: false,
      error: {
        kind: "unknown_commune",
        input: buildInput(input),
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
    return { resolved: true, commune: exact[0]! };
  }

  if (exact.length > 1) {
    return {
      resolved: false,
      error: {
        kind: "ambiguous_commune",
        input: buildInput(input),
        candidates: exact.slice(0, CAP_CANDIDATES).map(toCandidate),
        total_matches: exact.length,
        truncated: exact.length > CAP_CANDIDATES,
      },
    };
  }

  // exact.length === 0 → distinguer "not_in_dept" vs "unknown" si dept était filtre
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
      input: buildInput(input),
      hint: UNKNOWN_HINT,
    },
  };
}
```

- [ ] **Step 2.4 — Run les tests, vérifier qu'ils passent**

```bash
pnpm exec vitest run api/_lib/resolve-commune.test.ts
```

Expected: tous les 11 tests PASS (9 cas matrice + 2 gardes).

- [ ] **Step 2.5 — Typecheck**

```bash
pnpm typecheck
```

Expected: no errors

---

## Task 3 : Helper boundary `applyCommuneResolver()` + format erreurs

**Files:**
- Create: `api/_lib/apply-commune-resolver.ts`
- Create: `api/_lib/apply-commune-resolver.test.ts`

- [ ] **Step 3.1 — Écrire les tests failing**

Créer `api/_lib/apply-commune-resolver.test.ts` :

```typescript
import { describe, expect, it, vi } from "vitest";
import * as resolveModule from "./resolve-commune.js";
import { applyCommuneResolver } from "./apply-commune-resolver.js";

describe("applyCommuneResolver", () => {
  it("nom_commune seul, résolu → retourne { codeInsee }", async () => {
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: { code: "59350", nom: "Lille", codesPostaux: [], codeDepartement: "59" } as never,
    });
    const result = await applyCommuneResolver({
      nomCommune: "Lille",
      codeInsee: undefined,
      departement: undefined,
      acceptsDepartementAsScope: true,
      requireScope: false,
    });
    expect(result).toEqual({ codeInsee: "59350" });
  });

  it("nom_commune + departement, résolu → dept consommé comme hint, retourne { codeInsee } seul", async () => {
    const spy = vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: { code: "65392", nom: "Saint-Martin", codesPostaux: [], codeDepartement: "65" } as never,
    });
    const result = await applyCommuneResolver({
      nomCommune: "Saint-Martin",
      codeInsee: undefined,
      departement: "65",
      acceptsDepartementAsScope: true,
      requireScope: false,
    });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ nom: "Saint-Martin", departement: "65" }));
    expect(result).toEqual({ codeInsee: "65392" }); // dept N'EST PAS réinjecté
  });

  it("nom_commune ambigu → RangeError avec cause structurée ambiguous_commune", async () => {
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: false,
      error: {
        kind: "ambiguous_commune",
        input: { nom_commune: "Saint-Martin" },
        candidates: [
          { code: "65392", nom: "Saint-Martin", codeDepartement: "65", population: 436 },
        ],
        total_matches: 5,
        truncated: false,
      },
    });
    await expect(
      applyCommuneResolver({
        nomCommune: "Saint-Martin",
        codeInsee: undefined,
        departement: undefined,
        acceptsDepartementAsScope: true,
        requireScope: false,
      }),
    ).rejects.toThrow(/ambiguë/i);
    try {
      await applyCommuneResolver({
        nomCommune: "Saint-Martin",
        codeInsee: undefined,
        departement: undefined,
        acceptsDepartementAsScope: true,
        requireScope: false,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
      expect((err as RangeError).cause).toMatchObject({ kind: "ambiguous_commune", total_matches: 5 });
    }
  });

  it("nom_commune + code_insee → RangeError redundant_commune_params (sans appeler resolveNomCommune)", async () => {
    const spy = vi.spyOn(resolveModule, "resolveNomCommune");
    await expect(
      applyCommuneResolver({
        nomCommune: "Lille",
        codeInsee: "59350",
        departement: undefined,
        acceptsDepartementAsScope: true,
        requireScope: false,
      }),
    ).rejects.toThrow(/redondants/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("code_insee + departement (acceptsDepartementAsScope:true) → RangeError redundant XOR", async () => {
    await expect(
      applyCommuneResolver({
        nomCommune: undefined,
        codeInsee: "59350",
        departement: "59",
        acceptsDepartementAsScope: true,
        requireScope: false,
      }),
    ).rejects.toThrow(/redondants|SOIT/i);
  });

  it("code_insee seul → pass-through", async () => {
    const result = await applyCommuneResolver({
      nomCommune: undefined,
      codeInsee: "59350",
      departement: undefined,
      acceptsDepartementAsScope: true,
      requireScope: false,
    });
    expect(result).toEqual({ codeInsee: "59350" });
  });

  it("departement seul + acceptsDepartementAsScope:true → pass-through dept", async () => {
    const result = await applyCommuneResolver({
      nomCommune: undefined,
      codeInsee: undefined,
      departement: "59",
      acceptsDepartementAsScope: true,
      requireScope: false,
    });
    expect(result).toEqual({ departement: "59" });
  });

  it("departement seul + acceptsDepartementAsScope:false → RangeError scope dept non supporté", async () => {
    await expect(
      applyCommuneResolver({
        nomCommune: undefined,
        codeInsee: undefined,
        departement: "59",
        acceptsDepartementAsScope: false,
        requireScope: true,
      }),
    ).rejects.toThrow(/département non supporté|calcul commune/i);
  });

  it("rien fourni + requireScope:true → RangeError scope requis", async () => {
    await expect(
      applyCommuneResolver({
        nomCommune: undefined,
        codeInsee: undefined,
        departement: undefined,
        acceptsDepartementAsScope: false,
        requireScope: true,
      }),
    ).rejects.toThrow(/scope requis|code_insee|nom_commune/i);
  });

  it("rien fourni + requireScope:false → retourne {}", async () => {
    const result = await applyCommuneResolver({
      nomCommune: undefined,
      codeInsee: undefined,
      departement: undefined,
      acceptsDepartementAsScope: true,
      requireScope: false,
    });
    expect(result).toEqual({});
  });
});
```

- [ ] **Step 3.2 — Run les tests, vérifier qu'ils échouent**

```bash
pnpm exec vitest run api/_lib/apply-commune-resolver.test.ts
```

Expected: FAIL — module introuvable

- [ ] **Step 3.3 — Implémenter `apply-commune-resolver.ts`**

Créer `api/_lib/apply-commune-resolver.ts` :

```typescript
/**
 * Helper boundary MCP : applique la résolution `nom_commune → code_insee` +
 * valide les XOR (code_insee vs nom_commune, code_insee vs departement quand
 * dept est un scope). Source de vérité : `docs/plans/nom-commune-resolver-v019.md`.
 */

import { resolveNomCommune, type ResolveCommuneError } from "./resolve-commune.js";

export type CommuneResolverArgs = {
  nomCommune: string | undefined;
  codeInsee: string | undefined;
  departement: string | undefined;
  /** True si le tool sait calculer au niveau département (by_categorie, densite_professionnels).
   *  False pour panorama (commune uniquement). */
  acceptsDepartementAsScope: boolean;
  /** True si le tool exige un scope (panorama). False pour ceux qui acceptent FR entière
   *  ou ont validation propre côté lib (densite_professionnels via resolveZone). */
  requireScope: boolean;
};

export type CommuneResolverResult = {
  codeInsee?: string;
  departement?: string;
};

export async function applyCommuneResolver(
  args: CommuneResolverArgs,
): Promise<CommuneResolverResult> {
  const { nomCommune, codeInsee, departement, acceptsDepartementAsScope, requireScope } = args;

  // Branch 1 : nom_commune + code_insee → redondant
  if (nomCommune && codeInsee) {
    throw new RangeError(
      "Paramètres redondants : passer SOIT `code_insee` SOIT `nom_commune`, pas les deux.",
      {
        cause: {
          kind: "redundant_commune_params",
          input: { nom_commune: nomCommune, code_insee: codeInsee },
        },
      },
    );
  }

  // Branch 2 : code_insee + departement (sur tool qui accepte dept comme scope) → redondant
  if (codeInsee && departement && acceptsDepartementAsScope) {
    throw new RangeError(
      "Paramètres redondants : passer SOIT `code_insee` (scope commune) SOIT `departement` (scope département), pas les deux.",
      {
        cause: {
          kind: "redundant_commune_params",
          input: { code_insee: codeInsee, departement },
        },
      },
    );
  }

  // Branch 3 : nom_commune → resolve (dept = hint, pas scope)
  if (nomCommune) {
    const result = await resolveNomCommune({
      nom: nomCommune,
      ...(departement ? { departement } : {}),
    });
    if (!result.resolved) {
      throw new RangeError(formatResolveError(result.error), { cause: result.error });
    }
    return { codeInsee: result.commune.code };
  }

  // Branch 4 : code_insee seul → pass-through
  if (codeInsee) {
    return { codeInsee };
  }

  // Branch 5 : departement seul → pass-through si accepté en scope, sinon erreur
  if (departement) {
    if (acceptsDepartementAsScope) {
      return { departement };
    }
    throw new RangeError(
      "Scope département non supporté par ce tool (calcul commune uniquement). Utiliser `code_insee` ou `nom_commune`.",
    );
  }

  // Branch 6 : rien fourni
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

- [ ] **Step 3.4 — Run les tests**

```bash
pnpm exec vitest run api/_lib/apply-commune-resolver.test.ts
```

Expected: tous PASS

- [ ] **Step 3.5 — Typecheck**

```bash
pnpm typecheck
```

Expected: no errors

---

## Task 4 : Patch `api/mcp.ts` — propagation `err.cause` → JSON-RPC `error.data`

**Files:**
- Create: `api/mcp-handler-error-cause.test.ts`
- Modify: `api/mcp.ts:384-393`

- [ ] **Step 4.1 — Écrire le test garde-fou**

Créer `api/mcp-handler-error-cause.test.ts` :

```typescript
import { describe, expect, it, vi } from "vitest";
import handler from "./mcp.js";
// On utilise les types Vercel pour mocker req/res. Pattern existant dans
// api/mcp-handler-parse-error.test.ts (regarder ce fichier pour exact API).

describe("api/mcp.ts — propagation err.cause", () => {
  it("RangeError avec cause structurée → error.data du JSON-RPC contient la cause", async () => {
    // Mock un tool qui throw RangeError({ cause }).
    // On utilise tools/list pour vérifier que le mock est appelé, puis tools/call.
    //
    // Le test plus simple : injecter un tool de test dans le runtime n'est pas
    // trivial sans setup. On utilise UN TOOL EXISTANT qui peut throw RangeError —
    // ex. `densite_professionnels_sante` avec XOR violation (code_dept + code_insee).
    //
    // Mais ce test serait alors couplé à un comportement spécifique. Mieux :
    // tester via un appel JSON-RPC réel qui throw avec cause.
    //
    // Approche retenue : tester avec `etablissements_finess_by_categorie` + `nom_commune` + `code_insee`
    // (cas redundant_commune_params, qui throw RangeError avec cause structurée).

    const req = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: {
          name: "etablissements_finess_by_categorie",
          arguments: { categorie: "labo", nom_commune: "Lille", code_insee: "59350" },
        },
      },
    } as never;

    const json = vi.fn();
    const status = vi.fn().mockReturnThis();
    const setHeader = vi.fn();
    const res = { json, status, setHeader } as never;

    await handler(req, res);
    expect(json).toHaveBeenCalledOnce();
    const response = json.mock.calls[0]?.[0];
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toMatch(/redondants|SOIT/i);
    expect(response.error.data).toMatchObject({
      kind: "redundant_commune_params",
      input: expect.objectContaining({ nom_commune: "Lille", code_insee: "59350" }),
    });
  });
});
```

- [ ] **Step 4.2 — Run, vérifier qu'il échoue**

```bash
pnpm exec vitest run api/mcp-handler-error-cause.test.ts
```

Expected: FAIL — soit le tool ne reconnaît pas `nom_commune` (Task 5 pas encore fait), soit `error.data` est undefined (patch pas encore fait).

> **Note pratique:** ce test dépend de Task 5 (câblage by_categorie) pour être passable. On garde l'ordre : on écrit le test maintenant, on patch mcp.ts maintenant (Step 4.3), et le test passera quand Task 5 sera fait. Marquer `it.todo` temporairement si gênant, ou repousser ce test à la fin de Task 5.

**Décision retenue :** repousser l'exécution de ce test à la fin de Task 5. Garder le code écrit et committer ensemble.

- [ ] **Step 4.3 — Patcher `api/mcp.ts:384-393`**

Localiser dans `api/mcp.ts` (chercher `if (err instanceof RangeError)` ~ligne 384) :

```typescript
// AVANT
if (err instanceof RangeError) {
  const message = err.message;
  console.warn(`[france-data-mcp] bad_request on ${request.method}: ${message}`);
  emit(ctx, start, request.method, {
    status: 400,
    outcome: "bad_request",
    level: "warn",
    extra: { error: message },
  });
  return error(id, -32602, message);
}
```

Remplacer par :

```typescript
// APRÈS — V0.19.0 : propage err.cause au 4ème arg de error() pour JSON-RPC error.data
// (cf. docs/plans/nom-commune-resolver-v019.md §2 décision 5)
if (err instanceof RangeError) {
  const message = err.message;
  const data = err.cause; // ← NEW : payload structuré ({kind, ...}) ou undefined
  console.warn(`[france-data-mcp] bad_request on ${request.method}: ${message}`);
  emit(ctx, start, request.method, {
    status: 400,
    outcome: "bad_request",
    level: "warn",
    extra: { error: message },
  });
  return error(id, -32602, message, data); // ← NEW : 4ème arg
}
```

- [ ] **Step 4.4 — Typecheck**

```bash
pnpm typecheck
```

Expected: no errors. La fonction `error(id, code, message, data?)` accepte déjà 4 args (`api/mcp.ts:499-506`).

- [ ] **Step 4.5 — Run le test parse-error existant (non-régression)**

```bash
pnpm exec vitest run api/mcp-handler-parse-error.test.ts
```

Expected: tous PASS. Le SyntaxError path (V0.12.2) ne propage pas de cause et reste inchangé.

---

## Task 5 : Câblage `etablissements_finess_by_categorie` + XOR strict

**Files:**
- Modify: `api/tools.ts:1429-1500` (inputSchema + handler)
- Modify: `api/tools.test.ts` (tests existants à adapter si XOR strict casse un cas)
- Create: section dans `api/tools-v019.test.ts` (nouveau fichier)

- [ ] **Step 5.1 — Créer `api/tools-v019.test.ts` avec tests failing**

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as resolveModule from "./_lib/resolve-commune.js";
import * as finessDb from "../src/sante/finess-db.js";
import { TOOLS } from "./tools.js"; // export array of tools

const findTool = (name: string) => TOOLS.find((t) => t.name === name);

describe("V0.19.0 — etablissements_finess_by_categorie + nom_commune", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("nom_commune seul → résolu en code_insee, passé à getFinessByCategorie", async () => {
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: { code: "59350", nom: "Lille", codesPostaux: [], codeDepartement: "59" } as never,
    });
    const dbSpy = vi.spyOn(finessDb, "getFinessByCategorie").mockResolvedValueOnce({} as never);
    const tool = findTool("etablissements_finess_by_categorie");
    await tool?.handler({ categorie: "labo", nom_commune: "Lille" });
    expect(dbSpy).toHaveBeenCalledWith(expect.objectContaining({ code_insee: "59350" }));
    expect(dbSpy.mock.calls[0]?.[0].departement).toBeUndefined();
  });

  it("nom_commune + departement (hint) → code_dept consommé comme hint, NON réinjecté en scope", async () => {
    const resolveSpy = vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: { code: "65392", nom: "Saint-Martin", codesPostaux: [], codeDepartement: "65" } as never,
    });
    const dbSpy = vi.spyOn(finessDb, "getFinessByCategorie").mockResolvedValueOnce({} as never);
    const tool = findTool("etablissements_finess_by_categorie");
    await tool?.handler({ categorie: "labo", nom_commune: "Saint-Martin", departement: "65" });
    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({ departement: "65" }));
    expect(dbSpy).toHaveBeenCalledWith(expect.objectContaining({ code_insee: "65392" }));
    expect(dbSpy.mock.calls[0]?.[0].departement).toBeUndefined();
  });

  it("XOR strict : departement + code_insee simultanés → RangeError redondants", async () => {
    const tool = findTool("etablissements_finess_by_categorie");
    await expect(tool?.handler({ categorie: "labo", departement: "59", code_insee: "59350" })).rejects.toThrow(
      /redondants|SOIT/i,
    );
  });

  it("XOR : nom_commune + code_insee simultanés → RangeError", async () => {
    const tool = findTool("etablissements_finess_by_categorie");
    await expect(tool?.handler({ categorie: "labo", nom_commune: "Lille", code_insee: "59350" })).rejects.toThrow(
      /redondants|SOIT/i,
    );
  });

  it("nom_commune ambigu → RangeError avec error.cause.kind=ambiguous_commune", async () => {
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: false,
      error: {
        kind: "ambiguous_commune",
        input: { nom_commune: "Saint-Martin" },
        candidates: [{ code: "65392", nom: "Saint-Martin", codeDepartement: "65", population: 436 }],
        total_matches: 5,
        truncated: false,
      },
    });
    const tool = findTool("etablissements_finess_by_categorie");
    try {
      await tool?.handler({ categorie: "labo", nom_commune: "Saint-Martin" });
      throw new Error("expected RangeError");
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
      expect((err as RangeError).cause).toMatchObject({ kind: "ambiguous_commune" });
    }
  });

  it("rétro-compat : code_insee seul fonctionne comme avant", async () => {
    const dbSpy = vi.spyOn(finessDb, "getFinessByCategorie").mockResolvedValueOnce({} as never);
    const tool = findTool("etablissements_finess_by_categorie");
    await tool?.handler({ categorie: "labo", code_insee: "59350" });
    expect(dbSpy).toHaveBeenCalledWith(expect.objectContaining({ code_insee: "59350" }));
  });

  it("rétro-compat : departement seul fonctionne comme avant", async () => {
    const dbSpy = vi.spyOn(finessDb, "getFinessByCategorie").mockResolvedValueOnce({} as never);
    const tool = findTool("etablissements_finess_by_categorie");
    await tool?.handler({ categorie: "labo", departement: "59" });
    expect(dbSpy).toHaveBeenCalledWith(expect.objectContaining({ departement: "59" }));
  });

  it("rétro-compat : rien fourni (FR entière) fonctionne comme avant", async () => {
    const dbSpy = vi.spyOn(finessDb, "getFinessByCategorie").mockResolvedValueOnce({} as never);
    const tool = findTool("etablissements_finess_by_categorie");
    await tool?.handler({ categorie: "labo" });
    expect(dbSpy).toHaveBeenCalledWith({ famille: "labo" });
  });
});
```

- [ ] **Step 5.2 — Run, vérifier qu'ils échouent**

```bash
pnpm exec vitest run api/tools-v019.test.ts
```

Expected: FAIL — handler ne connaît pas `nom_commune`, pas de XOR strict.

- [ ] **Step 5.3 — Patcher le handler `by_categorie`**

Dans `api/tools.ts` (~ligne 1429-1500), localiser le tool `etablissements_finess_by_categorie`. Modifier :

**A. Ajouter `nom_commune` à `inputSchema.properties`** (après `code_insee` ~ligne 1444) :

```typescript
nom_commune: {
  type: "string",
  description:
    "Nom officiel de commune (alternative à `code_insee`). Ex: \"Lille\", \"Saint-Étienne\". Le serveur résout en interne le code INSEE. Si ambigu (ex \"Saint-Martin\" → 5 villes), retourne une erreur structurée avec candidates. Combinable avec `departement` qui agit alors comme hint de désambiguïsation. NB : abréviations type \"St-Martin\" non reconnues, utiliser le nom officiel complet.",
},
```

**B. Étendre la `description` du tool** (~ligne 1430) :

Ajouter à la fin de la description (avant `Source : FINESS / DREES.`) :

```
V0.19.0 : accepte `nom_commune` (string) comme alternative à `code_insee`. XOR strict — passer SOIT `departement` SOIT `code_insee` SOIT `nom_commune` (combinable avec `departement` comme hint resolver). FR entière (aucun param) acceptée.
```

**C. Remplacer le bloc handler** (~ligne 1461-1500) :

```typescript
handler: async (args) => {
  const famille = asFinessFamille(args.categorie);
  if (!famille) {
    throw new RangeError(`categorie (string) requis : ${FINESS_FAMILLE_INPUTS.join(", ")}.`);
  }
  const departement = asString(args.departement);
  const codeInsee = asString(args.code_insee);
  const nomCommune = asString(args.nom_commune);
  const limit = coerceNumber(args.limit, "limit");

  // V0.19.0 — XOR strict + résolution nom_commune
  const resolved = await applyCommuneResolver({
    nomCommune,
    codeInsee,
    departement,
    acceptsDepartementAsScope: true, // dept seul = scope FR-partiel (filtre famille)
    requireScope: false,             // FR entière acceptée (calcul national)
  });

  const input: Parameters<typeof getFinessByCategorie>[0] = { famille };
  if (resolved.departement) input.departement = resolved.departement;
  if (resolved.codeInsee) input.code_insee = resolved.codeInsee;
  if (limit !== undefined) input.limit = limit;

  // Phase 2 — activite_hebergee (inchangé, mais utilise `resolved.codeInsee` désormais)
  const hostedActivity = familleToHostedActivity(famille);
  const hostedTask: Promise<HostedActivityResult | null> =
    hostedActivity !== null && (resolved.departement || resolved.codeInsee)
      ? safeHostedFetch(
          "etablissements_finess_by_categorie",
          getHostedActivitiesInZone({
            activite: hostedActivity,
            departement: resolved.departement,
            codeInsee: resolved.codeInsee,
          }),
        )
      : Promise.resolve(null);
  const [withPerim, hosted] = await Promise.all([
    (async () =>
      withPerimetre(
        await withFreshness(await getFinessByCategorie(input), args.include_freshness, ["finess"]),
        finessFamillePerimetre([famille]),
      ))(),
    hostedTask,
  ]);
  return withHostedActivity(withPerim, hosted);
},
```

**D. Ajouter l'import `applyCommuneResolver`** en haut de `api/tools.ts` (regrouper avec les autres imports `./_lib/`) :

```typescript
import { applyCommuneResolver } from "./_lib/apply-commune-resolver.js";
```

- [ ] **Step 5.4 — Run les tests V0.19**

```bash
pnpm exec vitest run api/tools-v019.test.ts
```

Expected: les 7 tests `by_categorie` PASS.

- [ ] **Step 5.5 — Run tous les tests `api/tools.test.ts` (non-régression)**

```bash
pnpm exec vitest run api/tools.test.ts
```

Expected: tous PASS. Si un test échoue parce qu'il passait `departement + code_insee` simultanément, l'adapter à passer un seul (corriger la régression de scope du test, pas du code).

- [ ] **Step 5.6 — Run le test mcp-handler-error-cause (Task 4)**

```bash
pnpm exec vitest run api/mcp-handler-error-cause.test.ts
```

Expected: PASS maintenant (l'enchaînement Task 4 + Task 5 est complet).

- [ ] **Step 5.7 — Typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

---

## Task 6 : Câblage `panorama_sante_territoire`

**Files:**
- Modify: `api/tools.ts:2204-2284` (inputSchema + handler)
- Modify: `api/tools-v019.test.ts` (append nouveau `describe`)

- [ ] **Step 6.1 — Append tests dans `api/tools-v019.test.ts`**

```typescript
describe("V0.19.0 — panorama_sante_territoire + nom_commune", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("nom_commune seul → résolu, passé en codeInsee", async () => {
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: { code: "59350", nom: "Lille", codesPostaux: [], codeDepartement: "59" } as never,
    });
    const panoramaSpy = vi.spyOn(panoramaMod, "panoramaSanteTerritoire").mockResolvedValueOnce({} as never);
    const tool = findTool("panorama_sante_territoire");
    await tool?.handler({ nom_commune: "Lille" });
    expect(panoramaSpy).toHaveBeenCalledWith(expect.objectContaining({ codeInsee: "59350" }));
  });

  it("departement seul → RangeError scope dept non supporté", async () => {
    const tool = findTool("panorama_sante_territoire");
    await expect(tool?.handler({ departement: "59" })).rejects.toThrow(
      /département non supporté|calcul commune/i,
    );
  });

  it("rien fourni → RangeError scope requis", async () => {
    const tool = findTool("panorama_sante_territoire");
    await expect(tool?.handler({})).rejects.toThrow(/scope requis|code_insee|nom_commune/i);
  });

  it("rétro-compat : code_insee seul fonctionne", async () => {
    const panoramaSpy = vi.spyOn(panoramaMod, "panoramaSanteTerritoire").mockResolvedValueOnce({} as never);
    const tool = findTool("panorama_sante_territoire");
    await tool?.handler({ code_insee: "59350" });
    expect(panoramaSpy).toHaveBeenCalledWith(expect.objectContaining({ codeInsee: "59350" }));
  });

  it("nom_commune + departement (hint) → résout dans le dept", async () => {
    const resolveSpy = vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: { code: "65392", nom: "Saint-Martin", codesPostaux: [], codeDepartement: "65" } as never,
    });
    vi.spyOn(panoramaMod, "panoramaSanteTerritoire").mockResolvedValueOnce({} as never);
    const tool = findTool("panorama_sante_territoire");
    await tool?.handler({ nom_commune: "Saint-Martin", departement: "65" });
    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({ departement: "65" }));
  });
});
```

Ajouter en haut du fichier `api/tools-v019.test.ts` les imports manquants :

```typescript
import * as panoramaMod from "../src/sante/panorama.js";
```

- [ ] **Step 6.2 — Run, vérifier qu'ils échouent**

```bash
pnpm exec vitest run api/tools-v019.test.ts -t panorama
```

Expected: FAIL — `nom_commune` non reconnu, `departement` non géré.

- [ ] **Step 6.3 — Patcher le handler `panorama_sante_territoire`**

Dans `api/tools.ts:2204-2284`, modifier :

**A. Étendre `inputSchema.properties`** (~ligne 2208) :

```typescript
properties: {
  code_insee: {
    type: "string",
    description: 'Code INSEE de la commune 5 caractères. Ex: "59009" Villeneuve-d\'Ascq, "33063" Bordeaux. Paris/Lyon/Marseille NON supporté.',
  },
  nom_commune: {
    type: "string",
    description: "Nom officiel de commune (alternative à `code_insee`, V0.19). Ex: \"Lille\", \"Saint-Étienne\". Combinable avec `departement` comme hint de désambiguïsation pour homonymes (ex \"Saint-Martin\" + dept \"65\").",
  },
  departement: {
    type: "string",
    description: "Code département INSEE (V0.19, hint resolver uniquement). À utiliser EN COMBINAISON avec `nom_commune` pour désambiguer les homonymes. Seul, lèvera une erreur (panorama = calcul commune uniquement, utiliser `code_insee` ou `nom_commune`).",
  },
  finess_familles: { /* inchangé */ },
},
// removed: required: ["code_insee"]
```

(Supprimer la ligne `required: ["code_insee"]` — la validation est désormais dans `applyCommuneResolver`.)

**B. Étendre la description du tool** :

Ajouter à la fin de la description (avant `Sources :`) :

```
V0.19.0 : accepte `nom_commune` (string) comme alternative à `code_insee`. `departement` (V0.19) = hint resolver uniquement (panorama ne calcule pas par dept).
```

**C. Remplacer le handler** (~ligne 2223-2284) :

```typescript
handler: async (rawArgs) => {
  const args = normalizeAliases(rawArgs, {
    codeInsee: "code_insee",
    insee: "code_insee",
    code: "code_insee",
  });
  const codeInsee = asString(args.code_insee);
  const nomCommune = asString(args.nom_commune);
  const departement = asString(args.departement);

  // V0.19.0 — résolution + validation scope obligatoire (panorama = commune)
  const resolved = await applyCommuneResolver({
    nomCommune,
    codeInsee,
    departement,
    acceptsDepartementAsScope: false, // panorama = commune uniquement
    requireScope: true,
  });
  // resolved.codeInsee garanti défini ici (requireScope: true throw sinon)

  const input: Parameters<typeof panoramaSanteTerritoire>[0] = { codeInsee: resolved.codeInsee! };
  const familles = parseFamilles(args.finess_familles);
  if (familles !== undefined) input.finessFamilles = familles;

  // Phase 2 — activite_hebergee (utilise resolved.codeInsee)
  const finessVoletDesactive = familles?.length === 0;
  const famillesEffectives: readonly FinessFamilleQuery[] = finessVoletDesactive
    ? []
    : (familles ?? DEFAULT_FAMILLES);
  const hostedPromises = famillesEffectives.flatMap((f) => {
    const a = familleToHostedActivity(f);
    if (a === null) return [];
    return [
      safeHostedFetch(
        `panorama_sante_territoire[${f}]`,
        getHostedActivitiesInZone({ activite: a, codeInsee: resolved.codeInsee! }),
      ).then((h) => (h !== null ? ([f, h] as const) : null)),
    ];
  });
  const [result, hostedResolved] = await Promise.all([
    panoramaSanteTerritoire(input),
    Promise.all(hostedPromises),
  ]);
  const hostedEntries = hostedResolved.filter(
    (e): e is readonly [FinessFamilleQuery, HostedActivityResult] => e !== null,
  );
  const perimetre = finessVoletDesactive
    ? RPPS_PERIMETRE
    : finessFamillePerimetre(famillesEffectives);
  const withPerim = withPerimetre(result, perimetre);
  return hostedEntries.length > 0
    ? {
        ...withPerim,
        activites_hebergees_par_famille: Object.fromEntries(hostedEntries) as Record<
          string,
          HostedActivityResult
        >,
      }
    : withPerim;
},
```

- [ ] **Step 6.4 — Run les tests panorama**

```bash
pnpm exec vitest run api/tools-v019.test.ts -t panorama
```

Expected: tous PASS.

- [ ] **Step 6.5 — Non-régression `api/tools.test.ts`**

```bash
pnpm exec vitest run api/tools.test.ts -t panorama
```

Expected: PASS.

- [ ] **Step 6.6 — Typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

---

## Task 7 : Câblage `densite_professionnels_sante`

**Files:**
- Modify: `api/tools.ts:2050-2128` (inputSchema + handler)
- Modify: `api/tools-v019.test.ts` (append nouveau `describe`)

- [ ] **Step 7.1 — Append tests V0.19**

```typescript
describe("V0.19.0 — densite_professionnels_sante + nom_commune", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("nom_commune seul → résolu, passé en codeInsee", async () => {
    vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: { code: "59350", nom: "Lille", codesPostaux: [], codeDepartement: "59" } as never,
    });
    const densiteSpy = vi.spyOn(densiteMod, "densiteProfessionnelsSante").mockResolvedValueOnce({} as never);
    const tool = findTool("densite_professionnels_sante");
    await tool?.handler({ nom_commune: "Lille" });
    expect(densiteSpy).toHaveBeenCalledWith(expect.objectContaining({ codeInsee: "59350" }));
    expect(densiteSpy.mock.calls[0]?.[0].departement).toBeUndefined();
  });

  it("nom_commune + code_dept (hint) → code_dept consommé, codeInsee retourné, dept NON réinjecté", async () => {
    const resolveSpy = vi.spyOn(resolveModule, "resolveNomCommune").mockResolvedValueOnce({
      resolved: true,
      commune: { code: "65392", nom: "Saint-Martin", codesPostaux: [], codeDepartement: "65" } as never,
    });
    const densiteSpy = vi.spyOn(densiteMod, "densiteProfessionnelsSante").mockResolvedValueOnce({} as never);
    const tool = findTool("densite_professionnels_sante");
    await tool?.handler({ nom_commune: "Saint-Martin", code_dept: "65" });
    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({ departement: "65" }));
    expect(densiteSpy).toHaveBeenCalledWith(expect.objectContaining({ codeInsee: "65392" }));
    expect(densiteSpy.mock.calls[0]?.[0].departement).toBeUndefined();
  });

  it("rétro-compat : code_dept seul = scope dept", async () => {
    const densiteSpy = vi.spyOn(densiteMod, "densiteProfessionnelsSante").mockResolvedValueOnce({} as never);
    const tool = findTool("densite_professionnels_sante");
    await tool?.handler({ code_dept: "59" });
    expect(densiteSpy).toHaveBeenCalledWith(expect.objectContaining({ departement: "59" }));
    expect(densiteSpy.mock.calls[0]?.[0].codeInsee).toBeUndefined();
  });

  it("rétro-compat : code_insee seul = scope commune", async () => {
    const densiteSpy = vi.spyOn(densiteMod, "densiteProfessionnelsSante").mockResolvedValueOnce({} as never);
    const tool = findTool("densite_professionnels_sante");
    await tool?.handler({ code_insee: "59350" });
    expect(densiteSpy).toHaveBeenCalledWith(expect.objectContaining({ codeInsee: "59350" }));
  });

  it("XOR : nom_commune + code_insee → RangeError redondant", async () => {
    const tool = findTool("densite_professionnels_sante");
    await expect(tool?.handler({ nom_commune: "Lille", code_insee: "59350" })).rejects.toThrow(
      /redondants|SOIT/i,
    );
  });
});
```

Ajouter en haut de `api/tools-v019.test.ts` :

```typescript
import * as densiteMod from "../src/sante/densite.js";
```

- [ ] **Step 7.2 — Run, vérifier qu'ils échouent**

```bash
pnpm exec vitest run api/tools-v019.test.ts -t densite_professionnels
```

Expected: FAIL.

- [ ] **Step 7.3 — Patcher le handler `densite_professionnels_sante`**

Dans `api/tools.ts:2050-2128`, modifier :

**A. Ajouter `nom_commune` à `inputSchema.properties`** (après `code_insee` ~ligne 2061) :

```typescript
nom_commune: {
  type: "string",
  description: "Nom officiel de commune (alternative à `code_insee`, V0.19). Ex: \"Lille\", \"Villeneuve-d'Ascq\". Combinable avec `code_dept` qui agit alors comme hint de désambiguïsation pour homonymes (ex \"Saint-Martin\" + dept \"65\"). XOR avec `code_insee` (paramètres redondants).",
},
```

**B. Étendre la description du tool** :

Modifier le paragraphe Paris/Marseille/Lyon (~ligne 2052) pour ajouter une mention de la sémantique conditionnelle :

```
V0.19.0 : accepte `nom_commune` (alternative à `code_insee`). Sémantique conditionnelle de `code_dept` — seul = scope département entier (comme avant) ; combiné avec `nom_commune` = hint de résolution (filtre les communes homonymes), le calcul reste sur la commune résolue.
```

**C. Patcher le handler** (~ligne 2090-2128) :

```typescript
handler: async (rawArgs) => {
  const args = normalizeAliases(rawArgs, {
    dept: "code_dept",
    departement: "code_dept",
    codeInsee: "code_insee",
    insee: "code_insee",
  });
  // V0.9 : requireOneOf devient une garde plus large (nom_commune ou code_insee ou code_dept)
  // Le requireOneOf historique attendait ["code_dept", "code_insee"]. On l'étend à nom_commune.
  // Mais comme applyCommuneResolver throw si rien fourni ET requireScope:true,
  // ici on laisse résolveZone (lib) throw — donc requireScope: false.
  // Mais alors un appel vide ne throw pas avant resolveZone... resolveZone exige UN scope.
  // Pour préserver le wording d'erreur historique ("Attendu: code_dept ou code_insee"),
  // on garde requireOneOf en pré-check.
  requireOneOf(args, ["code_dept", "code_insee", "nom_commune"], { code_dept: "59" });

  const codeDept = asString(args.code_dept);
  const codeInsee = asString(args.code_insee);
  const nomCommune = asString(args.nom_commune);

  // V0.19.0 — résolution boundary
  const resolved = await applyCommuneResolver({
    nomCommune,
    codeInsee,
    departement: codeDept,
    acceptsDepartementAsScope: true,
    requireScope: false, // requireOneOf au-dessus + resolveZone côté lib
  });

  const input: Parameters<typeof densiteProfessionnelsSante>[0] = {
    categorieCodes: categorieCodesFromArgs(args),
  };
  if (resolved.departement) input.departement = resolved.departement;
  if (resolved.codeInsee) input.codeInsee = resolved.codeInsee;

  const professionCode = asString(args.profession_code);
  if (professionCode) input.professionCode = professionCode;
  const savoirFaireCode = asString(args.savoir_faire_code);
  if (savoirFaireCode) input.savoirFaireCode = savoirFaireCode;
  if (Array.isArray(args.mode_exercice_codes)) {
    const filtered = args.mode_exercice_codes.filter((v): v is string => typeof v === "string");
    if (filtered.length === 0) {
      console.warn(
        `[france-data-mcp] densite_professionnels_sante: mode_exercice_codes vide reçu — interprété comme 'pas de filtre' (tous statuts), pas la méthodo DREES par défaut`,
      );
      input.modeExerciceCodes = null;
    } else {
      input.modeExerciceCodes = filtered;
    }
  }
  const compareNational = coerceBoolean(args.compare_national, "compare_national");
  if (compareNational === true) input.compareNational = true;
  const result = await densiteProfessionnelsSante(input);
  return withPerimetre(result, RPPS_PERIMETRE);
},
```

- [ ] **Step 7.4 — Run les tests densite**

```bash
pnpm exec vitest run api/tools-v019.test.ts -t densite_professionnels
```

Expected: PASS.

- [ ] **Step 7.5 — Non-régression densite**

```bash
pnpm exec vitest run api/tools-v09.test.ts api/tools.test.ts -t densite_professionnels
```

Expected: PASS. Adapter les tests V0.9 qui testaient le wording exact de `requireOneOf` (le wording change avec l'ajout de `nom_commune` à la liste).

Wording attendu désormais : `Attendu: "code_dept" ou "code_insee" ou "nom_commune".`

- [ ] **Step 7.6 — Typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: no errors.

---

## Task 8 : Discipline post-fix sur tout le diff

**Objectif :** vérifier que TOUT le code écrit dans Tasks 1-7 respecte la qualité projet AVANT le commit principal.

- [ ] **Step 8.1 — `pnpm typecheck && pnpm lint && pnpm test:unit` — tout vert**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

Expected: `0 errors`, tous les tests unitaires PASS.

- [ ] **Step 8.2 — `/simplify` (3 agents en parallèle : reuse / quality / efficiency)**

Lancer le slash command `/simplify` (skill standalone, 3 agents en parallèle qui scannent le diff vs main).

Corriger TOUS les findings remontés (utilities ratées, anti-patterns, hot-path bloat, redundant state). Appliquer les corrections inline. Si conflits entre agents, prioriser celui de quality > efficiency > reuse.

- [ ] **Step 8.3 — `/review` Passe 1 (3 agents : code-reviewer + silent-failure-hunter + code-simplifier)**

Lancer `/review`. Corriger TOUT ce qui remonte, **y compris hors scope** (CLAUDE.md). Pas de TODO en commentaire — chaque finding est soit corrigé soit explicitement justifié (commit message).

- [ ] **Step 8.4 — `/review` Passe 2 (2 agents : code-reviewer + silent-failure-hunter)**

Lancer `/review`. `code-simplifier` n'est PAS rejoué (déjà fait en Passe 1). Si nouveaux findings → fix → ré-exécuter Passe 2 jusqu'à 0 critical/high.

- [ ] **Step 8.5 — `pnpm typecheck && pnpm lint && pnpm test:unit` final**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

Expected: tout vert. Si une correction de discipline a cassé un test, le réparer maintenant.

---

## Task 9 : Documentation AVANT commit

**Files:**
- Modify: `CHANGELOG.md` (section V0.19.0 en haut)
- Modify: `CLAUDE.md` (projet — convention applyCommuneResolver)
- Modify: `docs/backlog.md` (entry V0.20)

- [ ] **Step 9.1 — `CHANGELOG.md` — section V0.19.0**

Insérer en haut du `CHANGELOG.md` :

```markdown
## V0.19.0 — 2026-05-23

### Geo Intel friendly — paramètre `nom_commune`

Sur **3 tools MCP**, ajout d'un paramètre `nom_commune` (string) accepté comme alternative à `code_insee` :

- `etablissements_finess_by_categorie`
- `panorama_sante_territoire`
- `densite_professionnels_sante`

Le serveur résout en interne via `geo.api.gouv.fr` (DINUM, même source que `autocomplete_commune`). Économie consommateur : **2 round-trips MCP → 1** (~5s par appel commune).

**Sémantique :**
- `nom_commune` seul (unique) → résout silencieusement vers le `code_insee` correspondant.
- `nom_commune` ambigu (ex "Saint-Martin" → 5 communes) → erreur structurée JSON-RPC `error.data.kind = "ambiguous_commune"` avec `candidates` (top 10 par population décroissante) + flag `truncated`.
- `nom_commune` + `departement`/`code_dept` → le département agit comme **hint de désambiguïsation** (filtre les candidats), pas comme scope de calcul. Si cohérent (1 match) → résout silencieusement. Si incohérent (0 match dans dept mais N ailleurs) → erreur structurée `commune_not_in_department`.
- `nom_commune` + `code_insee` → erreur `redundant_commune_params` (XOR strict).
- Abréviations type `St-Martin` / `St Martin` non reconnues (l'API geo.api.gouv.fr ne les normalise pas) — l'erreur `unknown_commune` retourne un `hint` pédagogique.

**Erreurs structurées propagées** via `RangeError(msg, { cause })` → JSON-RPC `error.data` (patch `api/mcp.ts:384-393`). Le caller MCP peut désormais distinguer 4 types d'erreurs `code_insee` programmiquement.

### Cassures mineures

- **`etablissements_finess_by_categorie`** : introduction du **XOR strict** entre `departement`, `code_insee`, `nom_commune`. Avant : `departement + code_insee` étaient AND-és silencieusement (le RPC `finess_by_categorie` les recevait comme filtres simultanés). Désormais : erreur explicite `redundant_commune_params`. Aligne le contrat avec `densite_professionnels_sante` (V0.9). Aucun caller documenté ne dépendait du comportement AND.

- **`panorama_sante_territoire`** : `code_insee` n'est plus `required` au schema (la validation passe au handler via `applyCommuneResolver({requireScope: true})`). Le caller qui n'envoie ni `code_insee` ni `nom_commune` reçoit désormais `Scope requis : passer code_insee (5 chiffres) ou nom_commune (nom officiel).` au lieu de l'erreur de validation JSON Schema. Sémantique fonctionnelle identique.

### Architecture interne

- Nouveau helper boundary partagé `api/_lib/apply-commune-resolver.ts` (XOR + format erreurs).
- Nouveau helper sous-jacent `api/_lib/resolve-commune.ts` (résolution + match exact normalisé NFD + filtre dept natif geo.api.gouv.fr).
- Extension lib `src/territoire/communes.ts` : `SearchCommunesOptions.codeDepartement` (param natif transmis à l'API).

### Documentation

- Design source : `docs/plans/nom-commune-resolver-v019.md` + `.html`
- Plan d'implé : `docs/plans/nom-commune-resolver-v019-plan.md`

### Backlog déplacé en V0.20

- Extension `densite_etablissements_sante` au niveau commune (requiert un nouveau RPC SQL `count_finess_by_commune` + métadata population + gestion PLM). Non bloquant pour V0.19.
```

- [ ] **Step 9.2 — `CLAUDE.md` (projet) — convention `applyCommuneResolver`**

Dans la section "Conventions code → Endpoint (`api/`) — Sentry + observabilité" de `CLAUDE.md`, ajouter un nouveau bullet :

```markdown
- **Résolution `nom_commune` → `code_insee` au boundary via `applyCommuneResolver`**
  (V0.19) : tout tool MCP qui accepte un scope commune DOIT utiliser
  `api/_lib/apply-commune-resolver.ts` plutôt que de réinventer la résolution.
  Sémantique fixée : `nom_commune` + `departement` = `departement` est un
  **hint resolver** (filtre côté `geo.api.gouv.fr`), JAMAIS un scope de calcul
  (le tool reçoit uniquement `{ codeInsee }`). Pour `densite_professionnels_sante`,
  `code_dept` a une sémantique **conditionnelle** : seul = scope dept entier ;
  combiné avec `nom_commune` = hint resolver. Documentée explicitement dans la
  `description` du tool (LLM-facing doc). Les erreurs sont propagées via
  `RangeError(msg, { cause: ResolveCommuneError })` qui voyagent jusqu'à
  `error.data` du JSON-RPC (patch `api/mcp.ts:384-393` propage `err.cause` au
  4ème arg de `error()` — test garde-fou `api/mcp-handler-error-cause.test.ts`).
  Source de vérité du contrat : `docs/plans/nom-commune-resolver-v019.md`.
```

- [ ] **Step 9.3 — `docs/backlog.md` — entry V0.20**

Ajouter un entry dans `docs/backlog.md` (gitignored mais lu pour planning) :

```markdown
## V0.20 — Extension `densite_etablissements_sante` au niveau commune

**Contexte :** lors du chantier V0.19.0 (`nom_commune` resolver), le tool `densite_etablissements_sante` a été exclu du scope car il ne sait calculer qu'au niveau département (`required: ["code_dept", "famille"]`). Pour aligner les 4 tools de scope commune, ce ticket couvre l'extension.

**Travail requis :**
1. Nouveau RPC SQL `count_finess_by_commune(p_code_insee, p_codes finess_family_code[])` + index par commune si nécessaire
2. Récupération population commune via INSEE Melodi (déjà fait pour `densite_professionnels_sante` — réutiliser le pattern)
3. Gestion PLM (Paris/Marseille/Lyon) : appliquer la même règle que `densite_professionnels_sante` (rejet code commune-mère + arrondissements, RangeError explicite)
4. Câblage `applyCommuneResolver({acceptsDepartementAsScope: true, requireScope: false})` (même pattern que `densite_professionnels_sante`)
5. Tests boundary + unitaires lib
6. Mise à jour description tool (mention sémantique conditionnelle `code_dept`)
7. Mise à jour `CHANGELOG.md` V0.20.0

**Effort estimé :** ~6h (incl. nouvelle migration SQL, tests SQL, discipline post-fix).

**Bloque rien** — feature additive, rétrocompat totale.

**Référence design parent :** `docs/plans/nom-commune-resolver-v019.md` §2 décision 1.
```

- [ ] **Step 9.4 — Vérifier que rien d'autre n'a besoin de doc**

```bash
grep -rn "nom_commune\|applyCommuneResolver\|resolveNomCommune" README.md docs/ 2>/dev/null | grep -v "nom-commune-resolver-v019" | head -20
```

Si des références remontent dans `README.md` ou ailleurs (publicly-facing), enrichir le copy avec mention V0.19.

---

## Task 10 : Bump version + commit principal

**Files:**
- Modify: `package.json`
- Modify: `server.json`
- Modify: `src/core/version.ts`

- [ ] **Step 10.1 — Bump `package.json` 0.18.0 → 0.19.0**

```bash
# Vérifier la version actuelle
grep '"version":' package.json
```

Editer `package.json` : `"version": "0.18.0"` → `"version": "0.19.0"`.

- [ ] **Step 10.2 — Bump `server.json`**

```bash
grep -i version server.json
```

Mettre à jour le champ version : `0.18.0` → `0.19.0`.

- [ ] **Step 10.3 — Bump `src/core/version.ts`**

```bash
cat src/core/version.ts
```

Mettre à jour la constante exportée : `0.18.0` → `0.19.0`.

- [ ] **Step 10.4 — Run tous les tests une dernière fois (pré-commit)**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

Expected: tout vert.

- [ ] **Step 10.5 — Commit principal feat: + docs:**

```bash
git status --short
```

Vérifier qu'on a bien :
- `M  CHANGELOG.md`
- `M  CLAUDE.md`
- `M  api/mcp.ts`
- `M  api/tools.ts`
- `M  package.json`
- `M  server.json`
- `M  src/core/version.ts`
- `M  src/territoire/communes.ts`
- `M  src/territoire/communes.test.ts`
- `M  docs/backlog.md` (gitignored — vérifier `.gitignore`)
- `A  api/_lib/apply-commune-resolver.ts`
- `A  api/_lib/apply-commune-resolver.test.ts`
- `A  api/_lib/resolve-commune.ts`
- `A  api/_lib/resolve-commune.test.ts`
- `A  api/mcp-handler-error-cause.test.ts`
- `A  api/tools-v019.test.ts`

Commit en 3 commits atomiques :

```bash
# Commit 1 : feat principal (code + tests)
git add api/_lib/resolve-commune.ts api/_lib/resolve-commune.test.ts \
        api/_lib/apply-commune-resolver.ts api/_lib/apply-commune-resolver.test.ts \
        api/mcp.ts api/mcp-handler-error-cause.test.ts \
        api/tools.ts api/tools-v019.test.ts \
        src/territoire/communes.ts src/territoire/communes.test.ts
git commit -m "$(cat <<'EOF'
feat(v019): nom_commune resolver sur 3 tools MCP

Ajoute le paramètre `nom_commune` (string) sur etablissements_finess_by_categorie,
panorama_sante_territoire, densite_professionnels_sante en alternative à
`code_insee`. Le serveur résout via geo.api.gouv.fr (DINUM, même source que
autocomplete_commune). Geo Intel économise 1 round-trip MCP (~5s/appel).

Sémantique :
- `nom_commune` + `departement` = dept agit comme HINT resolver (filtre les
  homonymes type Saint-Martin), PAS comme scope de calcul.
- Erreurs structurées via JSON-RPC error.data : ambiguous_commune,
  commune_not_in_department, unknown_commune, redundant_commune_params.
- XOR strict introduit dans by_categorie au passage (cohérence V0.9 densités).

Architecture : 2 helpers boundary partagés (api/_lib/apply-commune-resolver.ts
+ api/_lib/resolve-commune.ts) + extension SearchCommunesOptions.codeDepartement
+ patch api/mcp.ts (propagation err.cause au 4ème arg de error()).

Aucune migration DB, aucune nouvelle dépendance. Rétro-compat totale code_insee
+ departement. Test garde-fou api/mcp-handler-error-cause.test.ts contre
régression silencieuse de la propagation cause.

Source design : docs/plans/nom-commune-resolver-v019.md (commit f96f01e).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

```bash
# Commit 2 : docs (CHANGELOG + CLAUDE.md)
git add CHANGELOG.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(v019): CHANGELOG + CLAUDE.md convention applyCommuneResolver

Documente la nouvelle convention boundary applyCommuneResolver dans CLAUDE.md
(section Endpoint api/). Documente les cassures mineures non breaking dans le
CHANGELOG V0.19.0 (XOR strict by_categorie, panorama required: [] avec
validation déplacée au handler).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

```bash
# Commit 3 : bump version
git add package.json server.json src/core/version.ts
git commit -m "$(cat <<'EOF'
chore(release): 0.19.0

Bump package.json + server.json + src/core/version.ts vers 0.19.0.

Reste à faire (maintainer-only OTP) :
- git tag -a v0.19.0 + git push --follow-tags
- pnpm publish --no-git-checks (npm 2FA OTP)
- mcp-publisher login github + mcp-publisher publish
- gh release view v0.19.0 (auto-créé par release.yml sur push tag)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 10.6 — Vérifier les 3 commits**

```bash
git log --oneline -5
```

Expected: 3 nouveaux commits en haut (feat + docs + chore).

---

## Task 11 : Tag + push + vérif CI + STOP (maintainer prend la main)

- [ ] **Step 11.1 — Tag annoté**

```bash
git tag -a v0.19.0 -m "V0.19.0 — nom_commune resolver (Geo Intel friendly)

Sur 3 tools MCP (by_categorie, panorama, densite_professionnels), accepte
nom_commune en alternative à code_insee. Résolution via geo.api.gouv.fr.
Économie consommateur Geo Intel : 2 round-trips MCP → 1 (~5s/appel).

Voir CHANGELOG.md + docs/plans/nom-commune-resolver-v019.md"
```

- [ ] **Step 11.2 — Push code + tag**

```bash
git push origin main && git push origin v0.19.0
```

Expected: push OK, GitHub Release auto-créée par `.github/workflows/release.yml` sur push du tag.

- [ ] **Step 11.3 — Attendre CI**

```bash
gh run watch --exit-status
```

Expected: tous les checks PASS (typecheck × 2 tsconfigs + biome + tests + Supabase local).

- [ ] **Step 11.4 — Vérifier `/healthz` Vercel**

```bash
sleep 30 # laisse Vercel deployer
curl -s https://france-data-mcp.vercel.app/healthz | python3 -m json.tool
```

Expected: `"version": "0.19.0"` dans la réponse.

- [ ] **Step 11.5 — STOP : Cyril prend la main**

Le code est mergé sur main, déployé sur Vercel, tag créé, GitHub Release publiée. Restent les 2 publishes maintainer-only (qui requièrent l'OTP de Cyril) :

1. **npm publish** (terminal Cyril) :
   ```bash
   pnpm build && pnpm publish --no-git-checks  # OTP 2FA prompt
   ```

2. **MCP Registry publish** (terminal Cyril) :
   ```bash
   mcp-publisher login github  # device code GitHub OAuth
   mcp-publisher publish
   ```

3. **Vérifications post-publish** :
   ```bash
   npm view france-data-mcp version  # → 0.19.0
   gh release view v0.19.0           # auto-créée par release.yml
   curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=france-data-mcp' \
     | jq -r '[.servers[]|select(.server.name=="io.github.cturkieh/france-data-mcp")] \
       |sort_by(._meta."io.modelcontextprotocol.registry/official".updatedAt)|last|.server.version'
   ```

Récap pour Cyril à son retour :
- ✅ Spec doc commitée (`f96f01e`)
- ✅ Code V0.19.0 mergé sur main (3 commits feat/docs/chore)
- ✅ Tag `v0.19.0` poussé + GitHub Release auto-créée
- ✅ Vercel déployé, `/healthz` confirme 0.19.0
- ⏳ npm publish + mcp-publisher publish (OTP 2FA → maintainer-only)
- ⏳ Mémoires à jour : `~/.claude/projects/-Users-cyrilturkiehpa-Developer-france-data-mcp/memory/v019-shipped.md`

---

## Self-Review du plan

**1. Spec coverage :** chaque section du spec `nom-commune-resolver-v019.md` est-elle implémentée ?

- §2 décision 1 (3 tools scope) → Tasks 5, 6, 7 ✅
- §2 décision 2 (helper partagé) → Tasks 2, 3 ✅
- §2 décision 3 (dept désambigue) → Task 2 step 2.1 cas 3 + 4 ✅
- §2 décision 4 (match exact) → Task 2 step 2.3 (normalizeName) ✅
- §2 décision 5 (RangeError({cause}) → error.data) → Task 4 ✅
- §2 décision 6 (cap top 10 par pop) → Task 2 step 2.1 cas 9 ✅
- §2 décision 7 (XOR strict by_categorie) → Task 5 step 5.1 + 5.3 ✅
- §3 architecture helper → Task 2 step 2.3 ✅
- §4 câblage 3 tools → Tasks 5, 6, 7 ✅
- §5 forme erreurs JSON-RPC → Task 3 step 3.3 (formatResolveError) ✅
- §6 tests garde-fous → Tasks 2.1, 3.1, 4.1, 5.1, 6.1, 7.1 ✅
- §7 snippets clés → reflétés dans les tâches d'implé ✅
- §8 périmètre exclu → Task 9.3 (entry backlog V0.20) ✅
- §9 risques → mitigations dans les tests garde-fous et la doc CHANGELOG ✅
- §10 plan exécution → mappé aux Tasks 1-11 ✅
- §11 annexes → restent dans le spec, pas dans le plan ✅

**2. Placeholder scan :** aucun "TBD", "TODO", "à compléter" dans le plan ?

```bash
grep -n "TBD\|TODO\|à compléter\|à définir\|XXX" docs/plans/nom-commune-resolver-v019-plan.md | head
```

→ aucun TBD trouvé dans le plan (tests data XXXINEXISTANT n'est pas un TBD).

**3. Type consistency :** signatures cohérentes entre tasks ?

- `ResolveCommuneResult` défini Task 2.3, consommé Task 3.3 ✅
- `CommuneResolverArgs` défini Task 3.3 (5 champs : nomCommune, codeInsee, departement, acceptsDepartementAsScope, requireScope), tous les appels Tasks 5/6/7 passent les 5 ✅
- `applyCommuneResolver` retourne `{ codeInsee?, departement? }`, les 3 tools consomment via `if (resolved.codeInsee)` et `if (resolved.departement)` ✅
- `searchCommunes` accepte `codeDepartement` (Task 1), consommé dans Task 2.3 ✅

**4. Risques d'oubli :**

- Le hook pre-commit-discipline pourrait throw si on commit sans la chaîne complète. Documenté : on lance la discipline en Task 8 avant le commit principal (Task 10).
- L'import `applyCommuneResolver` doit être ajouté en haut de `api/tools.ts` (mentionné Task 5.3 D).
- La version dans `src/core/version.ts` doit être vérifiée (format exact `0.19.0` sans préfixe `v`).
- `docs/backlog.md` est gitignored — Task 9.3 modifie sans tenter de commit (l'ajout est local mais persiste pour Cyril).

---

## Execution Handoff

**Plan complete et sauvegardé à `docs/plans/nom-commune-resolver-v019-plan.md`.**

**Cyril a délégué l'exécution autonome ("je te laisse terminer, démarre quand tu as la solution la plus robuste, élégante et simple").**

J'enchaîne avec **subagent-driven-development** pour exécuter le plan task-par-task avec subagents frais (mode parallèle où indépendant). Justifications :

1. Tasks 1-4 (extension lib + helpers + patch mcp) sont **indépendantes** (pas de dépendances croisées) → parallélisables
2. Tasks 5-7 (câblage des 3 tools) sont **indépendantes entre elles** (chaque tool est isolé) → parallélisables après 1-4
3. Tasks 8-11 (discipline + doc + commit + push) sont **séquentielles** (need tout le diff complet)

Démarrage immédiat — pas de validation utilisateur intermédiaire (mode délégué).
