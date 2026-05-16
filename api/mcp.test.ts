import { describe, expect, it } from "vitest";
import { HttpError, RateLimitExceededError } from "../src/core/http.js";
import { describeUpstreamFailure } from "./mcp.js";

describe("describeUpstreamFailure (P3 — message amont actionnable)", () => {
  it("HttpError 503 → message transitoire avec le host (pas la query)", () => {
    const err = new HttpError(
      "HTTP 503 on https://geo.api.gouv.fr/communes?nom=Villeneuve",
      503,
      "https://geo.api.gouv.fr/communes?nom=Villeneuve",
      "<html>maintenance</html>",
    );
    const msg = describeUpstreamFailure(err);
    expect(msg).toContain("geo.api.gouv.fr");
    expect(msg).toContain("503");
    expect(msg).toContain("transitoire");
    // La query (input caller) ne doit PAS fuiter dans le message.
    expect(msg).not.toContain("Villeneuve");
    // Le body amont ne doit PAS fuiter non plus.
    expect(msg).not.toContain("maintenance");
  });

  it("RateLimitExceededError (429) → classé transitoire", () => {
    const err = new RateLimitExceededError("https://api.insee.fr/siret", 30);
    const msg = describeUpstreamFailure(err);
    expect(msg).toContain("api.insee.fr");
    expect(msg).toContain("429");
    expect(msg).toContain("transitoire");
  });

  it("HttpError 404 → réponse inattendue (PAS transitoire)", () => {
    const err = new HttpError("HTTP 404", 404, "https://data.geopf.fr/geocodage/search/?q=x");
    const msg = describeUpstreamFailure(err);
    expect(msg).toContain("data.geopf.fr");
    expect(msg).toContain("404");
    expect(msg).toContain("inattendue");
    expect(msg).not.toContain("transitoire");
  });

  it("URL non parsable → placeholder, jamais l'URL brute", () => {
    const err = new HttpError("boom", 500, "not-a-url");
    const msg = describeUpstreamFailure(err);
    expect(msg).toContain("amont");
    expect(msg).not.toContain("not-a-url");
  });

  it("erreur non-HTTP (bug code) → null (message original conservé en amont)", () => {
    expect(describeUpstreamFailure(new TypeError("cannot read x"))).toBeNull();
    expect(describeUpstreamFailure("string error")).toBeNull();
  });
});
