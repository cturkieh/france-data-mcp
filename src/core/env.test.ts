import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readApiKeyEnv } from "./env.js";

const VAR = "__TEST_API_KEY";

describe("readApiKeyEnv", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[VAR];
    delete process.env[VAR];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[VAR];
    else process.env[VAR] = original;
  });

  it("retourne null si var absente", () => {
    expect(readApiKeyEnv(VAR)).toBeNull();
  });

  it("retourne null si var vide", () => {
    process.env[VAR] = "";
    expect(readApiKeyEnv(VAR)).toBeNull();
  });

  it("retourne null après cleanup si var contient uniquement whitespace ou quotes vides", () => {
    process.env[VAR] = "   ";
    expect(readApiKeyEnv(VAR)).toBeNull();
    process.env[VAR] = '""';
    expect(readApiKeyEnv(VAR)).toBeNull();
    process.env[VAR] = "''";
    expect(readApiKeyEnv(VAR)).toBeNull();
  });

  it("trim espaces entourants", () => {
    process.env[VAR] = "  abc-uuid  ";
    expect(readApiKeyEnv(VAR)).toBe("abc-uuid");
  });

  it('strippe quotes doubles entourantes ("xxx")', () => {
    process.env[VAR] = '"abc-uuid"';
    expect(readApiKeyEnv(VAR)).toBe("abc-uuid");
  });

  it("strippe quotes simples entourantes ('xxx')", () => {
    process.env[VAR] = "'abc-uuid'";
    expect(readApiKeyEnv(VAR)).toBe("abc-uuid");
  });

  it("conserve les quotes internes (sécurité : on touche aux délimiteurs seulement)", () => {
    process.env[VAR] = 'abc"middle"end';
    expect(readApiKeyEnv(VAR)).toBe('abc"middle"end');
  });
});
