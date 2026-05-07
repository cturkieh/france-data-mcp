import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEntrepriseBySiren, searchEntreprises } from "./dinum.js";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
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
      q: "laboratoire",
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
    expect(labo?.finances[0]?.annee).toBe(2024);
    expect(labo?.finances[0]?.ca).toBe(5000000);
    expect(labo?.etablissements[0]?.point).toEqual({ lon: 4.7192, lat: 49.7672 });
    expect(labo?.dirigeants[0]?.nom).toBe("DUPONT");

    const url = lastFetchUrl();
    expect(url).toContain("q=laboratoire");
    expect(url).toContain("lat=49.7672");
    expect(url).toContain("long=4.7192");
    expect(url).toContain("radius=5");
    expect(url).toContain("etat_administratif=A");
  });

  it("rejette `naf + center+radiusKm` (limitation API DINUM) avec message d'aide", async () => {
    await expect(
      searchEntreprises({
        naf: "8690B",
        center: { lon: 4.7192, lat: 49.7672 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/n'accepte pas `naf` \+ `center\+radiusKm`/);
  });

  it("rejette `center+radiusKm` sans `q` ni `naf`", async () => {
    await expect(
      searchEntreprises({
        center: { lon: 4.7192, lat: 49.7672 },
        radiusKm: 5,
      }),
    ).rejects.toThrow(/recherche textuelle/);
  });

  it("rejette si aucun critère fourni", async () => {
    await expect(searchEntreprises({})).rejects.toThrow(/au moins un critère/);
  });

  it("rejette si center sans radiusKm", async () => {
    await expect(searchEntreprises({ center: { lon: 4.7, lat: 49.7 } })).rejects.toThrow(
      /radiusKm/,
    );
  });

  it("clamp le radius à 50 km", async () => {
    fetchMock.mockResolvedValue(apiResponse({}));
    await searchEntreprises({
      q: "labo",
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
});

describe("getEntrepriseBySiren", () => {
  it("retourne null si SIREN introuvable", async () => {
    fetchMock.mockResolvedValue(apiResponse({ results: [] }));
    const e = await getEntrepriseBySiren("999999999");
    expect(e).toBeNull();
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
    expect(e).not.toBeNull();
    expect(e?.siren).toBe("787120435");
    expect(e?.nomComplet).toBe("RENAULT");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("warn et retourne null si l'API renvoie des résultats sans match SIREN exact", async () => {
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
    expect(e).toBeNull();
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
    const e = await getEntrepriseBySiren("787120435");
    expect(e?.finances.map((f) => f.annee)).toEqual([2024, 2023, 2022]);
  });

  it("rejette les SIREN invalides sans appeler l'API", async () => {
    await expect(getEntrepriseBySiren("123")).rejects.toThrow(/SIREN invalide/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
