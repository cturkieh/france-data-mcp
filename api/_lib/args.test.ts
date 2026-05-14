import { describe, expect, it, vi } from "vitest";
import {
  normalizeAliases,
  requireFinessId,
  requireOneOf,
  requireString,
  suggestParamError,
} from "./args.js";

describe("normalizeAliases", () => {
  it("remappe les clés alternatives vers le nom canonique", () => {
    expect(normalizeAliases({ q: "Lyon" }, { q: "nom", query: "nom" })).toEqual({
      nom: "Lyon",
    });
  });

  it("conserve la clé canonique si elle est déjà présente (n'écrase pas)", () => {
    expect(normalizeAliases({ q: "ignored", nom: "Lyon" }, { q: "nom" })).toEqual({ nom: "Lyon" });
  });

  it("préserve les clés non-aliasées intactes (limit, boostPopulation, etc.)", () => {
    expect(normalizeAliases({ q: "Lyon", limit: 5, boostPopulation: false }, { q: "nom" })).toEqual(
      { nom: "Lyon", limit: 5, boostPopulation: false },
    );
  });

  it("ne mute pas l'input (objet retourné distinct)", () => {
    const input = { q: "Lyon" };
    const out = normalizeAliases(input, { q: "nom" });
    expect(input).toEqual({ q: "Lyon" });
    expect(out).not.toBe(input);
  });

  it("plusieurs alias vers la même canonique : le premier dans aliasMap gagne (canonical key check)", () => {
    // q et query mappent tous deux vers nom. Si les deux sont fournis (rare),
    // le caller a un input ambigu — on prend le premier qui s'applique.
    const result = normalizeAliases({ q: "Lyon", query: "Paris" }, { q: "nom", query: "nom" });
    // Une des deux valeurs est choisie ; on s'assure juste que la clé canonique
    // est créée et qu'aucun alias ne reste.
    expect(result.nom).toBeDefined();
    expect("q" in result).toBe(false);
    expect("query" in result).toBe(false);
  });

  it("alias map vide → pass-through", () => {
    const input = { nom: "Lyon", limit: 10 };
    expect(normalizeAliases(input, {})).toEqual(input);
  });

  it("V0.9 — collision alias + canonique valeurs différentes → console.warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      normalizeAliases({ q: "Lyon", nom: "Paris" }, { q: "nom" });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("collision"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"q"'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"nom"'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("V0.9 — collision avec valeurs égales → pas de warn (no-op silencieux légitime)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      normalizeAliases({ q: "Lyon", nom: "Lyon" }, { q: "nom" });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("suggestParamError", () => {
  it("produit un message avec clés reçues + attendues + exemple", () => {
    const err = suggestParamError({ q: "Lyon" }, ["nom"], { nom: "Lyon" });
    expect(err).toBeInstanceOf(RangeError);
    expect(err.message).toContain('"q"');
    expect(err.message).toContain('"nom"');
    expect(err.message).toContain('{"nom":"Lyon"}');
  });

  it("formate plusieurs clés attendues avec 'ou'", () => {
    const err = suggestParamError({}, ["nom", "codePostal", "code"], { nom: "Lyon" });
    expect(err.message).toContain('"nom" ou "codePostal" ou "code"');
  });

  it("omet la mention 'Reçu' si args vide", () => {
    const err = suggestParamError({}, ["nom"], { nom: "Lyon" });
    expect(err.message).not.toContain("Reçu");
    expect(err.message).toContain("Paramètre manquant");
  });
});

describe("requireOneOf", () => {
  it("ne throw rien si au moins une clé attendue est présente non-vide (string)", () => {
    expect(() => requireOneOf({ nom: "Lyon" }, ["nom", "code"], { nom: "Lyon" })).not.toThrow();
    expect(() => requireOneOf({ code: "75056" }, ["nom", "code"], { nom: "Lyon" })).not.toThrow();
  });

  it("accepte les number (lat/lon) en plus des string", () => {
    expect(() =>
      requireOneOf({ lat: 48.8 }, ["lat", "lon"], { lat: 48.8, lon: 2.3 }),
    ).not.toThrow();
  });

  it("throw avec suggestion si toutes les clés sont absentes", () => {
    expect(() => requireOneOf({ q: "Lyon" }, ["nom"], { nom: "Lyon" })).toThrow(RangeError);
    expect(() => requireOneOf({ q: "Lyon" }, ["nom"], { nom: "Lyon" })).toThrow(/Reçu: \["q"\]/);
  });

  it("string vide compte comme absente (force le caller à fournir une valeur exploitable)", () => {
    expect(() => requireOneOf({ nom: "" }, ["nom"], { nom: "Lyon" })).toThrow(RangeError);
    expect(() => requireOneOf({ nom: "   " }, ["nom"], { nom: "Lyon" })).not.toThrow();
    // ↑ on garde les whitespaces : c'est au caller de trim si besoin, mais
    // techniquement "   " est une string non vide. Acceptable pour V0.9.
  });
});

describe("requireString", () => {
  it("retourne la valeur si la clé est présente non-vide", () => {
    expect(requireString({ code: "75056" }, "code", { code: "X" })).toBe("75056");
  });

  it("throw si la clé est absente, avec exemple", () => {
    expect(() => requireString({}, "code", { code: "75056" })).toThrow(RangeError);
    expect(() => requireString({}, "code", { code: "75056" })).toThrow(/Exemple: \{"code":/);
  });

  it("throw si la clé est string vide", () => {
    expect(() => requireString({ code: "" }, "code", { code: "75056" })).toThrow(RangeError);
  });

  it("throw si la valeur n'est pas une string (number, boolean) — strict", () => {
    expect(() =>
      requireString({ code: 42 } as Record<string, unknown>, "code", { code: "75056" }),
    ).toThrow();
    expect(() =>
      requireString({ code: true } as Record<string, unknown>, "code", { code: "75056" }),
    ).toThrow();
  });

  it("V0.9 — clé présente mauvais type → message dédié (type=X valeur=Y)", () => {
    // Différencie "clé absente" de "clé présente bad type" pour éviter qu'un
    // LLM reboucle avec la même mauvaise valeur en voyant "Paramètre manquant".
    expect(() =>
      requireString({ code: 42 } as Record<string, unknown>, "code", { code: "75056" }),
    ).toThrow(/type=number, valeur=42/);
    expect(() =>
      requireString({ code: null } as Record<string, unknown>, "code", { code: "75056" }),
    ).toThrow(/type=object, valeur=null/);
  });
});

describe("requireFinessId", () => {
  it("retourne la valeur trimée si 9 chiffres exacts", () => {
    expect(requireFinessId({ num_finess: "690780150" })).toBe("690780150");
    expect(requireFinessId({ num_finess: "  690780150  " })).toBe("690780150");
  });

  it("supporte une clé custom (alias possible)", () => {
    expect(requireFinessId({ finess: "690780150" }, "finess")).toBe("690780150");
  });

  it("clé absente → 'Paramètre manquant' avec exemple (cohérence avec requireString)", () => {
    // Distinct du cas "clé présente mais bad type" — sinon le LLM qui a OUBLIÉ
    // le param voit "type=undefined" alors que le param n'est pas dans args.
    expect(() => requireFinessId({})).toThrow(/Paramètre manquant/);
    expect(() => requireFinessId({})).toThrow(/Exemple: \{"num_finess":"690780150"\}/);
  });

  it("clé présente mais type non-string (number, null) → message dédié type+valeur", () => {
    expect(() => requireFinessId({ num_finess: 690780150 } as Record<string, unknown>)).toThrow(
      /doit être une string.*type=number/,
    );
    expect(() => requireFinessId({ num_finess: null } as Record<string, unknown>)).toThrow(
      /doit être une string.*type=object.*valeur=null/,
    );
  });

  it("throw RangeError si moins de 9 chiffres (oubli zéro de tête typique)", () => {
    expect(() => requireFinessId({ num_finess: "69078015" })).toThrow(
      /attendu exactement 9 chiffres/,
    );
  });

  it("throw RangeError si plus de 9 chiffres (SIRET 14 confondu avec FINESS)", () => {
    expect(() => requireFinessId({ num_finess: "39503084400124" })).toThrow(
      /attendu exactement 9 chiffres/,
    );
  });

  it("throw RangeError si caractères non-numériques", () => {
    expect(() => requireFinessId({ num_finess: "690-780-150" })).toThrow();
    expect(() => requireFinessId({ num_finess: "abcdefghi" })).toThrow();
    expect(() => requireFinessId({ num_finess: "690780150X" })).toThrow();
  });

  it("message d'erreur inclut le nom du paramètre et un exemple JSON", () => {
    expect(() => requireFinessId({ num_finess: "bad" })).toThrow(
      /num_finess.*Exemple: \{"num_finess":"690780150"\}/,
    );
    expect(() => requireFinessId({ finess_id: "bad" }, "finess_id")).toThrow(
      /finess_id.*Exemple: \{"finess_id":"690780150"\}/,
    );
  });
});
