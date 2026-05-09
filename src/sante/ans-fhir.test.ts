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

describe("lookupPractitionerByRpps", () => {
  it("retourne null sans appeler fetch quand la clé n'est pas configurée", async () => {
    const result = await lookupPractitionerByRpps("810009647990");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retourne null quand rpps_id est vide ou whitespace", async () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "test-key");
    expect(await lookupPractitionerByRpps("")).toBeNull();
    expect(await lookupPractitionerByRpps("   ")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("envoie le header ESANTE-API-KEY et le filtre identifier=", async () => {
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

    expect(result).not.toBeNull();
    expect(result?.rpps_id).toBe("810009647990");
    expect(result?.nom).toBe("DOE");
    expect(result?.prenom).toBe("Jane");
    expect(result?.civilite).toBe("Dr");
    expect(result?.active).toBe(true);
    expect(result?.source).toBe("ans_fhir");
    expect(result?.ans_internal_id).toBe("003-5711959-5858827");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/fhir/v2/Practitioner?identifier=");
    expect(String(url)).toContain("urn%3Aoid%3A1.2.250.1.71.4.2.1");
    expect(String(url)).toContain("810009647990");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["ESANTE-API-KEY"]).toBe("test-key-uuid");
    expect(headers["Accept"]).toBe("application/fhir+json");
  });

  it("retourne null quand le Bundle est vide", async () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(fhirBundle([]));
    const result = await lookupPractitionerByRpps("000000000");
    expect(result).toBeNull();
  });

  it("retourne null sur 404 et log en warn (outcome attendu)", async () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "test-key");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    const result = await lookupPractitionerByRpps("000000000");
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 404"));
    warnSpy.mockRestore();
  });

  it("retourne null sur 401 et log en error", async () => {
    vi.stubEnv("ANS_FHIR_API_KEY", "test-key");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    const result = await lookupPractitionerByRpps("810009647990");
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 401"));
    errSpy.mockRestore();
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
    expect(result?.rpps_id).toBe("810009647990");
    expect(result?.nom).toBe("DOE");
    expect(result?.prenom).toBe("John");
    expect(result?.civilite).toBeNull();
    expect(result?.active).toBeNull();
  });
});
