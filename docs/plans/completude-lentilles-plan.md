# Plan d'implémentation — Complétude territoriale & lentilles de source

> **Pour les workers agentiques :** SOUS-SKILL REQUIS — utiliser
> `superpowers:subagent-driven-development` (recommandé) ou
> `superpowers:executing-plans` pour exécuter ce plan tâche par tâche. Les
> étapes utilisent la syntaxe checkbox (`- [ ]`).

**Goal :** Rendre les tools de comptage du MCP honnêtes sur leur « lentille »
de source (Phase 1, shippable), puis mesurer le signal d'enrichissement RPPS
pour débloquer la Phase 2.

**Architecture :** Phase 1 — un module lib `src/sante/perimetre.ts` déclare la
lentille de chaque source ; un wrapper `withPerimetre` (boundary `api/tools.ts`,
jumeau de `withFreshness` existant) injecte ce descripteur dans la sortie des
tools de comptage, sans modifier la couche lib. La dérive du catalogue FINESS
est corrigée (5 codes vivants non catalogués). Phase 2 — une tâche de mesure
prod calibre le seuil du signal `num_finess` et produit un rapport go/no-go.

**Tech Stack :** TypeScript strict, Vitest, Biome, Supabase PostGIS (RPC), MCP
tools registry (`api/tools.ts`).

**Réf cadrage :** `docs/plans/completude-lentilles-sources.md` (+ `.html`).

---

## Périmètre de CE plan

- **Tâches 1–7 = Phase 1 complète, shippable** → release V0.17.0.
- **Tâche 8 = Phase 2, mesure de calibrage uniquement** → produit un rapport.
  L'**implémentation de la couche d'activités Phase 2 fera l'objet d'un plan
  séparé**, écrit une fois le rapport de la Tâche 8 disponible : ses seuils et
  sa liste d'activités exposées dépendent littéralement des chiffres mesurés
  (doctrine `prove-rootcause-by-prod` — pas de code sur des seuils inférés).

## File Structure

| Fichier | Rôle | Action |
|---|---|---|
| `src/sante/finess-categories.ts` | Catalogue catégories + familles FINESS | Modifier — +5 codes |
| `src/sante/finess-categories.test.ts` | Tests du classifieur de familles | Modifier — +assertions |
| `src/sante/perimetre.ts` | Descripteurs de lentille par source | **Créer** |
| `src/sante/perimetre.test.ts` | Tests des descripteurs | **Créer** |
| `api/tools.ts` | Registre des tools MCP + handlers | Modifier — `withPerimetre` + câblage + descriptions |
| `api/tools.test.ts` *(ou équivalent)* | Test de câblage d'un tool | Modifier/créer |
| `CHANGELOG.md` · `CLAUDE.md` · `README.md` | Docs | Modifier |
| `package.json` · `server.json` · `src/core/version.ts` | Version | Modifier — 0.16.0 → 0.17.0 |
| `docs/plans/completude-lentilles-phase2-mesure.md` | Rapport de mesure Phase 2 | **Créer** (Tâche 8) |

**Note d'architecture — pas d'envelope partagé.** Chaque tool de `api/tools.ts`
construit sa réponse indépendamment (vérifié : `FinessQueryResult`,
`CoverageResult`, `DensiteProfessionnelsSanteResult`… sont des types distincts,
aucun wrapper commun). La métadonnée `perimetre` est donc injectée au **boundary
handler**, exactement comme le wrapper `withFreshness` existant — la couche lib
(`src/sante/*-db.ts`) n'est pas touchée. Précédent dans le code : le champ
structuré `geo_precision` porté par résultat (`RPPS_GEO_PRECISION_HINT`).

---

## Task 1 : Corriger la dérive du catalogue FINESS

**Files:**
- Modify: `src/sante/finess-categories.ts`
- Test: `src/sante/finess-categories.test.ts`

Contexte : 5 codes catégorie sont vivants en prod (mesuré 2026-05-22) mais
absents de `FINESS_CATEGORIES` → ils tombent en famille `autre`. `610`+`612`
sont des labos (55 établissements ratés par `famille=labo`), `628`+`629` des
pharmacies (77 ratées), `695` un groupement. Le test invariant existant
(`every FINESS_CATEGORIES code has an explicit family decision`) **forcera** la
classification : ajouter un code sans le ranger dans une famille fait échouer CI.

- [ ] **Step 1 : Écrire les assertions de test (échec attendu)**

Dans `src/sante/finess-categories.test.ts`, remplacer le `it` existant
`"maps labo / pharmacie / imagerie to dedicated families"` (lignes ~137-141) par :

```typescript
  it("maps labo / pharmacie / imagerie to dedicated families", () => {
    expect(finessFamille("610")).toBe("labo"); // Laboratoire d'Analyses
    expect(finessFamille("611")).toBe("labo");
    expect(finessFamille("612")).toBe("labo"); // Autre LBM sans FSE
    expect(finessFamille("619")).toBe("imagerie");
    expect(finessFamille("620")).toBe("pharmacie");
  });
```

Remplacer le `it` `"maps pharmacie famille incl. propharmacies"` (lignes ~132-135) par :

```typescript
  it("maps pharmacie famille incl. propharmacies, minière, mutualiste", () => {
    expect(finessFamille("620")).toBe("pharmacie"); // Officine
    expect(finessFamille("627")).toBe("pharmacie"); // Propharmacie
    expect(finessFamille("628")).toBe("pharmacie"); // Pharmacie Minière
    expect(finessFamille("629")).toBe("pharmacie"); // Pharmacie Mutualiste
  });
```

Remplacer le `it` `"maps groupements GCS — but NOT 698..."` (lignes ~118-124) par :

```typescript
  it("maps groupements GCS (695/696/697) — but NOT 698 (fourre-tout)", () => {
    expect(finessFamille("695")).toBe("groupement"); // GCS de moyens - Exploitant
    expect(finessFamille("696")).toBe("groupement"); // GCS de moyens
    expect(finessFamille("697")).toBe("groupement"); // GCS — Etab de santé
    // 698 = "Autre Etablissement Loi Hospitalière" — explicitement PAS un
    // groupement de coopération malgré une mauvaise classif early-v0.3.
    expect(finessFamille("698")).toBe("autre");
  });
```

- [ ] **Step 2 : Lancer les tests — vérifier l'échec**

Run: `pnpm vitest run src/sante/finess-categories.test.ts`
Expected: FAIL — `finessFamille("610")` retourne `"autre"` au lieu de `"labo"`, etc.

- [ ] **Step 3 : Ajouter les 5 codes à `FINESS_CATEGORIES`**

Dans `src/sante/finess-categories.ts`, section `// ─── PHARMACIE / BIO / IMAGERIE`
(lignes ~46-51), remplacer le bloc par :

```typescript
  // ─── PHARMACIE / BIO / IMAGERIE ───────────────────────────────────────
  "610": "Laboratoire d'Analyses",
  "611": "Laboratoire de Biologie Médicale",
  "612": "Autre Laboratoire de Biologie Médicale sans FSE",
  "619": "Cabinet d'imagerie médicale",
  "620": "Pharmacie d'Officine",
  "627": "Propharmacie",
  "628": "Pharmacie Minière",
  "629": "Pharmacie Mutualiste",
```

Section `// ─── GROUPEMENTS` (lignes ~136-138), remplacer par :

```typescript
  // ─── GROUPEMENTS ──────────────────────────────────────────────────────
  "695": "Groupement de coopération sanitaire de moyens - Exploitant",
  "696": "Groupement de coopération sanitaire de moyens",
  "697": "Groupement de coopération sanitaire — Etablissement de santé",
```

- [ ] **Step 4 : Ranger les 5 codes dans `FINESS_FAMILY_CODES`**

Dans le même fichier, objet `FINESS_FAMILY_CODES` (lignes ~211-248), modifier
les 3 lignes concernées :

```typescript
  // Bio / pharma / imagerie
  labo: ["610", "611", "612"],
  imagerie: ["619"],
  pharmacie: ["620", "627", "628", "629"],
```

```typescript
  // Groupements
  groupement: ["695", "696", "697"],
```

- [ ] **Step 5 : Lancer les tests — vérifier le succès**

Run: `pnpm vitest run src/sante/finess-categories.test.ts`
Expected: PASS — y compris l'invariant `every FINESS_CATEGORIES code has an
explicit family decision` (les 5 nouveaux codes sont classés, aucun ne tombe
en `autre`).

- [ ] **Step 6 : Typecheck**

Run: `pnpm typecheck`
Expected: PASS — `FinessCategorieCode` (union dérivée des clés) intègre les 5
codes ; `FINESS_FAMILY_CODES` reste `satisfies Record<FinessFamilleQuery, ...>`.

- [ ] **Step 7 : Commit**

```bash
git add src/sante/finess-categories.ts src/sante/finess-categories.test.ts
git commit -m "fix(finess): catalogue 5 codes vivants non répertoriés (610/612/628/629/695)

610 Laboratoire d'Analyses + 612 Autre LBM → famille labo (55 labos
autonomes auparavant ratés). 628 Pharmacie Minière + 629 Pharmacie
Mutualiste → pharmacie (77). 695 GCS Exploitant → groupement. Codes
mesurés vivants en prod 2026-05-22, absents du catalogue = tombaient en
'autre'. Réf cadrage docs/plans/completude-lentilles-sources.md §3.2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 : Module `perimetre.ts` — descripteurs de lentille

**Files:**
- Create: `src/sante/perimetre.ts`
- Test: `src/sante/perimetre.test.ts`

Contexte : module lib pur (pas de Sentry, OSS-publishable). Déclare la lentille
de chaque source. Le type `Perimetre` voyagera dans la sortie des tools.

- [ ] **Step 1 : Écrire le test (échec attendu)**

Créer `src/sante/perimetre.test.ts` :

```typescript
import { describe, expect, it } from "vitest";
import { AMELI_PERIMETRE, RPPS_PERIMETRE, finessFamillePerimetre } from "./perimetre";

describe("finessFamillePerimetre", () => {
  it("sans famille → lentille catégorie dominante, périmètre 'tous'", () => {
    const p = finessFamillePerimetre(undefined);
    expect(p.source).toMatch(/FINESS/);
    expect(p.lens).toBe("categorie_dominante");
    expect(p.compte).toMatch(/tous/i);
    expect(p.completeness_note.length).toBeGreaterThan(0);
  });

  it("famille labo → rider sur les plateaux hospitaliers", () => {
    const p = finessFamillePerimetre(["labo"]);
    expect(p.compte).toContain("labo");
    expect(p.completeness_note).toMatch(/hospitali/i);
  });

  it("famille imagerie → rider sur l'absence de cabinets en FINESS", () => {
    const p = finessFamillePerimetre(["imagerie"]);
    expect(p.completeness_note).toMatch(/imagerie/i);
  });

  it("plusieurs familles → riders cumulés", () => {
    const p = finessFamillePerimetre(["labo", "pharmacie"]);
    expect(p.completeness_note).toMatch(/hospitali/i);
    expect(p.completeness_note).toMatch(/PUI|usage intérieur/i);
  });

  it("famille sans rider (ex. ehpad) → note de base seule, pas de crash", () => {
    const p = finessFamillePerimetre(["ehpad"]);
    expect(p.completeness_note.length).toBeGreaterThan(0);
  });
});

describe("descripteurs statiques", () => {
  it("AMELI_PERIMETRE déclare l'exclusion des salariés", () => {
    expect(AMELI_PERIMETRE.lens).toBe("liberal_conventionne");
    expect(AMELI_PERIMETRE.exclut).toMatch(/salari/i);
    expect(AMELI_PERIMETRE.completeness_note).toMatch(/RPPS/);
  });

  it("RPPS_PERIMETRE se déclare comme registre complet", () => {
    expect(RPPS_PERIMETRE.lens).toBe("registre_complet");
  });
});
```

- [ ] **Step 2 : Lancer le test — vérifier l'échec**

Run: `pnpm vitest run src/sante/perimetre.test.ts`
Expected: FAIL — module `./perimetre` introuvable.

- [ ] **Step 3 : Créer le module `src/sante/perimetre.ts`**

```typescript
/**
 * Déclaration explicite de la « lentille » de chaque source de données.
 *
 * Chaque référentiel (FINESS, Ameli, RPPS) ne contient qu'une projection de la
 * réalité : FINESS classe un site sous UNE catégorie dominante, Ameli ne voit
 * que le libéral conventionné, RPPS est le registre le plus complet. Un tool
 * de comptage qui restitue un résultat filtré SANS déclarer sa lentille induit
 * un undercount silencieux (cf. cadrage docs/plans/completude-lentilles-sources.md).
 *
 * Ce module fournit les descripteurs `Perimetre` ; ils sont injectés dans la
 * sortie des tools au boundary `api/tools.ts` via `withPerimetre`.
 */
import type { FinessFamilleQuery } from "./finess-categories.js";

/** Descripteur de lentille — ce qu'un comptage inclut, exclut, et sa note. */
export interface Perimetre {
  /** Source amont (ex. "FINESS / DREES"). */
  source: string;
  /** Identifiant court et stable de la lentille (ex. "categorie_dominante"). */
  lens: string;
  /** Ce que le résultat compte effectivement. */
  compte: string;
  /** Ce que le résultat exclut structurellement. */
  exclut: string;
  /** Note lisible — à restituer telle quelle au lecteur final. */
  completeness_note: string;
}

const FINESS_LENS_BASE =
  "FINESS classe chaque établissement géographique sous UNE catégorie " +
  "administrative dominante. Une activité hébergée dans un site classé sous " +
  "une autre catégorie n'est pas comptée par un filtre de famille.";

/**
 * Compléments de note spécifiques à une famille dont la lentille mord fort.
 * Une famille absente de cette table n'ajoute aucun rider (note de base seule).
 */
const FAMILLE_RIDERS: Partial<Record<FinessFamilleQuery, string>> = {
  labo:
    "La biologie hospitalière (plateaux des CHR/CH/CLCC) est classée sous la " +
    "catégorie de l'hôpital, pas sous `labo` — plusieurs centaines de plateaux " +
    "sont hors de ce comptage.",
  imagerie:
    "FINESS ne répertorie quasiment pas les cabinets d'imagerie comme " +
    "établissements géographiques : la famille `imagerie` renvoie le plus " +
    "souvent 0 résultat. L'imagerie de ville se trouve via les radiologues " +
    "(tools RPPS).",
  pharmacie:
    "Les pharmacies à usage intérieur (PUI) des hôpitaux sont classées sous " +
    "la catégorie de l'hôpital, pas sous `pharmacie`.",
};

/**
 * Construit le descripteur de lentille pour un comptage FINESS filtré par
 * familles. Les riders des familles présentes sont cumulés dans la note.
 */
export function finessFamillePerimetre(
  familles: readonly FinessFamilleQuery[] | undefined,
): Perimetre {
  const list = familles ?? [];
  const riders = list
    .map((f) => FAMILLE_RIDERS[f])
    .filter((r): r is string => r !== undefined);
  return {
    source: "FINESS / DREES",
    lens: "categorie_dominante",
    compte:
      list.length > 0
        ? `Établissements dont la catégorie FINESS principale relève de : ${list.join(", ")}.`
        : "Tous les établissements FINESS, quelle que soit la catégorie.",
    exclut:
      "Les activités secondaires hébergées dans un établissement classé sous " +
      "une autre catégorie.",
    completeness_note: [FINESS_LENS_BASE, ...riders].join(" "),
  };
}

/** Lentille des tools Ameli — libéral conventionné, par construction. */
export const AMELI_PERIMETRE: Perimetre = {
  source: "Annuaire santé Ameli / CNAM",
  lens: "liberal_conventionne",
  compte:
    "Professionnels de santé en exercice libéral conventionné (soins de ville).",
  exclut:
    "Les praticiens salariés (hôpital public, centres de santé, salariat) — " +
    "soit ~49 % de l'effectif soignant recensé au RPPS.",
  completeness_note:
    "Pour dénombrer TOUS les professionnels d'une spécialité sur un " +
    "territoire, salariés inclus, utiliser les tools RPPS " +
    "(`professionnels_rpps_in_radius`, `professionnels_rpps_par_dept`). Ameli " +
    "répond aux questions de conventionnement, secteur et tarifs.",
};

/** Lentille des tools RPPS — le registre le plus complet. */
export const RPPS_PERIMETRE: Perimetre = {
  source: "RPPS / Annuaire santé ANS",
  lens: "registre_complet",
  compte:
    "Professionnels de santé enregistrés, tous modes d'exercice " +
    "(libéral, salarié, mixte).",
  exclut:
    "Rien par construction — mais `mode_exercice` est non renseigné sur " +
    "~16 % des fiches.",
  completeness_note:
    "Source la plus complète pour dénombrer une population de professionnels " +
    "sur un territoire.",
};
```

- [ ] **Step 4 : Lancer le test — vérifier le succès**

Run: `pnpm vitest run src/sante/perimetre.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5 : Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
git add src/sante/perimetre.ts src/sante/perimetre.test.ts
git commit -m "feat(perimetre): module de descripteurs de lentille de source

Type Perimetre + finessFamillePerimetre (riders labo/imagerie/pharmacie)
+ AMELI_PERIMETRE + RPPS_PERIMETRE. Pas encore câblé aux tools (Task 3-4).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 : Wrapper `withPerimetre` + câblage des tools FINESS / densité / panorama / coverage

**Files:**
- Modify: `api/tools.ts`
- Test: `api/tools.test.ts` (créer si absent — voir Step 8)

Contexte : `withPerimetre` est le jumeau de `withFreshness` (déjà utilisé p.ex.
`api/tools.ts:1265`). Il ajoute le champ `perimetre` à la sortie. La couche lib
n'est pas touchée.

- [ ] **Step 1 : Importer les descripteurs**

En tête de `api/tools.ts`, dans le bloc d'imports depuis `src/sante/`, ajouter :

```typescript
import {
  type Perimetre,
  AMELI_PERIMETRE,
  RPPS_PERIMETRE,
  finessFamillePerimetre,
} from "../src/sante/perimetre.js";
```

(Adapter le chemin relatif au pattern d'import existant du fichier — vérifier
comment `getFinessInRadius` est importé et copier la forme.)

- [ ] **Step 2 : Définir le helper `withPerimetre`**

Près de la définition de `withFreshness` dans `api/tools.ts`, ajouter :

```typescript
/**
 * Injecte le descripteur de lentille `perimetre` dans la sortie d'un tool de
 * comptage. Jumeau de `withFreshness` — métadonnée de présentation ajoutée au
 * boundary, la couche lib reste pure. Cf. cadrage completude-lentilles-sources.
 */
function withPerimetre<T extends object>(
  result: T,
  perimetre: Perimetre,
): T & { perimetre: Perimetre } {
  return { ...result, perimetre };
}
```

- [ ] **Step 3 : Déclarer `perimetre` dans le schéma de sortie**

Repérer le bloc des schémas de sortie (`QUERY_RESULT_OUTPUT_SCHEMA`,
`COVERAGE…`, ~lignes 235-441). Ajouter une constante de fragment :

```typescript
const PERIMETRE_OUTPUT_SCHEMA = {
  type: "object",
  description:
    "Lentille de la source : ce que le comptage inclut/exclut. " +
    "Lire `completeness_note` et la restituer au lecteur final.",
  properties: {
    source: { type: "string" },
    lens: { type: "string" },
    compte: { type: "string" },
    exclut: { type: "string" },
    completeness_note: { type: "string" },
  },
} as const;
```

Puis ajouter `perimetre: PERIMETRE_OUTPUT_SCHEMA` dans les `properties` de
`QUERY_RESULT_OUTPUT_SCHEMA` et de la/les constante(s) de schéma utilisées par
`densite_*`, `panorama_sante_territoire` et `finess_sirene_coverage_in_radius`.
`perimetre` reste **optionnel** (ne pas l'ajouter au tableau `required`).

- [ ] **Step 4 : Câbler `etablissements_finess_in_radius`**

Handler à `api/tools.ts:~1252-1266`. Remplacer la ligne de `return` :

```typescript
      return withFreshness(await getFinessInRadius(input), args.include_freshness, ["finess"]);
```

par :

```typescript
      const result = withFreshness(
        await getFinessInRadius(input),
        args.include_freshness,
        ["finess"],
      );
      return withPerimetre(result, finessFamillePerimetre(familles ?? undefined));
```

(`familles` est déjà calculé ligne ~1257 via `parseFamilles`.)

- [ ] **Step 5 : Câbler `etablissements_finess_by_categorie`**

Handler à `api/tools.ts:~1301-1314`. Remplacer la ligne de `return` :

```typescript
      return withFreshness(await getFinessByCategorie(input), args.include_freshness, ["finess"]);
```

par :

```typescript
      const result = withFreshness(
        await getFinessByCategorie(input),
        args.include_freshness,
        ["finess"],
      );
      return withPerimetre(result, finessFamillePerimetre([famille]));
```

(`famille` est déjà calculé ligne ~1302.)

- [ ] **Step 6 : Câbler `densite_etablissements_sante`, `densite_professionnels_sante`, `panorama_sante_territoire`**

Pour chacun (handlers ~1851, ~1929, ~1978) : repérer la ligne `return` finale du
handler, capturer la valeur dans `const result = …`, puis retourner
`withPerimetre(result, <perimetre>)` :

- `densite_etablissements_sante` → `finessFamillePerimetre(<la/les famille(s) du handler>)`.
- `densite_professionnels_sante` → `RPPS_PERIMETRE` si la source est RPPS, `AMELI_PERIMETRE` si Ameli. Lire le handler pour déterminer la source effective ; si le tool peut renvoyer les deux, choisir selon le paramètre de source du handler.
- `panorama_sante_territoire` → ce tool agrège FINESS **et** professionnels. Lui passer `finessFamillePerimetre(input.finessFamilles)` (le volet établissements est le plus exposé). Si le résultat porte déjà des sous-objets densité, ne pas les sur-décorer — un seul `perimetre` au niveau racine suffit.

- [ ] **Step 7 : Câbler `finess_sirene_coverage_in_radius`**

Handler ~2204. `CoverageResult` porte déjà `familles_auto_derivees` /
`coverage_status` : ajouter `perimetre` au même niveau via
`withPerimetre(result, finessFamillePerimetre(<familles du handler>))`.

- [ ] **Step 8 : Test de câblage**

Vérifier le pattern de test des handlers (chercher un `*.test.ts` qui appelle
un `handler` de `TOOLS`). S'il existe, y ajouter — sinon créer `api/tools.test.ts` :

```typescript
import { describe, expect, it } from "vitest";
import { TOOLS } from "./tools";

describe("perimetre wiring", () => {
  it("etablissements_finess_by_categorie expose un perimetre famille-aware", async () => {
    const tool = TOOLS.find((t) => t.name === "etablissements_finess_by_categorie");
    expect(tool).toBeDefined();
    const out = await tool!.handler({ categorie: "labo", limit: 1 });
    expect((out as { perimetre?: { lens?: string } }).perimetre?.lens).toBe(
      "categorie_dominante",
    );
    expect((out as { perimetre: { completeness_note: string } }).perimetre.completeness_note)
      .toMatch(/hospitali/i);
  });
});
```

Si ce test exige un accès DB (RPC réelle), le placer en `*.integration.test.ts`
et respecter la convention `--no-file-parallelism` (cf. `CLAUDE.md`). Sinon, si
les handlers sont mockables, le garder en unit.

- [ ] **Step 9 : Vérifier**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run api/tools.test.ts`
Expected: PASS.

- [ ] **Step 10 : Commit**

```bash
git add api/tools.ts api/tools.test.ts
git commit -m "feat(tools): champ perimetre sur les tools de comptage FINESS

withPerimetre (jumeau de withFreshness) injecte la lentille de source.
Câblé : etablissements_finess_in_radius/by_categorie, densite_*,
panorama_sante_territoire, finess_sirene_coverage_in_radius.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 : Câblage des tools professionnels (Ameli + RPPS)

**Files:**
- Modify: `api/tools.ts`
- Test: `api/tools.test.ts`

- [ ] **Step 1 : Câbler les tools Ameli**

Handlers `professionnels_in_radius` (~1451) et `professionnels_par_specialite_dept`
(~1529). Pour chacun, capturer le résultat puis :

```typescript
      return withPerimetre(result, AMELI_PERIMETRE);
```

(Composer avec un `withFreshness` éventuel si déjà présent dans le handler.)

- [ ] **Step 2 : Câbler les tools RPPS**

Handlers `professionnels_rpps_in_radius` et `professionnels_rpps_par_dept`
(chercher leur `name:` dans `api/tools.ts`). Pour chacun :

```typescript
      return withPerimetre(result, RPPS_PERIMETRE);
```

- [ ] **Step 3 : Ajouter une assertion de test**

Dans `api/tools.test.ts`, ajouter (adapter au caractère unit/integration retenu
en Task 3 Step 8) :

```typescript
  it("professionnels_par_specialite_dept expose la lentille Ameli", async () => {
    const tool = TOOLS.find((t) => t.name === "professionnels_par_specialite_dept");
    const out = await tool!.handler({ departement: "75", limit: 1 });
    expect((out as { perimetre: { lens: string } }).perimetre.lens).toBe(
      "liberal_conventionne",
    );
  });
```

- [ ] **Step 4 : Vérifier**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run api/tools.test.ts`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add api/tools.ts api/tools.test.ts
git commit -m "feat(tools): champ perimetre sur les tools professionnels (Ameli + RPPS)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 : Clarification du routage dans les descriptions de tools

**Files:**
- Modify: `api/tools.ts`

Contexte : les descriptions de tools sont lues par le LLM caller et orientent
son choix de tool. `AMELI_SCOPE_WARNING` existe déjà côté Ameli. Manque : un
note côté FINESS sur la lentille « catégorie dominante ».

- [ ] **Step 1 : Lire `AMELI_SCOPE_WARNING`**

Lire `api/tools.ts:~647-700`. Vérifier que `AMELI_SCOPE_WARNING` mentionne déjà
l'exclusion des salariés et le renvoi vers RPPS. Si oui → ne rien dupliquer. Si
la mention « ~49 % » ou le renvoi explicite vers `professionnels_rpps_*` manque,
l'ajouter à la constante (une seule édition, propagée à tous les tools Ameli).

- [ ] **Step 2 : Ajouter une note de lentille FINESS**

Près de `FINESS_RS_TRUNCATION_NOTE` dans `api/tools.ts`, ajouter :

```typescript
const FINESS_FAMILLE_LENS_NOTE =
  "Lentille : un filtre `familles` compte les établissements par leur " +
  "catégorie FINESS *principale*. Les activités hébergées dans un site " +
  "d'une autre catégorie (ex. plateau de biologie d'un hôpital sous " +
  "`famille=labo`) ne sont pas comptées — voir le champ `perimetre` de la " +
  "réponse. La famille `imagerie` renvoie le plus souvent 0 résultat " +
  "(FINESS ne répertorie pas les cabinets d'imagerie).";
```

- [ ] **Step 3 : Appendre la note aux descriptions FINESS famille**

Aux descriptions de `etablissements_finess_in_radius` (~1220) et
`etablissements_finess_by_categorie` (~1270), ajouter `${FINESS_FAMILLE_LENS_NOTE}`
en fin de template literal (après `${FINESS_RS_TRUNCATION_NOTE}`).

- [ ] **Step 4 : Vérifier**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add api/tools.ts
git commit -m "docs(tools): note de lentille FINESS dans les descriptions famille

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 : Documentation + bump de version

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `README.md`
- Modify: `package.json`, `server.json`, `src/core/version.ts`

- [ ] **Step 1 : CHANGELOG.md**

Ajouter une section en tête :

```markdown
## [0.17.0] - 2026-05-XX

### Phase 1 — Transparence des lentilles de source

- **Champ `perimetre`** sur les tools de comptage/densité (FINESS, Ameli, RPPS) :
  déclare explicitement la lentille de la source (ce qui est compté/exclu) pour
  empêcher un undercount lu comme un chiffre territorial réel.
- **fix(finess)** : 5 codes catégorie vivants en prod mais non catalogués
  ajoutés — `610`/`612` (labos autonomes → famille `labo`), `628`/`629`
  (pharmacies → `pharmacie`), `695` (GCS → `groupement`).
- Note de lentille dans les descriptions des tools FINESS famille.

Réf : `docs/plans/completude-lentilles-sources.md`.
```

- [ ] **Step 2 : CLAUDE.md — nouvelle convention**

Dans `CLAUDE.md`, section « Conventions code » (sous-section Endpoint ou une
nouvelle ligne), ajouter :

```markdown
- **Champ `perimetre` sur les tools de comptage** : tout tool qui compte/agrège
  par famille ou spécialité DOIT exposer un `perimetre` (`src/sante/perimetre.ts`)
  injecté via `withPerimetre` au boundary `api/tools.ts` (jumeau de
  `withFreshness`). La couche lib reste pure. Un comptage filtré sans lentille
  déclarée = undercount silencieux (cf. `docs/plans/completude-lentilles-sources.md`).
```

- [ ] **Step 3 : README.md**

Si le README liste les champs de sortie des tools ou un exemple de réponse,
mentionner `perimetre`. Sinon, aucune modification (ne pas inventer de section).

- [ ] **Step 4 : Bump de version 0.16.0 → 0.17.0**

- `package.json` ligne 3 : `"version": "0.17.0",`
- `server.json` ligne 9 ET ligne 14 : `"version": "0.17.0",`
- `src/core/version.ts` ligne 10 : `export const VERSION = "0.17.0";`

- [ ] **Step 5 : Vérifier**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
git add CHANGELOG.md CLAUDE.md README.md package.json server.json src/core/version.ts
git commit -m "docs: CHANGELOG + CLAUDE.md + bump 0.17.0 (Phase 1 lentilles)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 : Discipline post-fix + release V0.17.0

**Files:** aucun fichier de code nouveau — étape de processus.

- [ ] **Step 1 : Self-review**

Relire le diff complet (`git diff main...HEAD`). Vérifier : aucun `console.log`
oublié, aucun TODO, le champ `perimetre` cohérent entre les ~10 tools.

- [ ] **Step 2 : `/simplify`**

Lancer `/simplify` (3 agents reuse/quality/efficiency) sur le diff. Appliquer
toutes les corrections. Cibler en particulier : la répétition `withPerimetre`
dans les ~10 handlers — vérifier qu'il n'y a pas une factorisation plus propre
(ex. un tool→perimetre map) sans sur-ingénierie.

- [ ] **Step 3 : `/review` Passe 1**

Lancer `/review` (code-reviewer + silent-failure-hunter + code-simplifier).
Corriger **tout**, y compris hors scope.

- [ ] **Step 4 : `/review` Passe 2**

Lancer `/review` (code-reviewer + silent-failure-hunter uniquement).

- [ ] **Step 5 : Validation finale**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit`
Expected: tout vert. Puis `pnpm test` (complet, nécessite `pnpm db:start`).

- [ ] **Step 6 : Validation prod du comportement**

Après merge + déploiement : appeler `etablissements_finess_by_categorie`
`categorie=labo` sur l'endpoint prod, vérifier que la réponse porte un objet
`perimetre` avec `completeness_note` mentionnant les plateaux hospitaliers.
Appeler `etablissements_finess_in_radius` près de Lille — vérifier que `610`/`612`
sont désormais inclus dans `famille=labo`.

- [ ] **Step 7 : Release V0.17.0**

Suivre `scripts/release.sh` / la section « Release process » de `CLAUDE.md`
(maintainer-only : npm OTP + mcp-publisher). Merge de la branche
`feat/completude-lentilles-sources` vers `main` au préalable.

- [ ] **Step 8 : Mémoire**

Écrire une mémoire `~/.claude/projects/.../memory/` : V0.17.0 Phase 1 lentilles
livrée, pattern `withPerimetre`, ce qui reste = Phase 2. Ajouter la ligne
d'index dans `MEMORY.md`.

---

## Task 8 : Phase 2 — mesure de calibrage du signal `num_finess`

**Files:**
- Create: `docs/plans/completude-lentilles-phase2-mesure.md`

Contexte : avant d'implémenter la couche d'activités dérivée (Phase 2), mesurer
le signal RPPS `num_finess` pour fixer le seuil `N` (« ≥ N professionnels de
type X rattachés ⇒ le site héberge l'activité X ») et le taux de faux positifs,
**par activité** (biologie, imagerie, pharmacie). Doctrine `prove-rootcause-by-prod`.
Requêtes exécutées via le MCP Supabase (`execute_sql`).

- [ ] **Step 1 : Mesure du gain par activité — biologie**

Exécuter, pour `N ∈ {1,2,3,5,10}`, le comptage des sites NON-labo détectés :

```sql
WITH bio AS (
  SELECT f.num_finess, f.categorie_code,
         count(DISTINCT r.id) AS personnels
  FROM finess f
  JOIN rpps r ON r.num_finess = f.num_finess
  WHERE f.categorie_code NOT IN ('610','611','612')
    AND ( r.savoir_faire_libelle ILIKE 'Biologie médicale%'
          OR r.savoir_faire_libelle ILIKE 'Anatomie et cytologie%'
          OR r.profession_libelle = 'Technicien de Laboratoire' )
  GROUP BY 1,2 )
SELECT
  count(*) FILTER (WHERE personnels >= 1)  AS sites_n1,
  count(*) FILTER (WHERE personnels >= 2)  AS sites_n2,
  count(*) FILTER (WHERE personnels >= 3)  AS sites_n3,
  count(*) FILTER (WHERE personnels >= 5)  AS sites_n5,
  count(*) FILTER (WHERE personnels >= 10) AS sites_n10
FROM bio;
```

- [ ] **Step 2 : Échantillon de faux positifs — biologie**

Pour le `N` candidat, sortir un échantillon de 20 sites détectés avec leur
catégorie et leur libellé, pour revue manuelle (vrai plateau ? rattachement
périmé ? établissement social où un seul technicien traîne ?) :

```sql
SELECT f.num_finess, f.raison_sociale, f.categorie_code, f.categorie_libelle,
       count(DISTINCT r.id) AS personnels
FROM finess f
JOIN rpps r ON r.num_finess = f.num_finess
WHERE f.categorie_code NOT IN ('610','611','612')
  AND ( r.savoir_faire_libelle ILIKE 'Biologie médicale%'
        OR r.savoir_faire_libelle ILIKE 'Anatomie et cytologie%'
        OR r.profession_libelle = 'Technicien de Laboratoire' )
GROUP BY 1,2,3,4
HAVING count(DISTINCT r.id) >= 3   -- remplacer 3 par le N candidat
ORDER BY random() LIMIT 20;
```

Annoter chaque ligne : vrai plateau / douteux / faux positif.

- [ ] **Step 3 : Répéter Steps 1-2 pour l'imagerie**

Même structure, filtre activité : `r.profession_libelle = 'Manipulateur ERM'`
**OU** `r.savoir_faire_libelle ILIKE 'Radio-diagnostic%'` **OU**
`ILIKE 'Radiologie et imagerie%'`. Sites NON-imagerie (`categorie_code <> '619'`).

- [ ] **Step 4 : Répéter Steps 1-2 pour la pharmacie**

Filtre activité : `r.profession_libelle = 'Pharmacien'`. Sites de catégorie
hospitalière (`categorie_code IN ('101','355','365','292','131','109','362'…)`)
→ détecte les PUI. ⚠️ Risque de bruit élevé (un pharmacien peut avoir un
`num_finess` périmé) — la revue manuelle Step 2 est ici décisive.

- [ ] **Step 5 : Rédiger le rapport `completude-lentilles-phase2-mesure.md`**

Documenter, par activité : le tableau gain/`N`, le `N` retenu, le taux de faux
positifs observé sur l'échantillon, et une **décision go/no-go**. Conclure par :
les activités qui passent (gain net + FP maîtrisé) iront dans la couche v1 ;
celles qui échouent sont écartées ou re-mesurées.

- [ ] **Step 6 : Commit du rapport**

```bash
git add docs/plans/completude-lentilles-phase2-mesure.md
git commit -m "docs(plans): rapport de mesure de calibrage Phase 2

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7 : Handoff Phase 2 implémentation**

Le rapport de la Tâche 8 débloque l'écriture d'un **plan séparé** pour la couche
d'activités dérivée (matview `finess_hosted_activities` alimentée par RPPS,
recalculée au cron RPPS, exposée via une option des tools famille). Ce plan
n'est PAS dans le présent document — ses tâches dépendent du `N` calibré et de
la liste d'activités validées. Relancer `superpowers:writing-plans` à ce moment.

---

## Self-Review du plan

- **Couverture du cadrage** : Phase 1 §5.1 (métadonnée) → Tâches 2-4 ; §5.2
  (catalogue) → Tâche 1 ; §5.3 (routage) → Tâche 5. Phase 2 §6.4 (mesure) →
  Tâche 8. Phase 2 §6.1-6.3 (implémentation Route A/B) → explicitement hors de
  ce plan (plan séparé post-mesure). ✅
- **Placeholders** : les seuls renvois « adapter au pattern existant » (Task 3
  Steps 6-7, Task 4) sont des instructions de lecture ciblée, pas des TODO — le
  pattern complet (`withPerimetre` + forme du `return`) est montré exhaustivement
  Steps 2-5. Acceptable : la valeur de `perimetre` diffère par tool, le geste de
  câblage est identique et entièrement explicité.
- **Cohérence des types** : `Perimetre`, `finessFamillePerimetre`,
  `AMELI_PERIMETRE`, `RPPS_PERIMETRE`, `withPerimetre`, `PERIMETRE_OUTPUT_SCHEMA`
  — noms identiques de leur définition (Tâche 2-3) à leurs usages (Tâche 3-4). ✅
- **Scope** : Phase 1 = un sous-système shippable cohérent ; Phase 2 mesure =
  une tâche d'analyse. L'implémentation Phase 2 est correctement sortie en plan
  séparé (sous-systèmes indépendants). ✅
