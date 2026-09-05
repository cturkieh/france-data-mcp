import { afterEach, describe, expect, it, vi } from "vitest";
import { type GeocodedCacheRow, hasGateFields, isStaleRejection } from "./geocoded-cache-row.js";

// Règle « rejet PÉRIMÉ » (cf. module) : options = seuil courant 0,5 + plafond
// BAN_MAX_ATTEMPTS + 1 = 4 (une ré-soumission au-delà du cap, puis plus jamais).
const OPTS = { scoreThreshold: 0.5, resubmitCap: 4 };
const row = (over: Partial<GeocodedCacheRow>): GeocodedCacheRow => ({
  address_key: "1 RUE TEST|75001|75101",
  accepted: false,
  ban_attempt_count: 3,
  ban_last_status: "rejected_low_score",
  result_score: 0.62,
  result_type: "housenumber",
  ...over,
});

describe("isStaleRejection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("périmé : rejected_low_score au cap, score ≥ seuil courant, type précis → true", () => {
    expect(isStaleRejection(row({}), OPTS)).toBe(true);
    expect(isStaleRejection(row({ result_type: "street", result_score: 0.5 }), OPTS)).toBe(true);
    expect(isStaleRejection(row({ result_type: "locality" }), OPTS)).toBe(true);
  });

  it("non périmé : accepté, statut ≠ rejected_low_score, score < seuil, type municipality/null, au plafond", () => {
    expect(isStaleRejection(row({ accepted: true }), OPTS)).toBe(false);
    expect(isStaleRejection(row({ ban_last_status: "unresolved", result_score: null }), OPTS)).toBe(
      false,
    );
    expect(isStaleRejection(row({ result_score: 0.49 }), OPTS)).toBe(false);
    expect(isStaleRejection(row({ result_type: "municipality", result_score: 0.9 }), OPTS)).toBe(
      false,
    );
    expect(isStaleRejection(row({ result_type: null }), OPTS)).toBe(false);
    expect(isStaleRejection(row({ ban_attempt_count: 4 }), OPTS)).toBe(false);
  });

  it("défense boundary : score en string coercé ; type en casse mixte normalisé", () => {
    expect(isStaleRejection(row({ result_score: "0.62" }), OPTS)).toBe(true);
    expect(isStaleRejection(row({ result_type: " Housenumber " }), OPTS)).toBe(true);
  });

  it("score null → false SANS warn (absence légitime) ; score illisible → false + warn (jamais Number(null)=0 accepté)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(isStaleRejection(row({ result_score: null }), { ...OPTS, scoreThreshold: 0 })).toBe(
      false,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(isStaleRejection(row({ result_score: "N/A" }), OPTS)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("result_score illisible"));
  });

  it("ban_attempt_count illisible (champ absent) → false + warn — sinon `undefined < cap` re-soumettrait à l'infini", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = row({});
    // @ts-expect-error simulation d'une réponse RPC sans le champ
    r.ban_attempt_count = undefined;
    expect(isStaleRejection(r, OPTS)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ban_attempt_count illisible"));
  });
});

describe("hasGateFields", () => {
  it("vrai avec les 3 champs (même null), faux sur une ligne pré-migration", () => {
    expect(
      hasGateFields(row({ result_score: null, result_type: null, ban_last_status: null })),
    ).toBe(true);
    expect(hasGateFields({ address_key: "k", accepted: false, ban_attempt_count: 3 })).toBe(false);
  });
});
