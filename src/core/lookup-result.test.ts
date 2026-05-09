import { describe, expect, it } from "vitest";
import { type LookupResult, lookupFound, lookupNotFound } from "./lookup-result.js";

interface DemoEntity {
  id: string;
  label: string;
}

describe("lookupFound", () => {
  it("ajoute le discriminant found:true et lookupStatus:found", () => {
    const out = lookupFound<DemoEntity>({ id: "abc", label: "demo" });
    expect(out.found).toBe(true);
    expect(out.lookupStatus).toBe("found");
    expect(out.id).toBe("abc");
    expect(out.label).toBe("demo");
  });
});

describe("lookupNotFound", () => {
  it("produit un résultat not_found par défaut", () => {
    const out = lookupNotFound("123", "introuvable");
    expect(out.found).toBe(false);
    expect(out.key).toBe("123");
    expect(out.message).toBe("introuvable");
    expect(out.lookupStatus).toBe("not_found");
  });

  it("supporte le statut ambiguous", () => {
    const out = lookupNotFound("123", "régression API", "ambiguous");
    expect(out.lookupStatus).toBe("ambiguous");
  });
});

describe("LookupResult discrimination", () => {
  it("permet le narrowing TypeScript via found (cas success)", () => {
    const result: LookupResult<DemoEntity> = lookupFound({ id: "abc", label: "demo" });
    expect(result.found).toBe(true);
    if (result.found) {
      // Sans discriminant, accéder à `result.id` ne typerait pas.
      expect(result.id).toBe("abc");
    }
  });

  it("permet le narrowing TypeScript via found (cas not_found)", () => {
    const result: LookupResult<DemoEntity> = lookupNotFound("abc", "introuvable");
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.message).toBeTruthy();
      expect(result.key).toBe("abc");
    }
  });
});
