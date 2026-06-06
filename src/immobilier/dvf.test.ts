import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock supabase — must be hoisted before imports of the module under test
// ---------------------------------------------------------------------------

const mockFrom = vi.fn();
const mockRpc = vi.fn();

// anon (lecture RPC) ET service (écritures cache) routent vers les MÊMES mocks :
// les assertions portent sur mockFrom/mockRpc quelle que soit la clé utilisée.
vi.mock("../storage/supabase.js", () => ({
  getUntypedAnonClient: () => ({
    from: mockFrom,
    rpc: mockRpc,
  }),
  getUntypedServiceClient: () => ({
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runWithFakeTimers } from "../core/test-helpers.js";
import {
  type DvfMutation,
  type FetchCommuneCsvResult,
  aggregatePrix,
  deptPrefixFromInsee,
  dvfInRadius,
  ensureCommuneCached,
  fetchCommuneCsv,
} from "./dvf.js";

// Spy module pour mocker fetchCommunesInRadius/ensureCommuneCached dans les
// tests dvfInRadius (échec total vs partiel) sans toucher au réseau.
import * as dvfModule from "./dvf.js";

// ---------------------------------------------------------------------------
// fetch mock — pattern aligné sur src/core/http.test.ts
// ---------------------------------------------------------------------------

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  mockFrom.mockReset();
  mockRpc.mockReset();
  // Les chemins d'erreur (5xx épuisé, échec total ingestion, réseau) loggent —
  // on les silence pour garder la sortie de test propre (aligné http.test.ts).
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures CSV
// ---------------------------------------------------------------------------

const CSV_HEADER =
  "id_mutation,date_mutation,nature_mutation,valeur_fonciere,code_commune,type_local,surface_reelle_bati,surface_terrain,longitude,latitude";

/** 4 rows : 2 bâties avec prix_m2, 1 terrain, 1 sans lon/lat (doit être ignorée). */
const CSV_BODY = [
  // Appartement valide : 200 000 / 50 = 4 000 €/m²
  "M001,2024-03-01,Vente,200000,75056,Appartement,50,,2.3,48.8",
  // Maison valide : 300 000 / 100 = 3 000 €/m²
  "M002,2024-04-01,Vente,300000,75056,Maison,100,,2.35,48.85",
  // Terrain (pas de surface_reelle_bati)
  "M003,2024-05-01,Vente,80000,75056,,,,2.32,48.82",
  // Ligne sans lon/lat → doit être ignorée
  "M004,2024-06-01,Vente,150000,75056,Appartement,40,,,",
].join("\n");

const FULL_CSV = `${CSV_HEADER}\n${CSV_BODY}`;

function csvResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/csv" } });
}

// ---------------------------------------------------------------------------
// Tests deptPrefixFromInsee
// ---------------------------------------------------------------------------

describe("deptPrefixFromInsee", () => {
  it("métropole standard", () => {
    expect(deptPrefixFromInsee("75056")).toBe("75");
    expect(deptPrefixFromInsee("01001")).toBe("01");
  });

  it("Corse 2A/2B", () => {
    expect(deptPrefixFromInsee("2A004")).toBe("2A");
    expect(deptPrefixFromInsee("2B033")).toBe("2B");
  });

  it("DOM 97x", () => {
    expect(deptPrefixFromInsee("97105")).toBe("971");
    expect(deptPrefixFromInsee("97209")).toBe("972");
  });
});

// ---------------------------------------------------------------------------
// Tests fetchCommuneCsv
// ---------------------------------------------------------------------------

describe("fetchCommuneCsv", () => {
  it("parse le CSV, calcule prix_m2 et ignore les lignes sans lon/lat", async () => {
    fetchMock.mockResolvedValueOnce(csvResponse(FULL_CSV));

    const result: FetchCommuneCsvResult = await fetchCommuneCsv("75056");
    const { mutations, year } = result;

    // year = CURRENT_YEAR (première tentative réussie)
    expect(year).toBe(new Date().getFullYear());

    // 3 lignes conservées (M004 sans lon/lat ignorée)
    expect(mutations).toHaveLength(3);

    const apt = mutations.find((m) => m.id_mutation === "M001");
    expect(apt).toBeDefined();
    expect(apt?.type_local).toBe("Appartement");
    // 200000 / 50 = 4000
    expect(apt?.prix_m2).toBeCloseTo(4000, 0);

    const maison = mutations.find((m) => m.id_mutation === "M002");
    expect(maison?.prix_m2).toBeCloseTo(3000, 0);

    const terrain = mutations.find((m) => m.id_mutation === "M003");
    // Terrain sans surface_reelle_bati → prix_m2 = null
    expect(terrain?.prix_m2).toBeNull();
    expect(terrain?.longitude).toBeCloseTo(2.32, 4);
    // type_local absent côté CSV → normalisé en '' (PK NOT NULL DEFAULT '')
    expect(terrain?.type_local).toBe("");
    // date_mutation toujours peuplée (skip si absente)
    expect(terrain?.date_mutation).toBe("2024-05-01");

    // M004 sans coordonnées ne doit pas figurer
    expect(mutations.find((m) => m.id_mutation === "M004")).toBeUndefined();
  });

  it("retente CURRENT_YEAR-1 sur 404 et renvoie [] + year=CURRENT_YEAR-1 si les deux années sont absentes", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const { mutations, year } = await fetchCommuneCsv("99999");
    expect(mutations).toHaveLength(0);
    // year = CURRENT_YEAR - 1 (fallback utilisé)
    expect(year).toBe(new Date().getFullYear() - 1);
    // 2 appels : year N puis year N-1
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retourne year=CURRENT_YEAR-1 sur fallback 404 réussi", async () => {
    const CURRENT_YEAR = new Date().getFullYear();
    fetchMock
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 })) // CURRENT_YEAR → 404
      .mockResolvedValueOnce(csvResponse(FULL_CSV)); // CURRENT_YEAR-1 → ok

    const { mutations, year } = await fetchCommuneCsv("75056");
    expect(year).toBe(CURRENT_YEAR - 1);
    expect(mutations.length).toBeGreaterThan(0);
  });

  it("throw sur erreur HTTP non-404 (5xx retenté puis épuisé via fetchText)", async () => {
    vi.useFakeTimers();
    try {
      // fetchText retente les 5xx (retry/backoff partagé avec fetchJson) : tous
      // les essais renvoient 500 → HttpError(500) épuisé → fetchCommuneCsv le
      // remappe en "HTTP 500". Réponse fraîche par appel (un body se lit 1×).
      fetchMock.mockImplementation(async () =>
        Promise.resolve(new Response("Server Error", { status: 500 })),
      );

      await expect(runWithFakeTimers(fetchCommuneCsv("75056"))).rejects.toThrow("HTTP 500");
      // 4 essais (maxRetries=3 par défaut) sur l'année CURRENT_YEAR — le 5xx
      // épuisé throw AVANT le fallback année N-1 (un 5xx n'est pas un 404).
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejette avec un message réseau quand fetch échoue (TypeError net failure)", async () => {
    vi.useFakeTimers();
    try {
      // fetchText retente les erreurs réseau puis les épuise → fetchCommuneCsv
      // remappe en message contenant "network error".
      fetchMock.mockRejectedValue(new TypeError("net failure"));

      await expect(runWithFakeTimers(fetchCommuneCsv("75056"))).rejects.toThrow(/network/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prix_m2 = null quand surface_reelle_bati = 0 (garde anti-division)", async () => {
    const csv = `${CSV_HEADER}\nM020,2024-07-01,Vente,200000,75056,Appartement,0,,2.3,48.8`;
    fetchMock.mockResolvedValueOnce(csvResponse(csv));

    const { mutations } = await fetchCommuneCsv("75056");
    // La row est conservée (lon/lat/date présents) mais surface = 0 → prix_m2 null
    // (pas d'Infinity ni de division par zéro).
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.prix_m2).toBeNull();
    // surface_reelle_bati normalisée en null (srb > 0 requis pour la stocker).
    expect(mutations[0]?.surface_reelle_bati).toBeNull();
  });

  it("skip les rows sans date_mutation (composant NOT NULL de la PK)", async () => {
    const csv = `${CSV_HEADER}\nM010,,Vente,200000,75056,Appartement,50,,2.3,48.8`;
    fetchMock.mockResolvedValueOnce(csvResponse(csv));

    const { mutations } = await fetchCommuneCsv("75056");
    // La row sans date est rejetée (ne peut pas être insérée dans la PK)
    expect(mutations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests ensureCommuneCached — short-circuit si cache frais
// ---------------------------------------------------------------------------

describe("ensureCommuneCached", () => {
  it("short-circuit : fetch NOT called si cache frais (< 180 jours)", async () => {
    const freshFetchedAt = new Date().toISOString();
    const cacheChain: Record<string, unknown> = {};
    cacheChain.select = () => cacheChain;
    cacheChain.eq = () => cacheChain;
    cacheChain.limit = () =>
      Promise.resolve({
        data: [
          { code_commune: "75056", fetched_at: freshFetchedAt, source_year: 2025, row_count: 10 },
        ],
        error: null,
      });
    mockFrom.mockReturnValue(cacheChain);

    await ensureCommuneCached("75056", 180);

    // fetch (réseau) NE doit PAS avoir été appelé
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("déclenche le fetch si cache absent", async () => {
    const selectChain: Record<string, unknown> = {};
    selectChain.select = () => selectChain;
    selectChain.eq = () => selectChain;
    selectChain.limit = () => Promise.resolve({ data: [], error: null });

    const upsertChain: Record<string, unknown> = {};
    upsertChain.upsert = () => Promise.resolve({ error: null });

    const upsertChain2: Record<string, unknown> = {};
    upsertChain2.upsert = () => Promise.resolve({ error: null });

    mockFrom
      .mockReturnValueOnce(selectChain) // getCacheRow
      .mockReturnValueOnce(upsertChain) // upsertMutations (batch)
      .mockReturnValueOnce(upsertChain2); // markCommuneCached

    fetchMock.mockResolvedValueOnce(csvResponse(FULL_CSV));

    await ensureCommuneCached("75056", 180);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("déclenche le fetch si cache périmé depuis > maxAgeDays", async () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const selectChain: Record<string, unknown> = {};
    selectChain.select = () => selectChain;
    selectChain.eq = () => selectChain;
    selectChain.limit = () =>
      Promise.resolve({
        data: [{ code_commune: "75056", fetched_at: oldDate, source_year: 2024, row_count: 5 }],
        error: null,
      });

    const upsertChain: Record<string, unknown> = {};
    upsertChain.upsert = () => Promise.resolve({ error: null });

    const upsertChain2: Record<string, unknown> = {};
    upsertChain2.upsert = () => Promise.resolve({ error: null });

    mockFrom
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(upsertChain)
      .mockReturnValueOnce(upsertChain2);

    fetchMock.mockResolvedValueOnce(csvResponse(FULL_CSV));

    await ensureCommuneCached("75056", 180);

    // Cache périmé → fetch déclenché
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests dvfInRadius — échec total ingestion ≠ « zéro vente » (Fix A2)
// ---------------------------------------------------------------------------

describe("dvfInRadius", () => {
  it("REJETTE quand TOUTES les communes échouent à l'ingestion (pas un zéro confiant)", async () => {
    // 2 communes résolues, les 2 ensureCommuneCached rejettent → échec total.
    vi.spyOn(dvfModule, "fetchCommunesInRadius").mockResolvedValueOnce(["75056", "92044"]);
    vi.spyOn(dvfModule, "ensureCommuneCached")
      .mockRejectedValueOnce(new Error("ingest fail 75056"))
      .mockRejectedValueOnce(new Error("ingest fail 92044"));

    // La RPC ne DOIT PAS être atteinte (on throw avant) — on l'arme quand même
    // pour prouver qu'elle n'est pas appelée.
    mockRpc.mockResolvedValue({ data: [], error: null });

    await expect(dvfInRadius(48.8, 2.3, 2)).rejects.toThrow(/ingestion totale/);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("PROCÈDE (appelle la RPC) quand au moins une commune réussit (échec partiel)", async () => {
    vi.spyOn(dvfModule, "fetchCommunesInRadius").mockResolvedValueOnce(["75056", "92044"]);
    vi.spyOn(dvfModule, "ensureCommuneCached")
      .mockResolvedValueOnce(undefined) // 75056 OK
      .mockRejectedValueOnce(new Error("ingest fail 92044")); // 92044 KO

    const rpcRows: DvfMutation[] = [
      {
        id_mutation: "M100",
        date_mutation: "2024-03-01",
        nature_mutation: "Vente",
        valeur_fonciere: 200000,
        code_commune: "75056",
        type_local: "Appartement",
        surface_reelle_bati: 50,
        surface_terrain: null,
        prix_m2: 4000,
        longitude: 2.3,
        latitude: 48.8,
      },
    ];
    mockRpc.mockResolvedValue({ data: rpcRows, error: null });

    const rows = await dvfInRadius(48.8, 2.3, 2);
    // Échec partiel → on procède : la RPC est appelée et ses rows remontent.
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id_mutation).toBe("M100");
  });
});

// ---------------------------------------------------------------------------
// Tests aggregatePrix
// ---------------------------------------------------------------------------

describe("aggregatePrix", () => {
  const makeMutation = (overrides: Partial<DvfMutation>): DvfMutation => ({
    id_mutation: "X",
    date_mutation: "2024-01-01",
    nature_mutation: "Vente",
    valeur_fonciere: null,
    code_commune: "75056",
    type_local: "",
    surface_reelle_bati: null,
    surface_terrain: null,
    prix_m2: null,
    longitude: 2.3,
    latitude: 48.8,
    ...overrides,
  });

  it("calcule la médiane sur un nombre impair de ventes", () => {
    const rows: DvfMutation[] = [
      makeMutation({ prix_m2: 1000 }),
      makeMutation({ prix_m2: 3000 }),
      makeMutation({ prix_m2: 2000 }),
    ];
    const agg = aggregatePrix(rows);
    expect(agg.prix_m2_median).toBeCloseTo(2000, 0);
    expect(agg.n_ventes).toBe(3);
  });

  it("calcule la médiane sur un nombre pair de ventes (interpolation)", () => {
    const rows: DvfMutation[] = [
      makeMutation({ prix_m2: 1000 }),
      makeMutation({ prix_m2: 2000 }),
      makeMutation({ prix_m2: 3000 }),
      makeMutation({ prix_m2: 4000 }),
    ];
    const agg = aggregatePrix(rows);
    // Médiane pair = (2000 + 3000) / 2 = 2500
    expect(agg.prix_m2_median).toBeCloseTo(2500, 0);
  });

  it("retourne null pour les médianes quand aucune vente bâtie", () => {
    const rows: DvfMutation[] = [
      makeMutation({ prix_m2: null, surface_terrain: 500, valeur_fonciere: 50000 }),
    ];
    const agg = aggregatePrix(rows);
    expect(agg.prix_m2_median).toBeNull();
    expect(agg.n_ventes).toBe(0);
    expect(agg.n_terrains).toBe(1);
  });

  it("calcule prix_terrain_median", () => {
    const rows: DvfMutation[] = [
      makeMutation({ surface_terrain: 200, valeur_fonciere: 40000 }),
      makeMutation({ surface_terrain: 300, valeur_fonciere: 60000 }),
      makeMutation({ surface_terrain: 100, valeur_fonciere: 20000 }),
    ];
    const agg = aggregatePrix(rows);
    expect(agg.n_terrains).toBe(3);
    // Médiane de [20000, 40000, 60000] = 40000
    expect(agg.prix_terrain_median).toBeCloseTo(40000, 0);
  });

  it("calcule p25 et p75", () => {
    // 4 valeurs : 1000, 2000, 3000, 4000
    const rows: DvfMutation[] = [
      makeMutation({ prix_m2: 1000 }),
      makeMutation({ prix_m2: 2000 }),
      makeMutation({ prix_m2: 3000 }),
      makeMutation({ prix_m2: 4000 }),
    ];
    const agg = aggregatePrix(rows);
    // p25 index = 0.25 * 3 = 0.75 → interpolation entre 1000 et 2000 = 1750
    expect(agg.prix_m2_p25).toBeCloseTo(1750, 0);
    // p75 index = 0.75 * 3 = 2.25 → interpolation entre 3000 et 4000 = 3250
    expect(agg.prix_m2_p75).toBeCloseTo(3250, 0);
  });

  it("tableau vide → tout null sauf n_ventes/n_terrains = 0", () => {
    const agg = aggregatePrix([]);
    expect(agg.prix_m2_median).toBeNull();
    expect(agg.prix_m2_p25).toBeNull();
    expect(agg.prix_m2_p75).toBeNull();
    expect(agg.n_ventes).toBe(0);
    expect(agg.n_terrains).toBe(0);
    expect(agg.prix_terrain_median).toBeNull();
  });
});
