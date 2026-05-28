# Phase C — Panoramas composites — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter 2 outils MCP composites (`panorama_implantation_complet`, `enrichir_concurrents`) qui collapsent une étude d'implantation de ~15 round-trips connecteur Anthropic à ~2, côté serveur `france-data-mcp` (release additive 0.23.0).

**Architecture:** Deux modules `src/sante/` orchestrent par `Promise.all` les briques lib existantes (panorama territoire, profil IRIS, helpers radius FINESS/RPPS/Ameli/CDS, coverage, inspect/cross-source/SIREN). Dégradation **par section** (drapeau `couverture`, jamais silencieuse) sauf échec d'ancrage = rejet total `-32602`. Aucune nouvelle requête DB brute, aucune migration. 2 défs d'outils ajoutées dans `api/tools.ts`.

**Tech Stack:** TypeScript strict (zéro `any`), Vitest, validation manuelle (`requireString`/`coerceNumber`, pas de Zod), erreurs `RangeError`→`-32602`, `console.warn` structuré.

**Contrat gelé :** `docs/plans/panoramas-composites.md` (§4 = `panorama_implantation_complet`, §5 = `enrichir_concurrents`, §4.4 = doctrine de dégradation). Ce plan est le COMMENT ; la spec est le QUOI. Ne pas re-concevoir.

**Pré-requis vérifiés :** worktree `france-data-mcp-panoramas` sur `feat/panoramas-composites`, version 0.22.0, gate B franchi (`profil_iris` live en prod). Famille FINESS `dialyse` = codes `["141","146"]` confirmée (`src/sante/finess-categories.ts:223`).

**⚠️ Repo santé sensible — branche partagée :** commit UNIQUEMENT les fichiers nommés explicitement, **jamais `git add -A`** (WIP possible d'un autre Claude sur la branche). Merge/deploy MANUEL après validation Cyril — ce plan ne merge ni ne déploie.

---

## File Structure

| Fichier | Responsabilité | Action |
|---|---|---|
| `src/sante/panorama-implantation.ts` | Composite socle : ancrage + 7 sections en parallèle + couverture + pièges PLM/geo_precision | **Créer** |
| `src/sante/panorama-implantation.test.ts` | Tests unitaires module socle (parallélisme, dégradation par section, ancrage KO, PLM) | **Créer** |
| `src/sante/enrichir-concurrents.ts` | Composite enrichissement : boucle bornée `max=3` sur top concurrents | **Créer** |
| `src/sante/enrichir-concurrents.test.ts` | Tests module enrichissement (cap, dégradation par concurrent, dedup) | **Créer** |
| `api/tools.ts` | 2 défs d'outils + handlers (normalizeAliases, validation entrée, mapping vers modules) | **Modifier** |
| `api/tools.test.ts` | Tests d'intégration MCP (handler délègue, -32602 sur ancrage KO) | **Modifier** |
| `package.json:4` | Bump `0.22.0` → `0.23.0` | **Modifier** |
| `CHANGELOG.md` | Entrée 0.23.0 (2 tools additifs, zéro breaking) | **Modifier** |

---

## Task 0 : Grounding — confirmer les signatures exactes des 7 briques de section

Ce plan référence des briques lib dont la signature DOIT être confirmée avant d'écrire les tests (sinon risque de mock sur une signature fausse). **Lecture seule, pas de code.**

**Files (lecture) :** `src/sante/panorama.ts`, `src/territoire/iris-profil.ts`, `src/sante/finess-db.ts`, `src/sante/rpps-db.ts`, `src/sante/ameli-db.ts`, `src/sante/cds-db.ts`, `src/sante/cross-source.ts`, `src/sante/inspect-site.ts`, `src/territoire/geocode.ts`, `src/territoire/dept-codes.ts`, `src/territoire/commune-index.ts`, `src/storage/ingest-log.ts`.

- [ ] **Step 1 : Lire et noter les signatures exactes** dans un scratch (commentaire en tête du nouveau module, à retirer en fin de tâche). Confirmer pour chaque brique : nom exporté, forme de l'input (objet vs positionnel), forme de l'output, et si elle `throw` ou renvoie `LookupResult`/`null` :

| Section | Brique attendue (à CONFIRMER) | Source |
|---|---|---|
| `territoire` | `panoramaSanteTerritoire({ codeInsee })` → `PanoramaSanteTerritoireResult` (throw si sous-requête KO) | `panorama.ts:116` |
| `demande` | `getProfilIris({ point:{lon,lat}, rayonKm })` → `LookupResult<BassinProfile>` | `iris-profil.ts` |
| `concurrents`/`pourvoyeurs` | `getFinessInRadius({ center:{lat,lon}, radiusKm, familles, limit })` → `FinessQueryResult` | `finess-db.ts:171` |
| `prescripteurs` MG | `getRppsInRadius({ center, radiusKm, professionCodes, preciseOnly, limit })` → `{count, results}` | `rpps-db.ts:101` |
| `prescripteurs` IDEL | brique Ameli libéraux `professionnels_in_radius` (spe IDEL) — **confirmer nom export + params** | `ameli-db.ts` |
| `cds` | helper CDS radius — **confirmer nom export + params + forme** | `cds-db.ts` |
| `referentiels` | helper coverage FINESS↔SIRENE (`naf=8690B`) — **confirmer nom export + params** | `cross-source.ts` |
| `meta.sources` | `getDataFreshness()` → `IngestFreshnessRow[]` | `ingest-log.ts:80` |
| ancrage | `geocode(adresse, opts?)` → `GeocodeResult \| null` ; `deptFromCodeInsee(insee)` ; `plmDept(...)` | `geocode.ts` / `dept-codes.ts` / `commune-index.ts` |
| enrichir | `inspectSite({ numFiness, historiqueDetail })`, `compareRaisonSocialeFinessVsRpps(numFiness)`, `getEntrepriseBySiren(siren)` | `inspect-site.ts` / `cross-source.ts` |

- [ ] **Step 2 : Si une signature diffère du tableau ci-dessus**, noter l'écart dans le commentaire de tête et adapter les tasks suivantes en conséquence (mêmes noms d'interfaces, signatures réelles). **Ne pas inventer** une brique absente : si une section n'a pas de brique réutilisable, STOP et signaler à Cyril (la spec §4.3 affirme qu'elles existent toutes).

- [ ] **Step 3 : Commit** (doc/grounding uniquement — aucun code) : pas de commit, c'est de la lecture. Passer à Task 1.

---

## Task 1 : Squelette du module socle + types + ancrage (rejet total)

**Files :**
- Create: `src/sante/panorama-implantation.ts`
- Test: `src/sante/panorama-implantation.test.ts`

- [ ] **Step 1 : Écrire les tests d'ancrage (rouges)**

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import * as geocodeMod from "../territoire/geocode.js";
import { panoramaImplantationComplet } from "./panorama-implantation.js";

afterEach(() => vi.restoreAllMocks());

describe("panorama_implantation_complet — ancrage", () => {
  it("géocode KO (null) → rejet total RangeError", async () => {
    vi.spyOn(geocodeMod, "geocode").mockResolvedValueOnce(null);
    await expect(
      panoramaImplantationComplet({ adresse: "xxxxx introuvable" }),
    ).rejects.toThrow(RangeError);
  });

  it("confidence_low → rejet total RangeError", async () => {
    vi.spyOn(geocodeMod, "geocode").mockResolvedValueOnce({
      point: { lat: 50.6, lon: 3.0 }, label: "…", score: 0.4,
      confidence_low: true, codeCommune: "59350", commune: "Lille", type: "street",
    });
    await expect(
      panoramaImplantationComplet({ adresse: "rue floue" }),
    ).rejects.toThrow(/confidence|ancrage/i);
  });

  it("code_insee indérivable du géocode → rejet total", async () => {
    vi.spyOn(geocodeMod, "geocode").mockResolvedValueOnce({
      point: { lat: 50.6, lon: 3.0 }, label: "…", score: 0.96,
      confidence_low: false, codeCommune: undefined, commune: "?", type: "street",
    });
    await expect(
      panoramaImplantationComplet({ adresse: "sans insee" }),
    ).rejects.toThrow(/insee|ancrage/i);
  });
});
```

- [ ] **Step 2 : Lancer → vérifier l'échec**

Run: `pnpm vitest run src/sante/panorama-implantation.test.ts`
Expected: FAIL — `panoramaImplantationComplet is not a function` / module introuvable.

- [ ] **Step 3 : Implémenter le squelette + l'ancrage**

```typescript
import { geocode } from "../territoire/geocode.js";
import { deptFromCodeInsee } from "../territoire/dept-codes.js";
import { plmDept } from "../territoire/commune-index.js";

const LOG_TAG = "[france-data-mcp] panorama_implantation_complet";

export interface PanoramaImplantationInput {
  adresse?: string;
  point?: { lat: number; lon: number };
  rayonKm?: number;
  /** Code INSEE déjà connu (skip géocodage si point+insee fournis). Optionnel. */
  codeInsee?: string;
  commune?: string;
}

export type SectionStatus = "ok" | `partiel:${string}` | `indisponible:${string}`;

export interface PanoramaImplantationMeta {
  adresse_demandee: string | null;
  point: { lat: number; lon: number };
  code_insee: string;
  code_dept: string;
  commune: string;
  rayon_km: number;
  geocode: { score: number; confidence_low: boolean };
  plm_mode: boolean;
  sources: string[];
  generated_at: string;
}

export interface PanoramaImplantationResult {
  meta: PanoramaImplantationMeta;
  couverture: Record<string, SectionStatus>;
  territoire: unknown | null;
  demande: unknown | null;
  concurrents: unknown | null;
  pourvoyeurs: unknown | null;
  prescripteurs: unknown | null;
  cds: unknown | null;
  referentiels: unknown | null;
}

/** Résultat d'ancrage interne — toutes les sections en dépendent. */
interface Anchor {
  point: { lat: number; lon: number };
  codeInsee: string;
  codeDept: string;
  commune: string;
  rayonKm: number;
  plmMode: boolean;
  geocodeScore: number;
  confidenceLow: boolean;
  adresseDemandee: string | null;
}

/**
 * Ancrage : géocode l'adresse (ou prend le point fourni), dérive
 * code_insee/code_dept, détecte PLM. Échec d'ancrage = rejet total :
 * rien n'est calculable sans le point (spec §4.4). throw RangeError → -32602.
 */
async function resolveAnchor(input: PanoramaImplantationInput): Promise<Anchor> {
  const rayonKm = input.rayonKm ?? 5;

  if (input.point && input.codeInsee) {
    const codeDept = deptFromCodeInsee(input.codeInsee);
    if (!codeDept) throw new RangeError(`ancrage: code_insee invalide ${input.codeInsee}`);
    return {
      point: input.point, codeInsee: input.codeInsee, codeDept,
      commune: input.commune ?? "", rayonKm,
      plmMode: Boolean(plmDept(input.codeInsee)),
      geocodeScore: 1, confidenceLow: false, adresseDemandee: null,
    };
  }

  if (!input.adresse) {
    throw new RangeError("ancrage: 'adresse' ou ('point'+'code_insee') requis");
  }
  const g = await geocode(input.adresse);
  if (!g) throw new RangeError(`ancrage: géocodage sans résultat pour "${input.adresse}"`);
  if (g.confidence_low) {
    throw new RangeError(`ancrage: confidence_low (score=${g.score}) — point non fiable`);
  }
  const codeInsee = g.codeCommune;
  if (!codeInsee) {
    throw new RangeError("ancrage: code_insee indérivable du géocodage");
  }
  const codeDept = deptFromCodeInsee(codeInsee);
  if (!codeDept) throw new RangeError(`ancrage: code_insee invalide ${codeInsee}`);
  return {
    point: g.point, codeInsee, codeDept, commune: g.commune ?? "",
    rayonKm, plmMode: Boolean(plmDept(codeInsee)),
    geocodeScore: g.score, confidenceLow: false, adresseDemandee: input.adresse,
  };
}

export async function panoramaImplantationComplet(
  input: PanoramaImplantationInput,
): Promise<PanoramaImplantationResult> {
  const anchor = await resolveAnchor(input);
  // Sections ajoutées en Task 3. Pour l'instant : meta + couverture vide.
  return {
    meta: {
      adresse_demandee: anchor.adresseDemandee,
      point: anchor.point,
      code_insee: anchor.codeInsee,
      code_dept: anchor.codeDept,
      commune: anchor.commune,
      rayon_km: anchor.rayonKm,
      geocode: { score: anchor.geocodeScore, confidence_low: anchor.confidenceLow },
      plm_mode: anchor.plmMode,
      sources: [],
      generated_at: new Date().toISOString(),
    },
    couverture: {},
    territoire: null, demande: null, concurrents: null,
    pourvoyeurs: null, prescripteurs: null, cds: null, referentiels: null,
  };
}
```

> ⚠️ Adapter `g.codeCommune`/`g.point`/`g.commune` aux noms réels confirmés en Task 0 (`GeocodeResult`).

- [ ] **Step 4 : Lancer → vert**

Run: `pnpm vitest run src/sante/panorama-implantation.test.ts`
Expected: PASS (3 tests d'ancrage).

- [ ] **Step 5 : Commit**

```bash
git add src/sante/panorama-implantation.ts src/sante/panorama-implantation.test.ts
git commit -m "feat(panorama-implantation): squelette + ancrage (rejet total si géocode/insee KO)"
```

---

## Task 2 : Helper de dégradation par section (`runSection`)

Chaque section s'exécute via un wrapper qui transforme un échec brique en drapeau `couverture` au lieu de propager (doctrine §4.4). C'est le cœur de la divergence vs `panorama_sante_territoire`.

**Files :**
- Modify: `src/sante/panorama-implantation.ts`
- Test: `src/sante/panorama-implantation.test.ts`

- [ ] **Step 1 : Test rouge du wrapper**

```typescript
import { runSection } from "./panorama-implantation.js";

describe("runSection — dégradation par section", () => {
  it("succès → { data, status: 'ok' }", async () => {
    const r = await runSection("concurrents", async () => ({ count: 3 }));
    expect(r).toEqual({ data: { count: 3 }, status: "ok" });
  });

  it("brique throw → { data: null, status: 'indisponible:<msg>' } + warn, PAS de throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runSection("cds", async () => {
      throw new Error("CDS source 500");
    });
    expect(r.data).toBeNull();
    expect(r.status).toMatch(/^indisponible:/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cds"));
  });
});
```

- [ ] **Step 2 : Lancer → FAIL** (`runSection` non exporté).
Run: `pnpm vitest run src/sante/panorama-implantation.test.ts -t runSection`

- [ ] **Step 3 : Implémenter `runSection`**

```typescript
export interface SectionOutcome<T> {
  data: T | null;
  status: SectionStatus;
}

/**
 * Exécute une brique de section avec dégradation NON silencieuse (§4.4) :
 * un échec passe la section en `indisponible:<raison>` + `console.warn`
 * structuré, le reste du panorama est préservé. Le LLM client voit le trou
 * via `couverture` et le comble par l'outil unitaire. JAMAIS de catch muet.
 */
export async function runSection<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<SectionOutcome<T>> {
  try {
    const data = await fn();
    return { data, status: "ok" };
  } catch (err) {
    const raison = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG_TAG}: section '${name}' indisponible — ${raison} (panorama préservé)`);
    return { data: null, status: `indisponible:${raison}` };
  }
}
```

- [ ] **Step 4 : Lancer → vert**
Run: `pnpm vitest run src/sante/panorama-implantation.test.ts -t runSection` → PASS.

- [ ] **Step 5 : Commit**

```bash
git add src/sante/panorama-implantation.ts src/sante/panorama-implantation.test.ts
git commit -m "feat(panorama-implantation): runSection — dégradation par section non silencieuse"
```

---

## Task 3 : Câbler les 7 sections en parallèle (`Promise.all`)

**Files :**
- Modify: `src/sante/panorama-implantation.ts`
- Test: `src/sante/panorama-implantation.test.ts`

- [ ] **Step 1 : Tests rouges — parallélisme + assemblage couverture + 1 section down**

```typescript
import * as panoramaMod from "./panorama.js";
import * as irisMod from "../territoire/iris-profil.js";
import * as finessMod from "./finess-db.js";

function mockAnchorOk() {
  vi.spyOn(geocodeMod, "geocode").mockResolvedValue({
    point: { lat: 50.633, lon: 3.057 }, label: "Lille", score: 0.96,
    confidence_low: false, codeCommune: "59350", commune: "Lille", type: "housenumber",
  });
}

describe("panorama_implantation_complet — sections", () => {
  it("toutes sections OK → couverture tout 'ok' + meta peuplée", async () => {
    mockAnchorOk();
    vi.spyOn(panoramaMod, "panoramaSanteTerritoire").mockResolvedValue({ /* result minimal */ } as never);
    vi.spyOn(irisMod, "getProfilIris").mockResolvedValue({ ok: true, value: { mode: "bassin" } } as never);
    vi.spyOn(finessMod, "getFinessInRadius").mockResolvedValue({ count: 0, truncated: false, results: [] });
    // … mocks IDEL/CDS/coverage/freshness (signatures Task 0)
    const r = await panoramaImplantationComplet({ adresse: "Lille rue Nationale", rayonKm: 5 });
    expect(r.couverture.territoire).toBe("ok");
    expect(r.meta.code_insee).toBe("59350");
    expect(r.meta.point).toEqual({ lat: 50.633, lon: 3.057 });
  });

  it("section 'demande' down → 'indisponible:…', les 6 autres restent OK", async () => {
    mockAnchorOk();
    vi.spyOn(irisMod, "getProfilIris").mockRejectedValue(new Error("IRIS DB down"));
    vi.spyOn(panoramaMod, "panoramaSanteTerritoire").mockResolvedValue({} as never);
    vi.spyOn(finessMod, "getFinessInRadius").mockResolvedValue({ count: 5, truncated: false, results: [] });
    const r = await panoramaImplantationComplet({ adresse: "Lille", rayonKm: 5 });
    expect(r.couverture.demande).toMatch(/^indisponible:/);
    expect(r.demande).toBeNull();
    expect(r.couverture.territoire).toBe("ok");   // les autres survivent
    expect(r.couverture.concurrents).toBe("ok");
  });

  it("Promise.all : les sections sont parallélisées (pas en série)", async () => {
    mockAnchorOk();
    const order: string[] = [];
    const slow = (tag: string) => async () => {
      order.push(`start-${tag}`); await new Promise((r) => setTimeout(r, 10)); order.push(`end-${tag}`);
      return {} as never;
    };
    vi.spyOn(panoramaMod, "panoramaSanteTerritoire").mockImplementation(slow("terr"));
    vi.spyOn(irisMod, "getProfilIris").mockImplementation(slow("dem") as never);
    vi.spyOn(finessMod, "getFinessInRadius").mockImplementation(slow("fin") as never);
    await panoramaImplantationComplet({ adresse: "Lille" });
    const firstEnd = order.findIndex((s) => s.startsWith("end-"));
    const lastStart = order.map((s, i) => (s.startsWith("start-") ? i : -1)).filter((i) => i >= 0).pop();
    expect(firstEnd).toBeGreaterThan(lastStart ?? -1);  // tous les start avant le 1er end
  });
});
```

- [ ] **Step 2 : Lancer → FAIL** (sections non câblées, couverture vide).

- [ ] **Step 3 : Implémenter les 7 sections + assemblage**

Remplacer le corps de `panoramaImplantationComplet` après `resolveAnchor` par le câblage parallèle. Chaque section appelle sa brique (signatures Task 0) enveloppée dans `runSection`. PLM : si `anchor.plmMode`, les sous-appels `territoire`/densité basculent sur `code_dept` (cf. §4.5).

```typescript
  const { point, codeInsee, codeDept, rayonKm, plmMode } = anchor;
  const territoireKey = plmMode ? codeDept : codeInsee;

  const [territoire, demande, concurrents, pourvoyeurs, prescripteurs, cds, referentiels, freshness] =
    await Promise.all([
      runSection("territoire", () => panoramaSanteTerritoire({ codeInsee: territoireKey })),
      runSection("demande", async () => {
        const r = await getProfilIris({ point, rayonKm });
        if (!r.ok) throw new Error(r.reason ?? "profil_iris indisponible");
        return summariseDemande(r.value);   // résumé, pas brut (helper privé §52 spec)
      }),
      runSection("concurrents", () => sectionConcurrents(point, rayonKm)),
      runSection("pourvoyeurs", () => sectionPourvoyeurs(point, rayonKm)),
      runSection("prescripteurs", () => sectionPrescripteurs(point, rayonKm)),
      runSection("cds", () => sectionCds(point, rayonKm)),
      runSection("referentiels", () => sectionReferentiels(point, rayonKm)),
      runSection("freshness", () => getDataFreshness()),
    ]);

  const couverture: Record<string, SectionStatus> = {
    territoire: territoire.status, demande: demande.status, concurrents: concurrents.status,
    pourvoyeurs: pourvoyeurs.status, prescripteurs: prescripteurs.status,
    cds: cds.status, referentiels: referentiels.status,
  };
  // demande partielle FILOSOFI (§4.5) : remonter revenu_pct_population dans couverture.demande
  // si demande.data?.couverture présent (cf. summariseDemande).

  return {
    meta: { /* … comme Task 1, sources = labels dérivés de freshness.data */ },
    couverture,
    territoire: territoire.data, demande: demande.data, concurrents: concurrents.data,
    pourvoyeurs: pourvoyeurs.data, prescripteurs: prescripteurs.data,
    cds: cds.data, referentiels: referentiels.data,
  };
```

Implémenter les helpers privés `sectionConcurrents` / `sectionPourvoyeurs` / `sectionPrescripteurs` / `sectionCds` / `sectionReferentiels` / `summariseDemande` dans le même fichier. Chacun :
- appelle la/les brique(s) radius (signatures Task 0),
- renvoie un **résumé** (`count` + `top` N trié distance + `au_dela_count`), JAMAIS la liste brute (cap top-N, §3 + risque §11). Top-N suggéré : concurrents 10-15, pourvoyeurs top3/famille, prescripteurs top ~10 avec `precis_count`.
- `sectionConcurrents` : `getFinessInRadius({ center: point, radiusKm: rayonKm, familles: ["labo"] })`.
- `sectionPourvoyeurs` : 1 appel `familles: ["mco","ehpad","ssr","dialyse"]`, regroupé par famille via `finessFamille(code)` (`finess-categories.ts:284`).
- `sectionPrescripteurs` : `Promise.all([ getRppsInRadius({…, professionCodes:["10"], preciseOnly:false}), <brique IDEL Ameli spe=24> ])` → `{ mg:{count,precis_count,top}, idel:{…} }`. `precis_count` = nb résultats `geo_precision ∈ {adresse, etablissement_finess}`.
- `sectionCds` : brique CDS radius (Task 0). `liste` sans distance individuelle (centroïde commune, §4.5).
- `sectionReferentiels` : helper coverage FINESS↔SIRENE `naf=8690B` → `{ coverage_status, finess_only, sirene_only }`.

> Tous les sous-appels indépendants de `Promise.all` ci-dessus sont déjà parallèles ; à l'intérieur d'une section, paralléliser aussi (`sectionPrescripteurs`).

- [ ] **Step 4 : Lancer → vert** (adapter mocks aux signatures réelles).
Run: `pnpm vitest run src/sante/panorama-implantation.test.ts` → PASS.

- [ ] **Step 5 : `pnpm typecheck`** → zéro `any`, zéro erreur.

- [ ] **Step 6 : Commit**

```bash
git add src/sante/panorama-implantation.ts src/sante/panorama-implantation.test.ts
git commit -m "feat(panorama-implantation): 7 sections parallèles + couverture + résumés capés"
```

---

## Task 4 : Piège PLM — bascule code_dept testée

**Files :** Modify `src/sante/panorama-implantation.ts` (si non couvert Task 3), Test `…test.ts`.

- [ ] **Step 1 : Test rouge PLM**

```typescript
it("commune PLM (Paris arrondissement) → plm_mode=true + territoire sur code_dept", async () => {
  vi.spyOn(geocodeMod, "geocode").mockResolvedValue({
    point: { lat: 48.86, lon: 2.34 }, label: "Paris 1er", score: 0.97,
    confidence_low: false, codeCommune: "75101", commune: "Paris 1er", type: "housenumber",
  });
  const terrSpy = vi.spyOn(panoramaMod, "panoramaSanteTerritoire").mockResolvedValue({} as never);
  vi.spyOn(irisMod, "getProfilIris").mockResolvedValue({ ok: true, value: {} } as never);
  vi.spyOn(finessMod, "getFinessInRadius").mockResolvedValue({ count: 0, truncated: false, results: [] });
  const r = await panoramaImplantationComplet({ adresse: "Paris 1er" });
  expect(r.meta.plm_mode).toBe(true);
  expect(terrSpy).toHaveBeenCalledWith({ codeInsee: "75" });   // dept, pas 75101
});
```

- [ ] **Step 2 : Lancer → FAIL si la bascule n'est pas branchée.**
- [ ] **Step 3 : Vérifier/ajuster** que `territoireKey = plmMode ? codeDept : codeInsee` est bien utilisé (Task 3). Confirmer le comportement exact de `plmDept` (Task 0) — il peut renvoyer le dept ou un booléen ; adapter.
- [ ] **Step 4 : Lancer → vert.**
- [ ] **Step 5 : Commit**

```bash
git add src/sante/panorama-implantation.ts src/sante/panorama-implantation.test.ts
git commit -m "test(panorama-implantation): piège PLM — territoire bascule sur code_dept"
```

---

## Task 5 : Module `enrichir_concurrents`

**Files :**
- Create: `src/sante/enrichir-concurrents.ts`
- Test: `src/sante/enrichir-concurrents.test.ts`

- [ ] **Step 1 : Tests rouges (cap max, dégradation par concurrent, dedup)**

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import * as inspectMod from "./inspect-site.js";
import * as crossMod from "./cross-source.js";
import * as sirenMod from "./index.js";   // getEntrepriseBySiren — confirmer module Task 0
import { enrichirConcurrents } from "./enrichir-concurrents.js";

afterEach(() => vi.restoreAllMocks());

describe("enrichir_concurrents", () => {
  it("cap max=3 : 5 FINESS fournis → 3 enquêtés", async () => {
    const spy = vi.spyOn(inspectMod, "inspectSite").mockResolvedValue({ ok: true, value: {} } as never);
    vi.spyOn(crossMod, "compareRaisonSocialeFinessVsRpps").mockResolvedValue({ ok: true, value: {} } as never);
    const r = await enrichirConcurrents({ finess: ["1","2","3","4","5"], max: 3 });
    expect(r.concurrents).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("dedup FINESS dupliqués", async () => {
    vi.spyOn(inspectMod, "inspectSite").mockResolvedValue({ ok: true, value: {} } as never);
    vi.spyOn(crossMod, "compareRaisonSocialeFinessVsRpps").mockResolvedValue({ ok: true, value: {} } as never);
    const r = await enrichirConcurrents({ finess: ["1","1","2"] });
    expect(r.concurrents).toHaveLength(2);
  });

  it("un concurrent échoue → couverture:'partiel:…', les autres OK (pas de throw global)", async () => {
    vi.spyOn(inspectMod, "inspectSite").mockImplementation(async ({ numFiness }) => {
      if (numFiness === "2") throw new Error("inspect 500");
      return { ok: true, value: {} } as never;
    });
    vi.spyOn(crossMod, "compareRaisonSocialeFinessVsRpps").mockResolvedValue({ ok: true, value: {} } as never);
    const r = await enrichirConcurrents({ finess: ["1","2"] });
    expect(r.concurrents.find((c) => c.finess === "2")?.couverture).toMatch(/^partiel:/);
    expect(r.concurrents.find((c) => c.finess === "1")?.couverture).toBe("ok");
  });
});
```

- [ ] **Step 2 : Lancer → FAIL.**
Run: `pnpm vitest run src/sante/enrichir-concurrents.test.ts`

- [ ] **Step 3 : Implémenter** (boucle bornée parallèle, dégradation par concurrent §5.3)

```typescript
import { inspectSite } from "./inspect-site.js";
import { compareRaisonSocialeFinessVsRpps } from "./cross-source.js";
import { getEntrepriseBySiren } from "./index.js";   // confirmer Task 0

const LOG_TAG = "[france-data-mcp] enrichir_concurrents";

export interface EnrichirConcurrentsInput { finess: string[]; max?: number; }

export interface ConcurrentEnrichi {
  finess: string;
  raison_sociale: string | null;
  statut_actif: boolean | null;
  equipe_count: number | null;
  ma_signal: unknown | null;
  groupe: unknown | null;
  couverture: "ok" | `partiel:${string}`;
}

export interface EnrichirConcurrentsResult {
  concurrents: ConcurrentEnrichi[];
  meta: { sources: string[]; generated_at: string };
}

export async function enrichirConcurrents(
  input: EnrichirConcurrentsInput,
): Promise<EnrichirConcurrentsResult> {
  const max = input.max ?? 3;
  const unique = [...new Set(input.finess)].slice(0, max);   // dedup + cap dur

  const concurrents = await Promise.all(
    unique.map(async (finess): Promise<ConcurrentEnrichi> => {
      try {
        const [inspectR, compareR] = await Promise.all([
          inspectSite({ numFiness: finess, historiqueDetail: false }),
          compareRaisonSocialeFinessVsRpps(finess),
        ]);
        // SIREN dérivé d'inspectR (si présent) → groupe parent
        const siren = extractSiren(inspectR);   // helper privé tolérant null
        const groupe = siren ? await getEntrepriseBySiren(siren) : null;
        return mapConcurrent(finess, inspectR, compareR, groupe, "ok");
      } catch (err) {
        const raison = err instanceof Error ? err.message : String(err);
        console.warn(`${LOG_TAG}: concurrent ${finess} partiel — ${raison}`);
        return {
          finess, raison_sociale: null, statut_actif: null, equipe_count: null,
          ma_signal: null, groupe: null, couverture: `partiel:${raison}`,
        };
      }
    }),
  );

  return { concurrents, meta: { sources: ["FINESS/ANS", "RPPS/ANS", "SIRENE/DINUM"], generated_at: new Date().toISOString() } };
}
```

Implémenter `extractSiren` et `mapConcurrent` (privés) selon les formes réelles d'`InspectSiteResult` / compare / `Entreprise` (Task 0). `equipe_count` = `inspectR.value.professionnels.count`.

- [ ] **Step 4 : Lancer → vert.**
- [ ] **Step 5 : `pnpm typecheck`.**
- [ ] **Step 6 : Commit**

```bash
git add src/sante/enrichir-concurrents.ts src/sante/enrichir-concurrents.test.ts
git commit -m "feat(enrichir-concurrents): boucle bornée max=3 + dégradation par concurrent"
```

---

## Task 6 : Câbler les 2 outils dans `api/tools.ts`

**Files :**
- Modify: `api/tools.ts`
- Test: `api/tools.test.ts`

- [ ] **Step 1 : Tests d'intégration rouges**

```typescript
import * as panoImpl from "../src/sante/panorama-implantation.js";
import * as enrich from "../src/sante/enrichir-concurrents.js";

describe("panorama_implantation_complet (MCP tool)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("handler délègue à panoramaImplantationComplet avec adresse+rayon", async () => {
    const spy = vi.spyOn(panoImpl, "panoramaImplantationComplet")
      .mockResolvedValue({ meta: {}, couverture: {} } as never);
    const tool = findTool("panorama_implantation_complet");
    await tool?.handler({ adresse: "Lille rue Nationale", rayon_km: 5 });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ adresse: "Lille rue Nationale", rayonKm: 5 }));
  });

  it("ancrage KO → RangeError propagée (=> -32602 côté MCP)", async () => {
    vi.spyOn(panoImpl, "panoramaImplantationComplet").mockRejectedValue(new RangeError("ancrage"));
    const tool = findTool("panorama_implantation_complet");
    await expect(tool?.handler({ adresse: "x" })).rejects.toThrow(RangeError);
  });
});

describe("enrichir_concurrents (MCP tool)", () => {
  it("handler délègue avec finess[] + max", async () => {
    const spy = vi.spyOn(enrich, "enrichirConcurrents").mockResolvedValue({ concurrents: [] } as never);
    const tool = findTool("enrichir_concurrents");
    await tool?.handler({ finess: ["590000123"], max: 3 });
    expect(spy).toHaveBeenCalledWith({ finess: ["590000123"], max: 3 });
  });
});
```

- [ ] **Step 2 : Lancer → FAIL** (`findTool` renvoie undefined).
Run: `pnpm vitest run api/tools.test.ts -t panorama_implantation_complet`

- [ ] **Step 3 : Ajouter les 2 défs dans le tableau `TOOLS`** (pattern `McpTool`, descriptions riches : sections renvoyées, drapeaux `couverture`, doctrine de dégradation, **quand préférer l'outil unitaire**). Handlers : `normalizeAliases` (adresse/point/rayon_km→rayonKm), validation entrée, délégation. Importer les modules en tête.

```typescript
import { panoramaImplantationComplet } from "../src/sante/panorama-implantation.js";
import { enrichirConcurrents } from "../src/sante/enrichir-concurrents.js";

// … dans TOOLS:
{
  name: "panorama_implantation_complet",
  description: `Étude d'implantation labo en 1 appel (V0.23). Géocode l'adresse puis agrège EN PARALLÈLE 7 sections : territoire (densités commune), demande (bassin IRIS rayon), concurrents (labos), pourvoyeurs (MCO/EHPAD/SSR/dialyse), prescripteurs (MG+IDEL), cds, referentiels. Renvoie des RÉSUMÉS (count/top-N), pas de listes brutes. Chaque section porte un drapeau 'couverture' ('ok' | 'partiel:…' | 'indisponible:…') : si une source est down, la section est flaggée et le RESTE est renvoyé — comble alors le trou via l'outil unitaire correspondant. Échec d'ancrage (géocode/insee) = rejet total. Préfère cet outil pour DÉMARRER une étude ; creuse ensuite au besoin via les unitaires + enrichir_concurrents sur le top 3.`,
  inputSchema: {
    type: "object",
    properties: {
      adresse: { type: "string", description: "Adresse cible (géocodée IGN). XOR avec point." },
      point: { type: "object", description: "{lat,lon} si déjà connu (skip géocodage)." },
      rayon_km: { type: "number", description: "Rayon du bassin. Défaut 5." },
    },
  },
  annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
  handler: async (rawArgs) => {
    const args = normalizeAliases(rawArgs, { rayonKm: "rayon_km" });
    const adresse = asString(args.adresse);
    const point = args.point as { lat: number; lon: number } | undefined;
    const rayonKm = args.rayon_km !== undefined ? coerceNumber(args.rayon_km, "rayon_km") : undefined;
    return panoramaImplantationComplet({
      ...(adresse ? { adresse } : {}),
      ...(point ? { point } : {}),
      ...(rayonKm !== undefined ? { rayonKm } : {}),
    });
  },
},
{
  name: "enrichir_concurrents",
  description: `Enquête approfondie sur le top concurrents (V0.23). Pour chaque FINESS : statut + équipe + historique (inspect_site), signal M&A (compare raison sociale FINESS vs RPPS), groupe parent (entreprise_by_siren). Cap dur max=3 (inspect_site ~7K tokens/appel). Drapeau 'couverture' par concurrent. Typiquement appelé sur concurrents.top[0..2] renvoyés par panorama_implantation_complet.`,
  inputSchema: {
    type: "object",
    properties: {
      finess: { type: "array", items: { type: "string" }, description: "FINESS à enquêter (top 3 concurrents)." },
      max: { type: "number", description: "Cap dur. Défaut 3." },
    },
    required: ["finess"],
  },
  annotations: READ_ONLY_IDEMPOTENT_ANNOTATIONS,
  handler: async (rawArgs) => {
    const finess = (rawArgs.finess as unknown[] ?? []).map((f) => asString(f)).filter(Boolean) as string[];
    if (finess.length === 0) throw new RangeError("enrichir_concurrents: 'finess' (string[]) requis et non vide");
    const max = rawArgs.max !== undefined ? coerceNumber(rawArgs.max, "max") : undefined;
    return enrichirConcurrents({ finess, ...(max !== undefined ? { max } : {}) });
  },
},
```

- [ ] **Step 4 : Lancer → vert.**
Run: `pnpm vitest run api/tools.test.ts -t "panorama_implantation_complet|enrichir_concurrents"`

- [ ] **Step 5 : Suite complète + typecheck**
Run: `pnpm vitest run && pnpm typecheck` → tout vert.

- [ ] **Step 6 : Commit**

```bash
git add api/tools.ts api/tools.test.ts
git commit -m "feat(tools): exposer panorama_implantation_complet + enrichir_concurrents (34 tools)"
```

---

## Task 7 : Version bump + CHANGELOG

**Files :** Modify `package.json:4`, `CHANGELOG.md`.

- [ ] **Step 1 : Bump version** `0.22.0` → `0.23.0` (`package.json`).
- [ ] **Step 2 : Entrée CHANGELOG**

```markdown
## v0.23.0 — Panoramas composites (2026-05-28)

### New Tools (additif — zéro breaking, 32 → 34 tools)
- `panorama_implantation_complet(adresse|point, rayon_km=5)` — étude d'implantation en 1 appel : 7 sections agrégées en parallèle (territoire, demande bassin IRIS, concurrents, pourvoyeurs, prescripteurs, cds, referentiels). Résumés capés + drapeau `couverture` par section (dégradation non silencieuse). Échec d'ancrage = rejet total `-32602`.
- `enrichir_concurrents(finess[], max=3)` — enquête top 3 concurrents (inspect_site + compare FINESS/RPPS + entreprise_by_siren).

Objectif : collapse étude `/conversation` ~15 round-trips connecteur → ~2.
Sources : DREES (FINESS), ANS (RPPS), CNAM (Ameli/CDS), INSEE/FILOSOFI, DINUM (SIRENE), IGN.
```

- [ ] **Step 3 : Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): 0.23.0 — panoramas composites"
```

---

## Task 8 : Revue + preuve d'acceptation

- [ ] **Step 1 : Pipeline `/review`** (simplify + Code-Reviewer + Silent Failure Hunter). Corriger PENDANT la revue, jamais après. Cibler les fichiers créés/modifiés.
- [ ] **Step 2 : Preuve d'acceptation prod** (après merge/deploy MANUEL validé par Cyril) :
  - `panorama_implantation_complet("Lille rue Nationale", 5)` < 5 s server-side, payload complet, tous drapeaux `couverture`.
  - Mock/observer une source down → section `indisponible`, le reste OK.
  - `enrichir_concurrents(top3)` < 5 s.
- [ ] **Step 3 : Handoff** : signaler à Cyril « C prête, en attente merge/deploy manuel ». NE PAS merger ni déployer (repo santé sensible, §5 handoff).

---

## Self-Review (couverture spec)

- §4.1 entrée (adresse|point, rayon_km) → Task 1+6 ✅
- §4.2 sortie (meta, couverture, 7 sections) → Task 1+3 ✅
- §4.3 mapping section→brique → Task 0 (grounding) + Task 3 ✅
- §4.4 dégradation (ancrage=rejet total, section=drapeau) → Task 1 (ancrage) + Task 2 (runSection) + Task 3 (test section down) ✅
- §4.5 pièges (PLM, geo_precision/precis_count, Ameli≠ANS, FILOSOFI couverture) → Task 3 + Task 4 (PLM) ✅
- §5 enrichir_concurrents (cap, dégradation, 3 briques) → Task 5 ✅
- §7 fichiers (2 modules + tools + tests, aucune migration) → couvert ✅
- §9 méthodo preuve (TDD + acceptation prod) → Task 8 ✅
- **Gap noté** : `precis_count` (geo_precision) et la remontée FILOSOFI dans `couverture.demande` méritent un test dédié — ajouter en Task 3 Step 1 si le temps le permet (sinon vérifié à l'acceptation prod).
