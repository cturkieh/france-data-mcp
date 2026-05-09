import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetInseeTokenCacheForTesting,
  getInseeBearerToken,
  getInseeSirenCredentials,
  lookupSirenViaInsee,
} from "./insee-sirene.js";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  __resetInseeTokenCacheForTesting();
  // Reset env to a known empty state. Tests qui veulent des creds les set
  // explicitement via vi.stubEnv (pas d'héritage de la machine dev).
  vi.stubEnv("INSEE_SIRENE_CLIENT_ID", "");
  vi.stubEnv("INSEE_SIRENE_CLIENT_SECRET", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("getInseeSirenCredentials", () => {
  it("retourne null si CLIENT_ID manque", () => {
    vi.stubEnv("INSEE_SIRENE_CLIENT_ID", "");
    vi.stubEnv("INSEE_SIRENE_CLIENT_SECRET", "secret");
    expect(getInseeSirenCredentials()).toBeNull();
  });

  it("retourne null si CLIENT_SECRET manque", () => {
    vi.stubEnv("INSEE_SIRENE_CLIENT_ID", "id");
    vi.stubEnv("INSEE_SIRENE_CLIENT_SECRET", "");
    expect(getInseeSirenCredentials()).toBeNull();
  });

  it("retourne {clientId, clientSecret} quand les deux sont set", () => {
    vi.stubEnv("INSEE_SIRENE_CLIENT_ID", "my_id");
    vi.stubEnv("INSEE_SIRENE_CLIENT_SECRET", "my_secret");
    expect(getInseeSirenCredentials()).toEqual({
      clientId: "my_id",
      clientSecret: "my_secret",
    });
  });
});

describe("getInseeBearerToken — cache + OAuth2", () => {
  it("renvoie le token et le cache : 2 appels successifs ne refont qu'un seul /token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T1", expires_in: 604800 }),
    );

    const t1 = await getInseeBearerToken({ clientId: "id", clientSecret: "secret" });
    const t2 = await getInseeBearerToken({ clientId: "id", clientSecret: "secret" });

    expect(t1).toBe("T1");
    expect(t2).toBe("T1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      "https://auth.insee.net/auth/realms/apim-gravitee/protocol/openid-connect/token",
    );
  });

  it("envoie grant_type=client_credentials + creds en form-urlencoded", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T", expires_in: 3600 }),
    );
    await getInseeBearerToken({ clientId: "abc", clientSecret: "xyz" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = String(init.body);
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain("client_id=abc");
    expect(body).toContain("client_secret=xyz");
  });

  it("throw si /token retourne 401 (creds invalides)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("invalid_client", { status: 401, statusText: "Unauthorized" }),
    );
    await expect(
      getInseeBearerToken({ clientId: "bad", clientSecret: "bad" }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("throw si /token répond 200 sans access_token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token_type: "Bearer" }));
    await expect(
      getInseeBearerToken({ clientId: "id", clientSecret: "secret" }),
    ).rejects.toThrow(/no access_token/);
  });
});

describe("lookupSirenViaInsee", () => {
  it("retourne null sans erreur quand aucune credential n'est configurée", async () => {
    const result = await lookupSirenViaInsee("787120435");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retourne null quand l'API SIRENE répond 404 (vraiment pas dans SIRENE)", async () => {
    vi.stubEnv("INSEE_SIRENE_CLIENT_ID", "id");
    vi.stubEnv("INSEE_SIRENE_CLIENT_SECRET", "secret");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "T", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const result = await lookupSirenViaInsee("999999999");
    expect(result).toBeNull();
  });

  it("retourne null + console.error quand l'API SIRENE répond 401 (auth cassée)", async () => {
    vi.stubEnv("INSEE_SIRENE_CLIENT_ID", "id");
    vi.stubEnv("INSEE_SIRENE_CLIENT_SECRET", "secret");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "T", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    const result = await lookupSirenViaInsee("787120435");
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0]?.[0]).toContain("HTTP 401");
    errSpy.mockRestore();
  });

  it("invalide le token cache quand l'API SIRENE répond 401 (rotation creds)", async () => {
    vi.stubEnv("INSEE_SIRENE_CLIENT_ID", "id");
    vi.stubEnv("INSEE_SIRENE_CLIENT_SECRET", "secret");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "T1", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "T2", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ uniteLegale: { siren: "787120435" } }));

    const first = await lookupSirenViaInsee("787120435");
    expect(first).toBeNull();
    const second = await lookupSirenViaInsee("787120435");
    expect(second).not.toBeNull();
    // 2 appels /token attendus : T1 puis T2 (cache invalidé entre les 2 lookups).
    const tokenCalls = fetchMock.mock.calls.filter(([url]) =>
      typeof url === "string" ? url.includes("/token") : false,
    );
    expect(tokenCalls.length).toBe(2);
    errSpy.mockRestore();
  });

  it("retourne null + console.error quand l'API SIRENE répond 5xx", async () => {
    vi.stubEnv("INSEE_SIRENE_CLIENT_ID", "id");
    vi.stubEnv("INSEE_SIRENE_CLIENT_SECRET", "secret");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "T", expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    const result = await lookupSirenViaInsee("787120435");
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("mappe correctement une réponse 200 (siren, nomComplet, naf, actif, siren_source)", async () => {
    vi.stubEnv("INSEE_SIRENE_CLIENT_ID", "id");
    vi.stubEnv("INSEE_SIRENE_CLIENT_SECRET", "secret");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "T", expires_in: 3600 }))
      .mockResolvedValueOnce(
        jsonResponse({
          uniteLegale: {
            siren: "787120435",
            denominationUniteLegale: "BIO ARD'AISNE",
            activitePrincipaleUniteLegale: "86.90B",
            etatAdministratifUniteLegale: "A",
            categorieJuridiqueUniteLegale: "5710",
          },
        }),
      );

    const result = await lookupSirenViaInsee("787120435");
    expect(result).not.toBeNull();
    expect(result?.siren).toBe("787120435");
    expect(result?.nomComplet).toBe("BIO ARD'AISNE");
    expect(result?.naf).toBe("86.90B");
    expect(result?.actif).toBe(true);
    expect(result?.siren_source).toBe("insee_v3");
    expect(result?.natureJuridique).toBe("5710");
    expect(result?.etablissements).toEqual([]);
    expect(result?.finances).toEqual([]);
    expect(result?.dirigeants).toEqual([]);
    expect(result?.enrichmentStatus).toBe("not_attempted");
  });

  it("reconstruit nomComplet 'prenom nom' pour un entrepreneur individuel (denomination null)", async () => {
    vi.stubEnv("INSEE_SIRENE_CLIENT_ID", "id");
    vi.stubEnv("INSEE_SIRENE_CLIENT_SECRET", "secret");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "T", expires_in: 3600 }))
      .mockResolvedValueOnce(
        jsonResponse({
          uniteLegale: {
            siren: "100000000",
            denominationUniteLegale: null,
            nomUniteLegale: "DUPONT",
            prenomUsuelUniteLegale: "Jean",
            activitePrincipaleUniteLegale: "47.73Z",
            etatAdministratifUniteLegale: "A",
          },
        }),
      );

    const result = await lookupSirenViaInsee("100000000");
    expect(result?.nomComplet).toBe("Jean DUPONT");
  });

  it("etatAdministratif !== 'A' → actif=false", async () => {
    vi.stubEnv("INSEE_SIRENE_CLIENT_ID", "id");
    vi.stubEnv("INSEE_SIRENE_CLIENT_SECRET", "secret");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "T", expires_in: 3600 }))
      .mockResolvedValueOnce(
        jsonResponse({
          uniteLegale: {
            siren: "100000001",
            denominationUniteLegale: "RADIEE SAS",
            etatAdministratifUniteLegale: "C",
          },
        }),
      );

    const result = await lookupSirenViaInsee("100000001");
    expect(result?.actif).toBe(false);
  });

  it("envoie le Bearer token sur l'endpoint /api-sirene/3.11/siren/{siren}", async () => {
    vi.stubEnv("INSEE_SIRENE_CLIENT_ID", "id");
    vi.stubEnv("INSEE_SIRENE_CLIENT_SECRET", "secret");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "ABC123", expires_in: 3600 }))
      .mockResolvedValueOnce(
        jsonResponse({
          uniteLegale: { siren: "787120435", denominationUniteLegale: "X" },
        }),
      );

    await lookupSirenViaInsee("787120435");
    const sireneUrl = fetchMock.mock.calls[1]?.[0] as string;
    const sireneInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(sireneUrl).toBe("https://api.insee.fr/api-sirene/3.11/siren/787120435");
    expect((sireneInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer ABC123",
    );
  });
});
