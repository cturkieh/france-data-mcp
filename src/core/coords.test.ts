import { describe, expect, it } from "vitest";
import { parseCoordinates } from "./coords.js";

describe("parseCoordinates", () => {
  it("renvoie un Coordinates pour des nombres finis", () => {
    expect(parseCoordinates(2.3522, 48.8566)).toEqual({ lon: 2.3522, lat: 48.8566 });
  });

  it("renvoie un Coordinates pour des strings ASCII avec point décimal (DINUM)", () => {
    expect(parseCoordinates("2.3522", "48.8566")).toEqual({ lon: 2.3522, lat: 48.8566 });
  });

  it("renvoie un Coordinates pour des strings FR avec virgule décimale (FINESS CSV)", () => {
    expect(parseCoordinates("2,3522", "48,8566")).toEqual({ lon: 2.3522, lat: 48.8566 });
  });

  it("renvoie undefined si un seul des deux est undefined", () => {
    expect(parseCoordinates(2.3522, undefined)).toBeUndefined();
    expect(parseCoordinates(undefined, 48.8566)).toBeUndefined();
  });

  // Régression : l'API DINUM renvoie `null` (pas `undefined`) pour les
  // sites sans géocodage SIRENE. Sans le garde `value == null`,
  // `null.replace(",", ".")` crash avec
  // `Cannot read properties of null (reading 'replace')`.
  it("renvoie undefined si une coord est null (cas DINUM longitude/latitude absentes)", () => {
    expect(parseCoordinates(null, 48.8566)).toBeUndefined();
    expect(parseCoordinates(2.3522, null)).toBeUndefined();
    expect(parseCoordinates(null, null)).toBeUndefined();
  });

  it("renvoie undefined si une coord est NaN ou Infinity (number non finite)", () => {
    expect(parseCoordinates(Number.NaN, 48.8566)).toBeUndefined();
    expect(parseCoordinates(Number.POSITIVE_INFINITY, 48.8566)).toBeUndefined();
  });

  it("renvoie undefined si une coord est une string non parseable", () => {
    expect(parseCoordinates("abc", "48.8566")).toBeUndefined();
    expect(parseCoordinates("", "48.8566")).toBeUndefined();
  });

  it("accepte les coords mixtes string + number", () => {
    expect(parseCoordinates("2,3522", 48.8566)).toEqual({ lon: 2.3522, lat: 48.8566 });
  });
});
