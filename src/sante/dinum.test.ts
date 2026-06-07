import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../core/http.js";
import type { LookupResult } from "../core/lookup-result.js";
import { getEntrepriseBySiren, searchEntreprises } from "./dinum.js";

/**
 * Test helper : narrow `LookupResult<T>` vers le cas `found: true` ou throw.
 * Réduit le bruit des `if (e.found) { ... }` dans les assertions positives.
 */
function assertFound<T>(r: LookupResult<T>): T & { found: true; lookupStatus: "found" } {
  if (!r.found) {
    throw new Error(
      `Expected found result, got LookupNotFound (status=${r.lookupStatus}, key=${r.key}, message=${r.message})`,
    );
  }
  return r;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  // Isolation : assure que les tests DINUM ne déclenchent pas le fallback
  // INSEE par accident si la clé est héritée de la machine dev.
  vi.stubEnv("INSEE_SIRENE_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function apiResponse(
  payload: Partial<{
    results: Array<Record<string, unknown>>;
    total_results: number;
    page: number;
    per_page: number;
    total_pages: number;
  }>,
): Response {
  const body = {
    results: [],
    total_results: 0,
    page: 1,
    per_page: 10,
    total_pages: 0,
    ...payload,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Forge une `Response` d'erreur HTTP (body JSON) — jumeau d'`apiResponse` pour tester la discrimination des 4xx. */
function apiError(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Forge une `Response` `apiResponse` contenant exactement une entreprise.
 * Évite la répétition `apiResponse({ total_results: 1, results: [{ ... }] })`
 * dans les tests d'enrichissement de `getEntrepriseBySiren`.
 *
 * Les overrides du payload de l'entreprise sont mergés. `siege` est mergé
 * shallow pour pouvoir surcharger juste `code_postal` ou `siret` sans répéter
 * `etat_administratif: "A"` à chaque test.
 */
function entrepriseResponse(
  overrides: Record<string, unknown> & { siege?: Record<string, unknown> },
): Response {
  const { siege, ...rest } = overrides;
  return apiResponse({
    total_results: 1,
    results: [
      {
        etat_administratif: "A",
        ...rest,
        siege: { etat_administratif: "A", ...siege },
      },
    ],
  });
}

/** URL de la dernière requête fetch interceptée. */
function lastFetchUrl(): string {
  return fetchMock.mock.calls[0]?.[0] as string;
}

describe("searchEntreprises", () => {
  it("recherche labos par NAF + rayon géographique", async () => {
    fetchMock.mockResolvedValue(
      apiResponse({
        total_results: 2,
        total_pages: 1,
        results: [
          {
            siren: "123456789",
            nom_complet: "BIOLAB ARDENNES",
            activite_principale: "8690B",
            libelle_activite_principale: "Laboratoires d'analyses médicales",
            etat_administratif: "A",
            tranche_effectif_salarie: "12",
            siege: {
              siret: "12345678900012",
              adresse: "10 Rue Foch 08000 Charleville-Mézières",
              code_postal: "08000",
              libelle_commune: "Charleville-Mézières",
              latitude: "49.7672",
              longitude: "4.7192",
              activite_principale: "8690B",
              etat_administratif: "A",
            },
            finances: {
              "2024": { ca: 5000000, resultat_net: 250000 },
              "2023": { ca: 4800000, resultat_net: 200000 },
            },
            dirigeants: [{ nom: "DUPONT", prenoms: "Jean", fonction: "Président" }],
          },
        ],
      }),
    );

    const result = await searchEntreprises({
      naf: "8690B",
      center: { lon: 4.7192, lat: 49.7672 },
      radiusKm: 5,
    });

    expect(result.total).toBe(2);
    expect(result.entreprises).toHaveLength(1);
    const labo = result.entreprises[0];
    expect(labo?.siren).toBe("123456789");
    expect(labo?.nomComplet).toBe("BIOLAB ARDENNES");
    expect(labo?.naf).toBe("8690B");
    expect(labo?.finances).toHaveLength(2);
    expect(labo?.etablissements[0]?.point).toEqual({ lon: 4.7192, lat: 49.7672 });

    // P3 : recherche géo → endpoint /near_point (PAS /search avec lat/long).
    const url = lastFetchUrl();
    expect(url).toContain("/near_point");
    expect(url).not.toContain("/search");
    expect(url).toContain("lat=49.7672");
    expect(url).toContain("long=4.7192");
    expect(url).toContain("radius=5");
    expect(url).toContain("activite_principale=86.90B");
    // /near_point n'accepte ni q ni etat_administratif (rejet 400 amont).
    expect(url).not.toContain("etat_administratif");
  });

  it("P3 — `naf + center+radiusKm` fonctionne nativement via /near_point", async () => {
    fetchMock.mockResolvedValue(apiResponse({}));
    await searchEntreprises({
      naf: "8690B",
      center: { lon: 4.7192, lat: 49.7672 },
      radiusKm: 5,
    });
    expect(lastFetchUrl()).toContain("/near_point");
    expect(lastFetchUrl()).toContain("activite_principale=86.90B");
  });

  it("P3 — `center+radiusKm` seul (sans q ni naf) fonctionne via /near_point", async () => {
    fetchMock.mockResolvedValue(apiResponse({}));
    await searchEntreprises({ center: { lon: 4.7192, lat: 49.7672 }, radiusKm: 5 });
    const url = lastFetchUrl();
    expect(url).toContain("/near_point");
    expect(url).toContain("lat=49.7672");
  });

  it("P3 — `q + center` rejeté clairement (/near_point ne supporte pas q)", async () => {
    await expect(
      searchEntreprises({ q: "biogroup", center: { lon: 4.7192, lat: 49.7672 }, radiusKm: 5 }),
    ).rejects.toThrow(/near_point|recherche géographique.*q|q.*pas.*combin/i);
  });

  it("P3 — `departement|codePostal + center` rejeté (modes exclusifs)", async () => {
    await expect(
      searchEntreprises({ departement: "08", center: { lon: 4.72, lat: 49.77 }, radiusKm: 5 }),
    ).rejects.toThrow(RangeError);
    await expect(
      searchEntreprises({ codePostal: "08000", center: { lon: 4.72, lat: 49.77 }, radiusKm: 5 }),
    ).rejects.toThrow(/exclusif|administrati/i);
  });

  it("rejette si aucun critère fourni", async () => {
    await expect(searchEntreprises({})).rejects.toThrow(/au moins un critère/);
  });

  // Régression FRANCE-DATA-MCP-2 : validators DINUM throw RangeError, pas Error
  // standard (sinon mapping JSON-RPC -32603 + Sentry parasite cf. api/mcp.ts).
  it("throw RangeError sur les inputs invalides (FRANCE-DATA-MCP-2)", async () => {
    await expect(searchEntreprises({})).rejects.toThrow(RangeError);
    await expect(searchEntreprises({ center: { lon: 4.7, lat: 49.7 } })).rejects.toThrow(
      RangeError,
    );
  });

  it("rejette si center sans radiusKm", async () => {
    await expect(searchEntreprises({ center: { lon: 4.7, lat: 49.7 } })).rejects.toThrow(
      /radiusKm/,
    );
  });

  it("clamp le radius à 50 km", async () => {
    fetchMock.mockResolvedValue(apiResponse({}));
    await searchEntreprises({
      naf: "8690B",
      center: { lon: 4.7, lat: 49.7 },
      radiusKm: 999,
    });
    expect(lastFetchUrl()).toContain("radius=50");
  });

  it("clamp perPage à 25", async () => {
    fetchMock.mockResolvedValue(apiResponse({}));
    await searchEntreprises({ naf: "4773Z", perPage: 999 });
    expect(lastFetchUrl()).toContain("per_page=25");
  });

  it("filtre par département", async () => {
    fetchMock.mockResolvedValue(apiResponse({}));
    await searchEntreprises({ naf: "8710A", departement: "08" });
    expect(lastFetchUrl()).toContain("departement=08");
  });

  it("normalise le NAF compact (8690B) en format pointé (86.90B) attendu par DINUM", async () => {
    fetchMock.mockResolvedValue(apiResponse({}));
    await searchEntreprises({ naf: "8690B", departement: "08" });
    // L'URL doit contenir 86.90B (URL-encoded en 86.90B ou 86%2E90B selon URLSearchParams)
    const url = lastFetchUrl();
    expect(url).toMatch(/activite_principale=86\.?90B/);
    expect(url).not.toMatch(/activite_principale=8690B[^.]/);
  });

  it("préserve un NAF déjà au format pointé", async () => {
    fetchMock.mockResolvedValue(apiResponse({}));
    await searchEntreprises({ naf: "86.90B", departement: "08" });
    expect(lastFetchUrl()).toMatch(/activite_principale=86\.?90B/);
  });

  it("rejette une division NAF (`62`) en RangeError SANS appel réseau (near_point)", async () => {
    // Reproduction Sentry FRANCE-DATA-MCP-A : un caller passe la division `62`
    // (2 chiffres) au lieu d'une sous-classe. L'API DINUM /near_point renvoie un
    // HTTP 400 capté en Sentry `error` (faute caller déguisée en panne serveur).
    // On rejette en amont (RangeError → JSON-RPC -32602) avant tout appel réseau.
    await expect(
      searchEntreprises({ naf: "62", center: { lon: -1.566578, lat: 47.236299 }, radiusKm: 10 }),
    ).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejette un code NAF tronqué sans lettre (`8690`) en RangeError (mode /search)", async () => {
    await expect(searchEntreprises({ naf: "8690", departement: "08" })).rejects.toThrow(
      /code NAF invalide/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("convertit le 400 DINUM d'un NAF bien formé mais INEXISTANT (`71.12Z`) en RangeError (FRANCE-DATA-MCP-G)", async () => {
    // Reproduction Sentry FRANCE-DATA-MCP-G : `71.12Z` est bien formé (sous-classe
    // 5 car. `XX.XXY`) donc passe `normalizeNafCode` — MAIS 7112 est éclaté en
    // 71.12A/71.12B : `71.12Z` n'EXISTE PAS. Seule l'API le sait, elle renvoie 400
    // « activite_principale non valide ». On convertit ce 400 (faute d'INPUT caller)
    // en RangeError → JSON-RPC -32602, au lieu de le laisser remonter en HttpError
    // capturée Sentry `error` (bruit de panne serveur pour un code client invalide).
    fetchMock.mockResolvedValue(
      apiError(400, {
        erreur:
          "Au moins un paramètre `activite_principale` est non valide. Les valeurs valides : ['01.11Z', '01.12Z']",
      }),
    );
    await expect(
      searchEntreprises({ naf: "71.12Z", departement: "44", onlyActive: true }),
    ).rejects.toThrow(RangeError);
    // L'appel réseau a bien eu lieu (≠ rejet de format pré-réseau) puis été converti.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ne masque PAS un 400 non lié au NAF — reste HttpError capturée", async () => {
    // Garde-fou anti-sur-élargissement : un 400 dont le body ne parle pas
    // d'`activite_principale` (et sans `naf` fourni) reste une HttpError (panne /
    // faute amont légitime) — la conversion en RangeError est étroite et ciblée.
    fetchMock.mockResolvedValue(apiError(400, { erreur: "Paramètre `departement` invalide" }));
    await expect(searchEntreprises({ departement: "999" })).rejects.toThrow(HttpError);
  });

  it("ne convertit PAS un 4xx non-400 même avec `activite_principale` dans le body (gate status === 400)", async () => {
    // Épingle la spécificité du gate `status === 400` (avec `naf` fourni ET body
    // mentionnant activite_principale) : un futur relâchement (ex. `status >= 400`)
    // ferait basculer ce 403 en RangeError — ce test l'attraperait. 403 ≠ 429/5xx
    // donc pas de retry : HttpError jetée immédiatement (test rapide).
    fetchMock.mockResolvedValue(apiError(403, { erreur: "activite_principale refusée : quota" }));
    await expect(searchEntreprises({ naf: "71.12B", departement: "44" })).rejects.toThrow(
      HttpError,
    );
  });

  it("accepte la sous-classe complète `62.01Z` (1 appel /near_point)", async () => {
    fetchMock.mockResolvedValue(apiResponse({}));
    await searchEntreprises({
      naf: "62.01Z",
      center: { lon: -1.566578, lat: 47.236299 },
      radiusKm: 10,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastFetchUrl()).toContain("activite_principale=62.01Z");
  });
});

describe("getEntrepriseBySiren", () => {
  it("retourne un LookupNotFound typé si SIREN introuvable", async () => {
    fetchMock.mockResolvedValue(apiResponse({ results: [] }));
    const e = await getEntrepriseBySiren("999999999");
    expect(e.found).toBe(false);
    if (!e.found) {
      expect(e.key).toBe("999999999");
      expect(e.lookupStatus).toBe("not_found");
      expect(e.message).toMatch(/non trouvé via DINUM|diffusion partielle/i);
    }
  });

  it("envoie q=<siren> en clair (PAS la syntaxe Lucene q=siren:XXX)", async () => {
    // Garde-fou contre la régression où on utiliserait `q=siren:${siren}` qui
    // n'est pas supporté par l'API DINUM. Tester explicitement la query string.
    fetchMock.mockResolvedValue(apiResponse({ results: [] }));
    await getEntrepriseBySiren("787120435");
    const url = lastFetchUrl();
    expect(url).toContain("q=787120435");
    expect(url).not.toContain("siren%3A");
    expect(url).not.toContain("siren:");
  });

  it("filtre côté client : ignore les résultats dont le SIREN ne correspond pas exactement", async () => {
    // L'API DINUM peut renvoyer des entreprises dont le nom contient les chiffres.
    // On ne veut récupérer que celle dont siren === argument.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(
      apiResponse({
        total_results: 3,
        results: [
          { siren: "787120999", nom_complet: "AUTRE 1", etat_administratif: "A" },
          { siren: "787120435", nom_complet: "RENAULT", etat_administratif: "A" },
          { siren: "787120111", nom_complet: "AUTRE 2", etat_administratif: "A" },
        ],
      }),
    );
    const e = await getEntrepriseBySiren("787120435");
    expect(e.found).toBe(true);
    if (e.found) {
      expect(e.siren).toBe("787120435");
      expect(e.nomComplet).toBe("RENAULT");
      // siren_source: "dinum" toujours présent sur retour DINUM pour cohérence
      // du contrat caller (distingue explicitement DINUM du fallback insee_v3).
      expect(e.siren_source).toBe("dinum");
    }
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("warn et retourne LookupNotFound 'ambiguous' si l'API renvoie des résultats sans match SIREN exact", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(
      apiResponse({
        total_results: 2,
        results: [
          { siren: "111111111", nom_complet: "PAS LE BON", etat_administratif: "A" },
          { siren: "222222222", nom_complet: "PAS LE BON NON PLUS", etat_administratif: "A" },
        ],
      }),
    );
    const e = await getEntrepriseBySiren("787120435");
    expect(e.found).toBe(false);
    if (!e.found) {
      expect(e.lookupStatus).toBe("ambiguous");
      expect(e.message).toContain("787120435");
    }
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("787120435");
    warnSpy.mockRestore();
  });

  it("envoie onlyActive=false (pas de filtre etat_administratif)", async () => {
    // getEntrepriseBySiren doit pouvoir retrouver des entreprises radiées
    fetchMock.mockResolvedValue(apiResponse({ results: [] }));
    await getEntrepriseBySiren("787120435");
    expect(lastFetchUrl()).not.toContain("etat_administratif=A");
  });

  it("enrichit les établissements via un second appel naf+departement (bug #1 fix)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        apiResponse({
          total_results: 1,
          results: [
            {
              siren: "787120435",
              nom_complet: "BIOLAB ARDENNES",
              activite_principale: "86.90B",
              nombre_etablissements: 19,
              nombre_etablissements_ouverts: 10,
              etat_administratif: "A",
              siege: {
                siret: "78712043500070",
                adresse: "ZI DE L'ETOILE 08300 RETHEL",
                code_postal: "08300",
                libelle_commune: "RETHEL",
                etat_administratif: "A",
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        apiResponse({
          total_results: 1,
          results: [
            {
              siren: "787120435",
              nom_complet: "BIOLAB ARDENNES",
              activite_principale: "86.90B",
              etat_administratif: "A",
              siege: {
                siret: "78712043500070",
                adresse: "ZI DE L'ETOILE 08300 RETHEL",
                code_postal: "08300",
                etat_administratif: "A",
              },
              matching_etablissements: [
                {
                  siret: "78712043500088",
                  adresse: "5 Cours Briand 08000 Charleville-Mézières",
                  code_postal: "08000",
                  etat_administratif: "A",
                },
                {
                  siret: "78712043500096",
                  adresse: "10 Rue Sedan 08200 Sedan",
                  code_postal: "08200",
                  etat_administratif: "A",
                },
                {
                  siret: "78712043500104",
                  adresse: "Givet 08600",
                  code_postal: "08600",
                  etat_administratif: "A",
                },
              ],
            },
          ],
        }),
      );

    const e = assertFound(await getEntrepriseBySiren("787120435"));
    expect(e.nombreEtablissements).toBe(19);
    expect(e.nombreEtablissementsOuverts).toBe(10);
    expect(e.etablissements).toHaveLength(4);
    expect(e.etablissements.map((et) => et.siret).sort()).toEqual([
      "78712043500070",
      "78712043500088",
      "78712043500096",
      "78712043500104",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = fetchMock.mock.calls[1]?.[0] as string;
    expect(secondUrl).toMatch(/activite_principale=86\.?90B/);
    expect(secondUrl).toContain("departement=08");
  });

  it("ne fait PAS le second appel si nombreEtablissements <= 1", async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse({
        total_results: 1,
        results: [
          {
            siren: "111111111",
            nom_complet: "MONOSITE SAS",
            activite_principale: "86.90B",
            nombre_etablissements: 1,
            nombre_etablissements_ouverts: 1,
            etat_administratif: "A",
            siege: {
              siret: "11111111100010",
              code_postal: "75001",
              etat_administratif: "A",
            },
          },
        ],
      }),
    );
    const e = assertFound(await getEntrepriseBySiren("111111111"));
    expect(e.etablissements).toHaveLength(1);
    expect(e.enrichmentStatus).toBe("not_attempted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("envoie departement=974 pour un siège DOM (Réunion 97400, pas '97')", async () => {
    fetchMock
      .mockResolvedValueOnce(
        entrepriseResponse({
          siren: "222222222",
          nom_complet: "LABO REUNION",
          activite_principale: "86.90B",
          nombre_etablissements: 5,
          nombre_etablissements_ouverts: 3,
          siege: { siret: "22222222200010", code_postal: "97400", libelle_commune: "SAINT-DENIS" },
        }),
      )
      .mockResolvedValueOnce(apiResponse({ results: [] }));
    await getEntrepriseBySiren("222222222");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = fetchMock.mock.calls[1]?.[0] as string;
    expect(secondUrl).toContain("departement=974");
    expect(secondUrl).not.toMatch(/departement=97[^0-9]/);
  });

  it("envoie departement=2A pour un siège Corse-du-Sud (20100)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        entrepriseResponse({
          siren: "333333333",
          nom_complet: "LABO AJACCIO",
          activite_principale: "86.90B",
          nombre_etablissements: 3,
          nombre_etablissements_ouverts: 2,
          siege: { siret: "33333333300010", code_postal: "20100" },
        }),
      )
      .mockResolvedValueOnce(apiResponse({ results: [] }));
    await getEntrepriseBySiren("333333333");
    const secondUrl = fetchMock.mock.calls[1]?.[0] as string;
    expect(secondUrl).toContain("departement=2A");
  });

  it("envoie departement=2B pour un siège Haute-Corse (20200)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        entrepriseResponse({
          siren: "444444444",
          nom_complet: "LABO BASTIA",
          activite_principale: "86.90B",
          nombre_etablissements: 3,
          siege: { siret: "44444444400010", code_postal: "20200" },
        }),
      )
      .mockResolvedValueOnce(apiResponse({ results: [] }));
    await getEntrepriseBySiren("444444444");
    const secondUrl = fetchMock.mock.calls[1]?.[0] as string;
    expect(secondUrl).toContain("departement=2B");
  });

  it("dégrade gracieusement si le 2e appel échoue : enrichmentStatus='failed' + warning", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(
        entrepriseResponse({
          siren: "555555555",
          nom_complet: "BIG SAS",
          activite_principale: "86.90B",
          nombre_etablissements: 10,
          siege: { siret: "55555555500010", code_postal: "08300" },
        }),
      )
      .mockRejectedValueOnce(new TypeError("network down"));

    const e = assertFound(await getEntrepriseBySiren("555555555"));
    expect(e.etablissements).toHaveLength(1);
    expect(e.enrichmentStatus).toBe("failed");
    expect(e.enrichmentWarning).toContain("nombreEtablissements=10");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("signale enrichmentStatus='partial' quand l'enrichissement ne couvre pas tous les sites", async () => {
    // 19 sites SIRENE, l'enrichissement n'en remonte que 3 (multi-département supposé)
    fetchMock
      .mockResolvedValueOnce(
        entrepriseResponse({
          siren: "666666666",
          nom_complet: "MULTI-DEPT SAS",
          activite_principale: "86.90B",
          nombre_etablissements: 19,
          nombre_etablissements_ouverts: 19,
          siege: { siret: "66666666600010", code_postal: "08000" },
        }),
      )
      .mockResolvedValueOnce(
        entrepriseResponse({
          siren: "666666666",
          siege: { siret: "66666666600010" },
          matching_etablissements: [
            { siret: "66666666600028", code_postal: "08200", etat_administratif: "A" },
            { siret: "66666666600036", code_postal: "08600", etat_administratif: "A" },
          ],
        }),
      );
    const e = assertFound(await getEntrepriseBySiren("666666666"));
    expect(e.etablissements).toHaveLength(3);
    expect(e.enrichmentStatus).toBe("partial");
    expect(e.enrichmentWarning).toContain("3/19");
    expect(e.enrichmentWarning).toContain("multi-département");
  });

  it("enrichmentStatus='success' quand on a tous les établissements", async () => {
    fetchMock
      .mockResolvedValueOnce(
        entrepriseResponse({
          siren: "777777777",
          nom_complet: "OK SAS",
          activite_principale: "86.90B",
          nombre_etablissements: 2,
          siege: { siret: "77777777700010", code_postal: "08000" },
        }),
      )
      .mockResolvedValueOnce(
        entrepriseResponse({
          siren: "777777777",
          siege: { siret: "77777777700010" },
          matching_etablissements: [
            { siret: "77777777700028", code_postal: "08200", etat_administratif: "A" },
          ],
        }),
      );
    const e = assertFound(await getEntrepriseBySiren("777777777"));
    expect(e.etablissements).toHaveLength(2);
    expect(e.enrichmentStatus).toBe("success");
    expect(e.enrichmentWarning).toBeUndefined();
  });

  it("retourne l'entreprise avec finances ordonnées par année décroissante", async () => {
    fetchMock.mockResolvedValue(
      apiResponse({
        total_results: 1,
        results: [
          {
            siren: "787120435",
            nom_complet: "TEST SA",
            etat_administratif: "A",
            finances: {
              "2022": { ca: 1000 },
              "2024": { ca: 3000 },
              "2023": { ca: 2000 },
            },
          },
        ],
      }),
    );
    const e = assertFound(await getEntrepriseBySiren("787120435"));
    expect(e.finances.map((f) => f.annee)).toEqual([2024, 2023, 2022]);
  });

  it("rejette les SIREN invalides sans appeler l'API", async () => {
    await expect(getEntrepriseBySiren("123")).rejects.toThrow(/SIREN invalide/);
    await expect(getEntrepriseBySiren("123")).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getEntrepriseBySiren — fallback SIRENE INSEE V3", () => {
  it("DINUM not_found + INSEE configuré + INSEE 200 → found:true avec siren_source=insee_v3", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key-uuid");

    fetchMock
      // 1. DINUM /search → 0 résultats (SIREN en diffusion partielle)
      .mockResolvedValueOnce(apiResponse({ results: [] }))
      // 2. INSEE /siren/787120435 → uniteLegale + period courante
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uniteLegale: {
              siren: "787120435",
              periodesUniteLegale: [
                {
                  denominationUniteLegale: "BIO ARD'AISNE",
                  activitePrincipaleUniteLegale: "86.90B",
                  etatAdministratifUniteLegale: "A",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const e = await getEntrepriseBySiren("787120435");
    expect(e.found).toBe(true);
    if (e.found) {
      expect(e.siren).toBe("787120435");
      expect(e.nomComplet).toBe("BIO ARD'AISNE");
      expect(e.naf).toBe("86.90B");
      expect(e.actif).toBe(true);
      expect(e.siren_source).toBe("insee_v3");
      expect(e.etablissements).toHaveLength(0);
    }
  });

  it("DINUM not_found + pas de clé INSEE → not_found avec message explicite", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse({ results: [] }));
    const e = await getEntrepriseBySiren("888888888");
    expect(e.found).toBe(false);
    if (!e.found) {
      expect(e.message).toMatch(/non configuré/);
      expect(e.message).toMatch(/INSEE_SIRENE_API_KEY/);
    }
  });

  it("DINUM not_found + INSEE configuré + INSEE 404 → not_found avec message 'a aussi retourné null'", async () => {
    vi.stubEnv("INSEE_SIRENE_API_KEY", "test-key-uuid");

    fetchMock
      .mockResolvedValueOnce(apiResponse({ results: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const e = await getEntrepriseBySiren("999999998");
    expect(e.found).toBe(false);
    if (!e.found) {
      expect(e.message).toMatch(/a aussi retourné null/);
    }
  });
});

describe("Finance.caFiable (B6 SELARL pharma audit 2026-05-09)", () => {
  it("ca=0 + resultatNet>0 → caFiable=false (pattern SELARL pharma non déclaré)", async () => {
    fetchMock.mockResolvedValue(
      apiResponse({
        total_results: 1,
        results: [
          {
            siren: "100000001",
            nom_complet: "PHARMA SELARL",
            etat_administratif: "A",
            finances: {
              "2024": { ca: 0, resultat_net: 100000 },
            },
          },
        ],
      }),
    );
    const e = assertFound(await getEntrepriseBySiren("100000001"));
    expect(e.finances).toHaveLength(1);
    expect(e.finances[0]?.ca).toBe(0);
    expect(e.finances[0]?.resultatNet).toBe(100000);
    expect(e.finances[0]?.caFiable).toBe(false);
  });

  it("ca>0 + resultatNet>0 → caFiable=true (cas nominal)", async () => {
    fetchMock.mockResolvedValue(
      apiResponse({
        total_results: 1,
        results: [
          {
            siren: "100000002",
            nom_complet: "BIOLAB SAS",
            etat_administratif: "A",
            finances: {
              "2024": { ca: 21735564, resultat_net: 2754396 },
            },
          },
        ],
      }),
    );
    const e = assertFound(await getEntrepriseBySiren("100000002"));
    expect(e.finances[0]?.caFiable).toBe(true);
  });

  it("ca=0 + resultatNet=0 → caFiable=true (entreprise dormante, vrai 0)", async () => {
    fetchMock.mockResolvedValue(
      apiResponse({
        total_results: 1,
        results: [
          {
            siren: "100000003",
            nom_complet: "DORMANTE SAS",
            etat_administratif: "A",
            finances: {
              "2024": { ca: 0, resultat_net: 0 },
            },
          },
        ],
      }),
    );
    const e = assertFound(await getEntrepriseBySiren("100000003"));
    expect(e.finances[0]?.caFiable).toBe(true);
  });

  it("ca=0 + resultatNet absent → caFiable=true (pas assez de signal pour suspecter)", async () => {
    fetchMock.mockResolvedValue(
      apiResponse({
        total_results: 1,
        results: [
          {
            siren: "100000004",
            nom_complet: "PARTIAL SAS",
            etat_administratif: "A",
            finances: {
              "2024": { ca: 0 },
            },
          },
        ],
      }),
    );
    const e = assertFound(await getEntrepriseBySiren("100000004"));
    expect(e.finances[0]?.caFiable).toBe(true);
  });

  it("ca absent + resultatNet>0 → caFiable=true (ca non dispo, pas un faux 0)", async () => {
    fetchMock.mockResolvedValue(
      apiResponse({
        total_results: 1,
        results: [
          {
            siren: "100000005",
            nom_complet: "NO CA SAS",
            etat_administratif: "A",
            finances: {
              "2024": { resultat_net: 50000 },
            },
          },
        ],
      }),
    );
    const e = assertFound(await getEntrepriseBySiren("100000005"));
    expect(e.finances[0]?.ca).toBeUndefined();
    expect(e.finances[0]?.caFiable).toBe(true);
  });

  it("ca=0 + resultatNet<0 → caFiable=true (entreprise déficitaire, vrai 0 plausible)", async () => {
    fetchMock.mockResolvedValue(
      apiResponse({
        total_results: 1,
        results: [
          {
            siren: "100000006",
            nom_complet: "DEFICIT SAS",
            etat_administratif: "A",
            finances: {
              "2024": { ca: 0, resultat_net: -5000 },
            },
          },
        ],
      }),
    );
    const e = assertFound(await getEntrepriseBySiren("100000006"));
    expect(e.finances[0]?.caFiable).toBe(true);
  });
});
