import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAnsFhirApiKey, getAnsFhirBaseUrl, lookupPractitionerByRpps } from "./ans-fhir.js";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.stubEnv("ANS_FHIR_API_KEY", "");
  vi.stubEnv("ANS_FHIR_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function fhirBundle(entries: unknown[], status = 200): Response {
  return new Response(
    JSON.stringify({ resourceType: "Bundle", type: "searchset", entry: entries }),
    { status, headers: { "content-type": "application/fhir+json" } },
  );
}

describe("getAnsFhirApiKey", () => {
  it("retourne null quand ANS_FHIR_API_KEY absente / vide", () => {
    expect(getAnsFhirApiKey()).toBeNull();
  });

  it("strippe les guillemets et whitespace entourants", () => {
    vi.stubEnv("ANS_FHIR_API_KEY", '  "abc-uuid"  ');
    expect(getAnsFhirApiKey()).toBe("abc-uuid");
  });

  it("retourne la clé telle quelle quand bien formée", () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "d31738db-48b2-4449-9738-db");
    expect(getAnsFhirApiKey()).toBe("d31738db-48b2-4449-9738-db");
  });
});

describe("getAnsFhirBaseUrl", () => {
  it("retourne l'URL officielle par défaut", () => {
    expect(getAnsFhirBaseUrl()).toBe("https://gateway.api.esante.gouv.fr/fhir/v2");
  });

  it("respecte l'override env (et trim trailing slashes)", () => {
    vi.stubEnv("ANS_FHIR_BASE_URL", "https://staging.example.com/fhir///");
    expect(getAnsFhirBaseUrl()).toBe("https://staging.example.com/fhir");
  });
});

describe("lookupPractitionerByRpps (V0.7.0 — discriminated result)", () => {
  it("status='no_key' sans appeler fetch quand la clé n'est pas configurée", async () => {
    const result = await lookupPractitionerByRpps("810009647990");
    expect(result.found).toBe(false);
    if (!result.found) expect(result.status).toBe("no_key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("status='invalid_format' quand rpps_id est vide ou whitespace", async () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "test-key");
    const emptyResult = await lookupPractitionerByRpps("");
    const wsResult = await lookupPractitionerByRpps("   ");
    expect(emptyResult.found).toBe(false);
    expect(wsResult.found).toBe(false);
    if (!emptyResult.found) expect(emptyResult.status).toBe("invalid_format");
    if (!wsResult.found) expect(wsResult.status).toBe("invalid_format");
  });

  it("status='invalid_format' sans appeler l'API si rpps_id n'a pas le bon format", async () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "test-key");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["1234567890", "8100051565666", "abcdefghijk"]) {
      const r = await lookupPractitionerByRpps(bad);
      expect(r.found).toBe(false);
      if (!r.found) expect(r.status).toBe("invalid_format");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("rejeté par la garde format"));
    warnSpy.mockRestore();
  });

  it("found=true avec practitioner peuplé quand ANS répond OK", async () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "test-key-uuid");
    fetchMock.mockResolvedValueOnce(
      fhirBundle([
        {
          resource: {
            resourceType: "Practitioner",
            id: "003-5711959-5858827",
            identifier: [
              {
                use: "official",
                system: "urn:oid:1.2.250.1.71.4.2.1",
                value: "810009647990",
              },
            ],
            name: [{ use: "official", family: "DOE", given: ["Jane"], prefix: ["Dr"] }],
            active: true,
          },
        },
      ]),
    );

    const result = await lookupPractitionerByRpps("810009647990");

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.practitioner.rpps_id).toBe("810009647990");
      expect(result.practitioner.nom).toBe("DOE");
      expect(result.practitioner.prenom).toBe("Jane");
      expect(result.practitioner.civilite).toBe("Dr");
      expect(result.practitioner.active).toBe(true);
      expect(result.practitioner.source).toBe("ans_fhir");
      expect(result.practitioner.ans_internal_id).toBe("003-5711959-5858827");
    }

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/fhir/v2/Practitioner?identifier=");
    expect(String(url)).toContain("urn%3Aoid%3A1.2.250.1.71.4.2.1");
    expect(String(url)).toContain("810009647990");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["ESANTE-API-KEY"]).toBe("test-key-uuid");
    expect(headers.Accept).toBe("application/fhir+json");
  });

  it("status='not_found' quand le Bundle est vide", async () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(fhirBundle([]));
    const result = await lookupPractitionerByRpps("00000000000");
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.status).toBe("not_found");
      expect(result.message).toContain("Bundle vide");
    }
  });

  it("status='not_found' + warn sur 404 (outcome attendu, retry inutile)", async () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "test-key");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    const result = await lookupPractitionerByRpps("00000000000");
    expect(result.found).toBe(false);
    if (!result.found) expect(result.status).toBe("not_found");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 404"));
    warnSpy.mockRestore();
  });

  it("status='api_error' + error log sur 401 (retry justifié)", async () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "test-key");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    const result = await lookupPractitionerByRpps("810009647990");
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.status).toBe("api_error");
      expect(result.message).toContain("Retry recommandé");
    }
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 401"));
    errSpy.mockRestore();
  });

  it("status='api_error' quand ANS répond 429 sustained (rate limit dépasse les retries fetchJson)", async () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "test-key");
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // 4 tentatives (1 initial + 3 retries de fetchJson) toutes 429 → RateLimitExceededError
    // dans le catch → mappé en status: "api_error". `retry-after: 1` cap au minimum
    // pour que les sleeps soient courts ; fake timers les flushent immédiatement.
    fetchMock.mockResolvedValue(
      new Response("rate limited", { status: 429, headers: { "retry-after": "1" } }),
    );
    const promise = lookupPractitionerByRpps("810009647990");
    // Laisse fetchJson épuiser ses 3 retries (sleep entre chaque) sans bloquer le test.
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.status).toBe("api_error");
      expect(result.message).toContain("Retry recommandé");
    }
    // 4 fetch (1 + 3 retries) avant abandon
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 429"));
    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it("retry 429 puis 200 → found=true (transient resolved)", async () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "test-key");
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "retry-after": "1" } }),
      )
      .mockResolvedValueOnce(
        fhirBundle([
          {
            resource: {
              resourceType: "Practitioner",
              id: "003-X",
              identifier: [
                {
                  use: "official",
                  system: "urn:oid:1.2.250.1.71.4.2.1",
                  value: "810009647990",
                },
              ],
              name: [{ family: "TEST", given: ["A"] }],
            },
          },
        ]),
      );
    const promise = lookupPractitionerByRpps("810009647990");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.found).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("fallback sur la valeur d'URL quand la ressource omet le system d'identifier", async () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "test-key");
    // Cas dégénéré : ANS répond avec un Practitioner dont l'identifier
    // n'a ni `system` ni `type` qui matche IDNPS — on fallback sur la
    // valeur de l'URL plutôt que renvoyer un rpps_id vide.
    fetchMock.mockResolvedValueOnce(
      fhirBundle([
        {
          resource: {
            resourceType: "Practitioner",
            id: "003-XXX",
            name: [{ family: "DOE", given: ["John"] }],
          },
        },
      ]),
    );
    const result = await lookupPractitionerByRpps("810009647990");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.practitioner.rpps_id).toBe("810009647990");
      expect(result.practitioner.nom).toBe("DOE");
      expect(result.practitioner.prenom).toBe("John");
      expect(result.practitioner.civilite).toBeNull();
      expect(result.practitioner.active).toBeNull();
    }
  });
});
