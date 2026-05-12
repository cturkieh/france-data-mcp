import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApiInseePeriode,
  getInseeApiKey,
  lookupSirenViaInsee,
  lookupSiretViaInsee,
  lookupSiretsBySirenViaInsee,
} from "./insee-sirene.js";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  // Reset env to a known empty state. Tests qui veulent une clé la set
  // explicitement via vi.stubEnv (pas d'héritage de la machine dev).
  vi.stubEnv("INSEE_SIRENE_API_KEY", "");
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

/** Construit une réponse INSEE V3.11 avec une période courante minimale. */
function inseeResponse(periode: Partial<ApiInseePeriode>, siren = "787120435"): Response {
  return jsonResponse({
    uniteLegale: {
      siren,
      periodesUniteLegale: [periode],
    },
  });
}

describe("getInseeApiKey", () => {
  it("retourne null quand INSEE_SIRENE_API_KEY est absente", () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "");
    expect(getInseeApiKey()).toBeNull();
  });

  it("retourne null quand INSEE_SIRENE_API_KEY ne contient que des espaces", () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "   ");
    expect(getInseeApiKey()).toBeNull();
  });

  it("retourne la clé quand INSEE_SIRENE_API_KEY est configurée", () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "abc-123");
    expect(getInseeApiKey()).toBe("abc-123");
  });

  // Strip guillemets : couvre les parsers .env qui conservent les quotes
  // entourantes — sans cette défense, INSEE renvoie 401 silencieux.
  it.each([
    ['"abc-uuid"', "guillemets doubles"],
    ["'abc-uuid'", "guillemets simples"],
    ['  "abc-uuid"  ', "whitespace + guillemets"],
  ])("strippe %s (%s)", (raw) => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", raw);
    expect(getInseeApiKey()).toBe("abc-uuid");
  });
});

describe("lookupSirenViaInsee", () => {
  it("retourne null sans appeler fetch quand la clé n'est pas configurée", async () => {
    const result = await lookupSirenViaInsee("787120435");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("envoie le header X-INSEE-Api-Key-Integration avec la clé configurée", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key-uuid");
    fetchMock.mockResolvedValueOnce(
      inseeResponse({ denominationUniteLegale: "ACME", etatAdministratifUniteLegale: "A" }),
    );

    await lookupSirenViaInsee("787120435");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.insee.fr/api-sirene/3.11/siren/787120435");
    const headers = (init as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers["X-INSEE-Api-Key-Integration"]).toBe("test-key-uuid");
  });

  it("retourne null quand l'API SIRENE répond 404 (SIREN vraiment absent)", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const result = await lookupSirenViaInsee("999999999");
    expect(result).toBeNull();
  });

  it("retourne null + console.error quand l'API SIRENE répond 401 (clé invalide/révoquée)", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "bad-key");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    const result = await lookupSirenViaInsee("787120435");
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0]?.[0]).toContain("HTTP 401");
    errSpy.mockRestore();
  });

  it("retourne null + console.error quand l'API SIRENE répond 5xx (panne API)", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    // Fake timers : `fetchJson` retry exponentiel sur 5xx (~7.5s wall-clock).
    // Sans fake timers ce test prend 4s ; avec, ~50ms.
    vi.useFakeTimers();
    const promise = lookupSirenViaInsee("787120435");
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("retourne null + console.error quand l'API SIRENE est injoignable (network error)", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError("network down"));
    vi.useFakeTimers();
    const promise = lookupSirenViaInsee("787120435");
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("mappe correctement une réponse 200 personne morale (denomination)", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      inseeResponse({
        denominationUniteLegale: "LABORATOIRE BIO ARD'AISNE",
        activitePrincipaleUniteLegale: "86.90B",
        etatAdministratifUniteLegale: "A",
        categorieJuridiqueUniteLegale: "5785",
      }),
    );

    const result = await lookupSirenViaInsee("787120435");
    expect(result).not.toBeNull();
    expect(result?.siren).toBe("787120435");
    expect(result?.nomComplet).toBe("LABORATOIRE BIO ARD'AISNE");
    expect(result?.naf).toBe("86.90B");
    expect(result?.actif).toBe(true);
    expect(result?.natureJuridique).toBe("5785");
    expect(result?.siren_source).toBe("insee_v3");
    expect(result?.enrichmentStatus).toBe("not_attempted");
    expect(result?.etablissements).toEqual([]);
    expect(result?.finances).toEqual([]);
    expect(result?.dirigeants).toEqual([]);
  });

  it("mappe une personne physique (prenom + nom) quand denomination est absente", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      inseeResponse({
        nomUniteLegale: "DUPONT",
        prenomUsuelUniteLegale: "JEAN",
        etatAdministratifUniteLegale: "A",
      }),
    );

    const result = await lookupSirenViaInsee("123456789");
    expect(result?.nomComplet).toBe("JEAN DUPONT");
  });

  it("mappe actif=false quand etatAdministratifUniteLegale='C' (cessée)", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      inseeResponse({ denominationUniteLegale: "FERMÉ", etatAdministratifUniteLegale: "C" }),
    );

    const result = await lookupSirenViaInsee("123456789");
    expect(result?.actif).toBe(false);
  });

  it("retombe sur siren brut quand periodesUniteLegale est vide", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ uniteLegale: { siren: "999999999", periodesUniteLegale: [] } }),
    );

    const result = await lookupSirenViaInsee("999999999");
    expect(result?.nomComplet).toBe("999999999");
    expect(result?.actif).toBe(false);
  });

  it("sélectionne la période courante (dateFin === null) parmi plusieurs périodes", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        uniteLegale: {
          siren: "787120435",
          periodesUniteLegale: [
            // Ordre INSEE V3.11 actuel = antéchronologique, mais on ne s'y fie
            // PAS — on lit la période avec dateFin === null explicitement.
            {
              dateFin: null,
              dateDebut: "2024-01-01",
              denominationUniteLegale: "NOM ACTUEL",
              etatAdministratifUniteLegale: "A",
            },
            {
              dateFin: "2023-12-31",
              dateDebut: "2020-01-01",
              denominationUniteLegale: "ANCIEN NOM",
              etatAdministratifUniteLegale: "A",
            },
          ],
        },
      }),
    );

    const result = await lookupSirenViaInsee("787120435");
    expect(result?.nomComplet).toBe("NOM ACTUEL");
  });

  it("sélectionne la période courante même quand elle n'est pas la première du tableau (robustesse ordre INSEE)", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        uniteLegale: {
          siren: "787120435",
          periodesUniteLegale: [
            {
              dateFin: "2023-12-31",
              denominationUniteLegale: "ANCIEN",
              etatAdministratifUniteLegale: "A",
            },
            { dateFin: null, denominationUniteLegale: "ACTUEL", etatAdministratifUniteLegale: "A" },
          ],
        },
      }),
    );

    const result = await lookupSirenViaInsee("787120435");
    expect(result?.nomComplet).toBe("ACTUEL");
  });

  it("fallback sur periodesUniteLegale[0] + console.warn quand aucune période ouverte", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        uniteLegale: {
          siren: "999000111",
          periodesUniteLegale: [
            {
              dateFin: "2020-01-01",
              denominationUniteLegale: "CESSÉE",
              etatAdministratifUniteLegale: "C",
            },
          ],
        },
      }),
    );

    const result = await lookupSirenViaInsee("999000111");
    expect(result?.nomComplet).toBe("CESSÉE");
    expect(result?.actif).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("aucune période ouverte");
    warnSpy.mockRestore();
  });

  it("retourne null + console.warn quand uniteLegale est absent (réponse malformée)", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(jsonResponse({ header: {} }));

    const result = await lookupSirenViaInsee("787120435");
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("lookupSiretViaInsee", () => {
  const SIRET = "78712043500015";

  function siretResponse(opts: {
    etatPeriode?: "A" | "F";
    dateFin?: string | null;
    dateDebut?: string;
    enseigne?: string | null;
    denomination?: string | null;
    naf?: string;
    siege?: boolean;
    denomUniteLegale?: string;
    extraPeriodes?: Array<{ dateDebut: string; dateFin: string | null; etat: "A" | "F" }>;
  }): Response {
    const periodeCourante = {
      dateDebut: opts.dateDebut ?? "2020-01-01",
      dateFin: opts.dateFin ?? null,
      etatAdministratifEtablissement: opts.etatPeriode ?? "A",
      enseigne1Etablissement: opts.enseigne ?? "ACME LABO",
      denominationUsuelleEtablissement: opts.denomination ?? null,
      activitePrincipaleEtablissement: opts.naf ?? "86.90B",
    };
    const periodes = [
      ...(opts.extraPeriodes?.map((p) => ({
        dateDebut: p.dateDebut,
        dateFin: p.dateFin,
        etatAdministratifEtablissement: p.etat,
      })) ?? []),
      periodeCourante,
    ];
    return jsonResponse({
      etablissement: {
        siren: SIRET.slice(0, 9),
        siret: SIRET,
        etablissementSiege: opts.siege ?? true,
        trancheEffectifsEtablissement: "11",
        uniteLegale: {
          periodesUniteLegale: [
            {
              dateFin: null,
              denominationUniteLegale: opts.denomUniteLegale ?? "LABORATOIRE ACME SAS",
              etatAdministratifUniteLegale: "A",
            },
          ],
        },
        adresseEtablissement: {
          numeroVoieEtablissement: "27",
          typeVoieEtablissement: "BD",
          libelleVoieEtablissement: "BIZET",
          codePostalEtablissement: "59290",
          libelleCommuneEtablissement: "WASQUEHAL",
          codeCommuneEtablissement: "59646",
        },
        periodesEtablissement: periodes,
      },
    });
  }

  it("retourne LookupResult not_found quand INSEE_SIRENE_API_KEY est absente", async () => {
    const result = await lookupSiretViaInsee(SIRET);
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.lookupStatus).toBe("not_found");
      expect(result.message).toContain("INSEE_SIRENE_API_KEY");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("envoie le header INSEE et hit /siret/<siret>", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "key-uuid");
    fetchMock.mockResolvedValueOnce(siretResponse({}));

    await lookupSiretViaInsee(SIRET);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.insee.fr/api-sirene/3.11/siret/${SIRET}`);
    const headers = (init as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers["X-INSEE-Api-Key-Integration"]).toBe("key-uuid");
  });

  it("HTTP 404 → LookupResult not_found avec message orienté caller", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "key");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const result = await lookupSiretViaInsee(SIRET);
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.lookupStatus).toBe("not_found");
      expect(result.message).toContain("introuvable");
    }
    warnSpy.mockRestore();
  });

  it("HTTP 401 → throw (incident, pas not_found silencieux)", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "bad-key");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(lookupSiretViaInsee(SIRET)).rejects.toBeDefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("HTTP 200 actif → LookupResult found avec champs essentiels", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "key");
    fetchMock.mockResolvedValueOnce(
      siretResponse({
        denomUniteLegale: "EUROFINS BIOMNIS",
        enseigne: "EUROFINS LBM",
        naf: "86.90B",
      }),
    );

    const result = await lookupSiretViaInsee(SIRET);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.siret).toBe(SIRET);
      expect(result.siren).toBe(SIRET.slice(0, 9));
      expect(result.raisonSocialeUniteLegale).toBe("EUROFINS BIOMNIS");
      expect(result.enseigne).toBe("EUROFINS LBM");
      expect(result.naf).toBe("86.90B");
      expect(result.actif).toBe(true);
      expect(result.dateFermeture).toBeNull();
      expect(result.estSiege).toBe(true);
      expect(result.trancheEffectif).toBe("11");
      expect(result.adresse.codePostal).toBe("59290");
      expect(result.adresse.libelleCommune).toBe("WASQUEHAL");
      expect(result.adresse.libelle).toContain("BIZET");
    }
  });

  it("HTTP 200 fermé → actif=false + dateFermeture renseignée", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "key");
    fetchMock.mockResolvedValueOnce(
      siretResponse({
        etatPeriode: "F",
        dateDebut: "2024-06-30",
        extraPeriodes: [{ dateDebut: "2010-01-01", dateFin: "2024-06-29", etat: "A" }],
      }),
    );

    const result = await lookupSiretViaInsee(SIRET);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.actif).toBe(false);
      expect(result.dateFermeture).toBe("2024-06-30");
      expect(result.dateCreation).toBe("2010-01-01");
    }
  });

  it("payload incohérent (etablissement absent) → LookupResult not_found", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "key");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(jsonResponse({ header: {} }));

    const result = await lookupSiretViaInsee(SIRET);
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.lookupStatus).toBe("not_found");
      expect(result.message).toContain("incohérente");
    }
    warnSpy.mockRestore();
  });

  // Régression V0.6.3 : SIRENE V3.11 sur /siret/{siret} retourne `uniteLegale`
  // À PLAT (denominationUniteLegale, nomUniteLegale, etatAdministratifUniteLegale
  // sont des champs directs de l'objet uniteLegale). C'est différent de /siren/{siren}
  // qui les expose dans `uniteLegale.periodesUniteLegale[]`. Avant le fix, le mapper
  // cherchait dans `periodesUniteLegale` sur la réponse /siret/, ne trouvait rien,
  // et tombait sur le fallback `siren` brut comme raison sociale (cas réel observé
  // sur 50781594200333 / BIOGROUP NORD → "507815942", 30116075000966 / CLINEA → "301160750").
  it("HTTP 200 sur /siret/ avec uniteLegale à plat (vraie shape V3.11) → raison sociale correctement extraite", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "key");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        etablissement: {
          siren: "507815942",
          siret: SIRET,
          etablissementSiege: true,
          trancheEffectifsEtablissement: "11",
          uniteLegale: {
            // Vraie shape V3.11 sur /siret/ : champs à plat, PAS dans periodesUniteLegale
            etatAdministratifUniteLegale: "A",
            denominationUniteLegale: "BIOGROUP NORD",
            categorieJuridiqueUniteLegale: "5785",
            activitePrincipaleUniteLegale: "86.90B",
          },
          adresseEtablissement: {
            numeroVoieEtablissement: "46",
            typeVoieEtablissement: "RUE",
            libelleVoieEtablissement: "DES FUSILLES",
            codePostalEtablissement: "59493",
            libelleCommuneEtablissement: "VILLENEUVE-D'ASCQ",
            codeCommuneEtablissement: "59009",
          },
          periodesEtablissement: [
            {
              dateDebut: "2024-02-16",
              dateFin: null,
              etatAdministratifEtablissement: "A",
              enseigne1Etablissement: null,
              activitePrincipaleEtablissement: "86.90B",
            },
          ],
        },
      }),
    );

    const result = await lookupSiretViaInsee(SIRET);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.raisonSocialeUniteLegale).toBe("BIOGROUP NORD");
      expect(result.raisonSocialeUniteLegale).not.toBe("507815942"); // pas le SIREN brut
    }
  });

  it("HTTP 200 sur /siret/ avec uniteLegale à plat — entrepreneur individuel (nom+prenom)", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "key");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        etablissement: {
          siren: "123456789",
          siret: "12345678900001",
          etablissementSiege: true,
          trancheEffectifsEtablissement: "00",
          uniteLegale: {
            // Entrepreneur individuel : pas de denomination, à la place nom+prénom
            etatAdministratifUniteLegale: "A",
            denominationUniteLegale: null,
            nomUniteLegale: "DUPONT",
            prenomUsuelUniteLegale: "JEAN",
            categorieJuridiqueUniteLegale: "1000",
            activitePrincipaleUniteLegale: "86.21Z",
          },
          adresseEtablissement: {
            numeroVoieEtablissement: "1",
            typeVoieEtablissement: "RUE",
            libelleVoieEtablissement: "DE LA PAIX",
            codePostalEtablissement: "75001",
            libelleCommuneEtablissement: "PARIS",
            codeCommuneEtablissement: "75101",
          },
          periodesEtablissement: [
            {
              dateDebut: "2020-01-01",
              dateFin: null,
              etatAdministratifEtablissement: "A",
              activitePrincipaleEtablissement: "86.21Z",
            },
          ],
        },
      }),
    );

    const result = await lookupSiretViaInsee("12345678900001");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.raisonSocialeUniteLegale).toBe("JEAN DUPONT");
    }
  });

  it("HTTP 200 sur /siret/ — robuste si payload contient ENCORE periodesUniteLegale (cas dégénéré)", async () => {
    // Cas défensif : on ne sait pas si une future version V3.12 réintroduira
    // periodesUniteLegale sur /siret/. Le mapper doit gérer les 2 shapes sans
    // régresser. Le test simule un payload avec les 2 (à plat + période) — la
    // période doit prendre le pas (plus précise, dateFin null = courante).
    vi.stubEnv("INSEE_SIRENE_API_KEY", "key");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        etablissement: {
          siren: "507815942",
          siret: SIRET,
          etablissementSiege: true,
          trancheEffectifsEtablissement: "11",
          uniteLegale: {
            etatAdministratifUniteLegale: "A",
            denominationUniteLegale: "ANCIENNE DENOMINATION",
            periodesUniteLegale: [
              {
                dateFin: null,
                denominationUniteLegale: "BIOGROUP NORD",
                etatAdministratifUniteLegale: "A",
              },
            ],
          },
          adresseEtablissement: {
            numeroVoieEtablissement: "46",
            typeVoieEtablissement: "RUE",
            libelleVoieEtablissement: "DES FUSILLES",
            codePostalEtablissement: "59493",
            libelleCommuneEtablissement: "VILLENEUVE-D'ASCQ",
            codeCommuneEtablissement: "59009",
          },
          periodesEtablissement: [
            {
              dateDebut: "2024-02-16",
              dateFin: null,
              etatAdministratifEtablissement: "A",
            },
          ],
        },
      }),
    );

    const result = await lookupSiretViaInsee(SIRET);
    expect(result.found).toBe(true);
    if (result.found) {
      // periodesUniteLegale prend le pas car elle est plus précise
      expect(result.raisonSocialeUniteLegale).toBe("BIOGROUP NORD");
    }
  });
});

describe("lookupSiretsBySirenViaInsee (V0.7.1 — fallback multi-sites)", () => {
  const SIREN = "507815942";

  /** Construit une réponse INSEE pour l'endpoint de recherche /siret?q=siren:XXX */
  function searchSiretResponse(
    etablissements: Array<{
      siret: string;
      siren?: string;
      etat?: "A" | "F";
      dateDebut?: string;
      denomination?: string;
      adresse?: {
        numVoie?: string;
        typeVoie?: string;
        libelleVoie?: string;
        cp?: string;
        commune?: string;
      };
    }>,
    total?: number,
  ): Response {
    return jsonResponse({
      header: { total: total ?? etablissements.length, debut: 0, nombre: etablissements.length },
      etablissements: etablissements.map((e) => ({
        siren: e.siren ?? SIREN,
        siret: e.siret,
        etablissementSiege: false,
        trancheEffectifsEtablissement: null,
        uniteLegale: {
          denominationUniteLegale: e.denomination ?? "BIOGROUP NORD",
          etatAdministratifUniteLegale: "A",
        },
        adresseEtablissement: {
          numeroVoieEtablissement: e.adresse?.numVoie ?? null,
          typeVoieEtablissement: e.adresse?.typeVoie ?? null,
          libelleVoieEtablissement: e.adresse?.libelleVoie ?? null,
          codePostalEtablissement: e.adresse?.cp ?? null,
          libelleCommuneEtablissement: e.adresse?.commune ?? null,
          codeCommuneEtablissement: null,
        },
        periodesEtablissement: [
          {
            dateDebut: e.dateDebut ?? "2020-01-01",
            dateFin: null,
            etatAdministratifEtablissement: e.etat ?? "A",
            enseigne1Etablissement: null,
            activitePrincipaleEtablissement: "86.90B",
          },
        ],
      })),
    });
  }

  it("not_found (no-op) quand INSEE_SIRENE_API_KEY est absente — pas de fetch", async () => {
    const result = await lookupSiretsBySirenViaInsee(SIREN);
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.message).toContain("INSEE_SIRENE_API_KEY");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("appelle l'endpoint /siret?q=siren:XXX&nombre=1000 avec le bon header", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(searchSiretResponse([{ siret: `${SIREN}00333` }]));

    await lookupSiretsBySirenViaInsee(SIREN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toContain(`/siret?q=siren:${SIREN}&nombre=1000`);
    const headers = (init as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers["X-INSEE-Api-Key-Integration"]).toBe("test-key");
  });

  it("HTTP 404 → LookupResult not_found avec message explicatif", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "key");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const result = await lookupSiretsBySirenViaInsee(SIREN);
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.message).toContain("introuvable");
    }
    warnSpy.mockRestore();
  });

  it("HTTP 5xx → throw (incident, pas silent not_found)", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "key");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const promise = lookupSiretsBySirenViaInsee(SIREN);
    // Attache le handler de rejection AVANT d'avancer les timers : sinon le
    // throw fetchJson (qui survient pendant runAllTimersAsync) est observé
    // comme "rejection sans handler" par Node, ce qui produit un
    // PromiseRejectionHandledWarning même si le test l'awaitra ensuite.
    const expectation = expect(promise).rejects.toBeDefined();
    // Avance les 4 retries fetchJson (~0.5+1+2+4 = 7.5s) sans atteindre le
    // timeout AbortController (60s), pour éviter qu'un abort() asynchrone
    // génère une seconde rejection après la première.
    await vi.advanceTimersByTimeAsync(8_000);
    await expectation;
    vi.useRealTimers();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("HTTP 200 → LookupResult found avec la liste des établissements mappés", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "key");
    fetchMock.mockResolvedValueOnce(
      searchSiretResponse([
        {
          siret: `${SIREN}00333`,
          etat: "A",
          denomination: "BIOGROUP NORD",
          adresse: {
            numVoie: "46",
            typeVoie: "RUE",
            libelleVoie: "DES FUSILLES",
            cp: "59493",
            commune: "VILLENEUVE-D'ASCQ",
          },
        },
        {
          siret: `${SIREN}00218`,
          etat: "F",
          dateDebut: "2024-02-16",
          denomination: "BIOGROUP NORD",
          adresse: {
            numVoie: "27",
            typeVoie: "BD",
            libelleVoie: "BIZET",
            cp: "59491",
            commune: "VILLENEUVE-D'ASCQ",
          },
        },
      ]),
    );

    const result = await lookupSiretsBySirenViaInsee(SIREN);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.etablissements).toHaveLength(2);
      const ferme = result.etablissements.find((e) => e.siret === `${SIREN}00218`);
      expect(ferme?.actif).toBe(false);
      expect(ferme?.raisonSocialeUniteLegale).toBe("BIOGROUP NORD");
      expect(ferme?.adresse.libelle).toContain("BIZET");
      const actif = result.etablissements.find((e) => e.siret === `${SIREN}00333`);
      expect(actif?.actif).toBe(true);
    }
  });

  it("réponse vide (0 établissements) → LookupResult not_found + console.warn", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "key");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(jsonResponse({ header: { total: 0 }, etablissements: [] }));

    const result = await lookupSiretsBySirenViaInsee(SIREN);
    expect(result.found).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("émet console.warn si header.total > 1000 (pagination tronquée)", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "key");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Simuler 1001 total mais on ne retourne qu'1 établissement (page 1)
    fetchMock.mockResolvedValueOnce(searchSiretResponse([{ siret: `${SIREN}00333` }], 1001));

    const result = await lookupSiretsBySirenViaInsee(SIREN);
    expect(result.found).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("V0.7.2 pagination requise"));
    warnSpy.mockRestore();
  });
});
