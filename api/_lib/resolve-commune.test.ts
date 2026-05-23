import { afterEach, describe, expect, it, vi } from "vitest";
import * as communes from "../../src/territoire/communes.js";
import { resolveNomCommune } from "./resolve-commune.js";

/**
 * Mock `searchCommunes` qui simule le filtre dept natif de l'API : si la query
 * passe `codeDepartement`, on filtre la liste mockée par ce champ AVANT de
 * retourner — comme le ferait `geo.api.gouv.fr`. La 2ème requête (fallback
 * sans dept) reçoit la liste complète.
 */
function mockSearch(list: Partial<communes.Commune>[]) {
  const full = list.map(
    (c) =>
      ({
        code: c.code ?? "",
        nom: c.nom ?? "",
        codesPostaux: c.codesPostaux ?? [],
        ...(c.codeDepartement !== undefined ? { codeDepartement: c.codeDepartement } : {}),
        ...(c.population !== undefined ? { population: c.population } : {}),
      }) as communes.Commune,
  );
  return vi.spyOn(communes, "searchCommunes").mockImplementation(async (opts) => {
    if (opts.codeDepartement) {
      return full.filter((c) => c.codeDepartement === opts.codeDepartement);
    }
    return full;
  });
}

afterEach(() => vi.restoreAllMocks());

describe("resolveNomCommune", () => {
  it("Cas 1 — 1 match unique → resolved: true", async () => {
    mockSearch([{ code: "59350", nom: "Lille", codeDepartement: "59", population: 238246 }]);
    const result = await resolveNomCommune({ nom: "Lille" });
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.commune.code).toBe("59350");
  });

  it("Cas 2 — N matches → ambiguous_commune avec candidates", async () => {
    mockSearch([
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
    } else {
      throw new Error("expected ambiguous_commune");
    }
  });

  it("Cas 3 — nom + dept, 0 dans dept mais N ailleurs → commune_not_in_department", async () => {
    mockSearch([
      { code: "97801", nom: "Saint-Martin", codeDepartement: "978", population: 31160 },
      { code: "65392", nom: "Saint-Martin", codeDepartement: "65", population: 436 },
    ]);
    const result = await resolveNomCommune({ nom: "Saint-Martin", departement: "08" });
    expect(result.resolved).toBe(false);
    if (!result.resolved && result.error.kind === "commune_not_in_department") {
      expect(result.error.matches_in_other_dept).toHaveLength(2);
      expect(result.error.input.departement).toBe("08");
    } else {
      throw new Error("expected commune_not_in_department");
    }
  });

  it("Cas 4 — nom + dept, 1 match dans dept → resolved: true", async () => {
    mockSearch([
      { code: "65392", nom: "Saint-Martin", codeDepartement: "65", population: 436 },
      { code: "97801", nom: "Saint-Martin", codeDepartement: "978", population: 31160 },
    ]);
    const result = await resolveNomCommune({ nom: "Saint-Martin", departement: "65" });
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.commune.code).toBe("65392");
  });

  it("Cas 5 — nom inexistant → unknown_commune", async () => {
    mockSearch([]);
    const result = await resolveNomCommune({ nom: "ZZZINEXISTANT" });
    expect(result.resolved).toBe(false);
    if (!result.resolved) expect(result.error.kind).toBe("unknown_commune");
  });

  it("Cas 6 — abréviation (St-Martin) → unknown_commune avec hint pédagogique", async () => {
    mockSearch([]); // API geo.api.gouv.fr renvoie 0 pour St-Martin (testé live 2026-05-23)
    const result = await resolveNomCommune({ nom: "St-Martin" });
    expect(result.resolved).toBe(false);
    if (!result.resolved && result.error.kind === "unknown_commune") {
      expect(result.error.hint).toMatch(/officiel|Saint/i);
    } else {
      throw new Error("expected unknown_commune");
    }
  });

  it("Cas 7 — casse différente (lille) → resolved (case-insensitive)", async () => {
    mockSearch([{ code: "59350", nom: "Lille", codeDepartement: "59", population: 238246 }]);
    const result = await resolveNomCommune({ nom: "lille" });
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.commune.code).toBe("59350");
  });

  it("Cas 8 — accents (Saint-Etienne sans accent) → resolved (NFD normalisation)", async () => {
    // L'API gère les accents nativement : nom canonique retourné = Saint-Étienne.
    // Le filtre exact post-API doit normaliser NFD pour matcher l'input sans accent.
    mockSearch([
      { code: "42218", nom: "Saint-Étienne", codeDepartement: "42", population: 173136 },
    ]);
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
    mockSearch(list);
    const result = await resolveNomCommune({ nom: "Saint-Martin" });
    if (!result.resolved && result.error.kind === "ambiguous_commune") {
      expect(result.error.total_matches).toBe(12);
      expect(result.error.candidates).toHaveLength(10);
      expect(result.error.truncated).toBe(true);
    } else {
      throw new Error("expected ambiguous_commune");
    }
  });

  it("Garde — input vide (whitespace) → unknown_commune défensif sans appel API", async () => {
    const spy = mockSearch([]);
    const result = await resolveNomCommune({ nom: "   " });
    expect(result.resolved).toBe(false);
    if (!result.resolved) expect(result.error.kind).toBe("unknown_commune");
    expect(spy).not.toHaveBeenCalled();
  });

  it("Garde — filtre exact élimine le bruit fuzzy (Mont-Saint-Martin ne matche pas Saint-Martin)", async () => {
    mockSearch([
      { code: "08308", nom: "Mont-Saint-Martin", codeDepartement: "08", population: 88 },
      { code: "08209", nom: "Hannogne-Saint-Martin", codeDepartement: "08", population: 445 },
    ]);
    // 0 match exact dans dept → fallback global → 0 match exact global → unknown_commune.
    const result = await resolveNomCommune({ nom: "Saint-Martin", departement: "08" });
    expect(result.resolved).toBe(false);
    if (!result.resolved) expect(result.error.kind).toBe("unknown_commune");
  });
});
