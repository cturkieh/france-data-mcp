import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock supabase au niveau module (jumeau de rpps-db.test.ts) : sinon le guard
// appellerait getUntypedAnonClient qui throw Error (pas RangeError) quand
// SUPABASE_URL est absent en env de test → les acceptations passeraient par
// tautologie. Le mock retourne data:[] par défaut (aucun code inconnu = OK).
const mockRpc = vi.fn().mockResolvedValue({ data: [], error: null });
vi.mock("../storage/supabase.js", () => ({
  getUntypedAnonClient: () => ({ rpc: mockRpc }),
}));

import {
  assertKnownAmeliSpecialiteCodes,
  assertKnownCdsSpecialiteCodes,
} from "./specialite-nomenclature-guard.js";

describe("assertKnownAmeliSpecialiteCodes (garde-fou nomenclature Ameli — jumeau ANS dette #1)", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("no-op (aucun appel RPC) quand aucun code fourni", async () => {
    await expect(assertKnownAmeliSpecialiteCodes(undefined)).resolves.toBeUndefined();
    await expect(assertKnownAmeliSpecialiteCodes([])).resolves.toBeUndefined();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("appelle ameli_specialite_codes_unknown avec les codes fournis", async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    await assertKnownAmeliSpecialiteCodes(["03", "01"]);
    expect(mockRpc).toHaveBeenCalledWith("ameli_specialite_codes_unknown", {
      p_codes: ["03", "01"],
    });
  });

  it("résout sans erreur quand tous les codes sont connus (RPC renvoie 0 inconnu)", async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(assertKnownAmeliSpecialiteCodes(["03"])).resolves.toBeUndefined();
  });

  it("RangeError (mappe JSON-RPC -32602) quand un code est inconnu", async () => {
    mockRpc.mockResolvedValueOnce({ data: [{ unknown_code: "SM04" }], error: null });
    await expect(assertKnownAmeliSpecialiteCodes(["SM04"])).rejects.toBeInstanceOf(RangeError);
  });

  it("le message liste le(s) code(s) inconnu(s) ET cross-pointe lister_nomenclature (Niveau 2)", async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ unknown_code: "SM04" }, { unknown_code: "999" }],
      error: null,
    });
    const err = await assertKnownAmeliSpecialiteCodes(["SM04", "03", "999"]).catch((e) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect(err.message).toContain("'SM04'");
    expect(err.message).toContain("'999'");
    expect(err.message).toContain("lister_nomenclature");
    expect(err.message).toMatch(/ANS|profession_code|savoir_faire/);
  });

  it("Error (pas RangeError) si la RPC échoue — distinct d'un input invalide", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const err = await assertKnownAmeliSpecialiteCodes(["03"]).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RangeError);
  });
});

describe("assertKnownCdsSpecialiteCodes (garde-fou nomenclature CDS — Annexe A CNAM)", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("no-op (aucun appel RPC) quand aucun code fourni", async () => {
    await expect(assertKnownCdsSpecialiteCodes(undefined)).resolves.toBeUndefined();
    await expect(assertKnownCdsSpecialiteCodes([])).resolves.toBeUndefined();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("appelle centres_sante_specialite_codes_unknown (source CDS, PAS la matview Ameli)", async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    await assertKnownCdsSpecialiteCodes(["01", "53"]);
    expect(mockRpc).toHaveBeenCalledWith("centres_sante_specialite_codes_unknown", {
      p_codes: ["01", "53"],
    });
  });

  it("résout sans erreur quand tous les codes sont connus", async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(assertKnownCdsSpecialiteCodes(["01"])).resolves.toBeUndefined();
  });

  it("RangeError quand un code est inconnu, message Annexe A + anti-confusion ANS", async () => {
    mockRpc.mockResolvedValueOnce({ data: [{ unknown_code: "SM04" }], error: null });
    const err = await assertKnownCdsSpecialiteCodes(["SM04"]).catch((e) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect(err.message).toContain("'SM04'");
    expect(err.message).toMatch(/Annexe A/i);
    expect(err.message).toMatch(/ANS|savoir_faire/);
  });

  it("Error (pas RangeError) si la RPC échoue", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const err = await assertKnownCdsSpecialiteCodes(["01"]).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RangeError);
  });
});
