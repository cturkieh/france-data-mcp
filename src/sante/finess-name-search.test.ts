import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRpc = vi.fn();
vi.mock("../storage/supabase.js", () => ({
  getAnonClient: () => ({ rpc: mockRpc }),
  getUntypedAnonClient: () => ({ rpc: mockRpc }),
}));

import { communeInseeRange } from "../territoire/commune-index.js";
import { searchFinessByName } from "./finess-db.js";
import {
  FINESS_NAME_MATCH_THRESHOLD,
  type FinessNameCandidate,
  normalizeFinessName,
  resolveFinessNameCandidates,
} from "./finess-name-search.js";

// ---------------------------------------------------------------------------
// Fixtures — chiffres RÉELS mesurés en prod le 2026-09-22 (plan
// docs/plans/finess-recherche-par-nom.md).
// ---------------------------------------------------------------------------

function cand(
  num: string,
  raison: string,
  famille: FinessNameCandidate["categorie"]["famille"],
  insee: string,
  similarite: number,
  ville = "VILLE",
): FinessNameCandidate {
  return {
    num_finess: num,
    raison_sociale: raison,
    categorie: { code: null, libelle: null, famille },
    adresse: { voie: null, code_postal: null, ville, code_departement: null, code_insee: insee },
    coords: { lat: 48.79, lon: 2.35 },
    distance_km: null,
    geo_precision: "adresse",
    siret_ans: null,
    telephone: null,
    email: null,
    similarite,
  };
}

/** L'IGR : 4 fiches à 1,00 (3 à Villejuif, 1 à Chevilly-Larue), bruit à 0,53. */
const IGR = [
  cand(
    "940000656",
    "CLCC HOPITAL GUSTAVE ROUSSY SITE CHEVILLY LARUE",
    "mco",
    "94021",
    1,
    "CHEVILLY LARUE CEDEX",
  ),
  cand(
    "940021785",
    "EFS IDF SITE INSTITUT GUSTAVE ROUSSY",
    "prevention_sante",
    "94076",
    1,
    "VILLEJUIF CEDEX",
  ),
  cand(
    "940000664",
    "INSTITUT GUSTAVE ROUSSY SITE VILLE JUIF",
    "mco",
    "94076",
    1,
    "VILLEJUIF CEDEX",
  ),
  cand("940030893", "INSTITUT GUSTAVE ROUSSY", "autre", "94076", 1, "VILLEJUIF"),
  cand("670015817", "FAM GUSTAVE STRICKER", "handicap_adultes", "67046", 0.53),
];

describe("normalizeFinessName", () => {
  it("minuscules, accents et ponctuation retirés — jumeau de finess_nom_normalise", () => {
    expect(normalizeFinessName("Hôpital de la Pitié-Salpêtrière")).toBe(
      "hopital de la pitie salpetriere",
    );
    expect(normalizeFinessName("  INSTITUT   CURIE ")).toBe("institut curie");
  });

  it.each(["", "  ", "IG", "à-"])("%j → RangeError (moins de 3 caractères utiles)", (nom) => {
    expect(() => normalizeFinessName(nom)).toThrow(RangeError);
  });
});

describe("communeInseeRange (source unique PLM, consommée par la RPC)", () => {
  it.each([
    ["75056", ["75101", "75120"]],
    ["69123", ["69381", "69389"]],
    ["13055", ["13201", "13216"]],
    ["75115", ["75115", "75115"]],
    ["94076", ["94076", "94076"]],
  ])("%s → %j", (insee, attendu) => {
    expect(communeInseeRange(insee)).toEqual(attendu);
  });
});

describe("resolveFinessNameCandidates", () => {
  it("IGR sans hint : 4 candidats ≥ 0,8, 2 communes → ambigu, commune NON prouvée (jamais le premier servi seul)", () => {
    const r = resolveFinessNameCandidates("gustave roussy", IGR);

    expect(r.statut).toBe("ambigu");
    expect(r.candidats).toHaveLength(4);
    expect(r.candidats.map((c) => c.num_finess)).not.toContain("670015817");
    expect(r.commune_prouvee).toBeNull();
    expect(r.raison_commune).toBe("communes_divergentes");
    expect([...r.communes_candidates].sort()).toEqual(["94021", "94076"]);
    expect(r.meilleure_similarite).toBe(1);
  });

  it("IGR avec hint Villejuif (RPC déjà filtrée) : 3 fiches même commune → commune prouvée, CEDEX retiré", () => {
    const villejuif = IGR.filter((c) => c.adresse.code_insee === "94076");
    const r = resolveFinessNameCandidates("gustave roussy", villejuif);

    expect(r.statut).toBe("ambigu");
    expect(r.commune_prouvee).toEqual({ code_insee: "94076", ville: "VILLEJUIF" });
    expect(r.raison_commune).toBe("candidats_meme_commune");
  });

  it("à similarité égale : hôpital (mco) avant EFS (prevention_sante) avant « autre », puis libellé le plus court", () => {
    const r = resolveFinessNameCandidates("gustave roussy", IGR);

    expect(r.candidats.map((c) => c.num_finess)).toEqual([
      "940000664", // mco, libellé de 39 caractères (Villejuif)
      "940000656", // mco, 47 caractères (Chevilly-Larue)
      "940021785", // prevention_sante (EFS)
      "940030893", // autre (rang par défaut)
    ]);
  });

  it("à similarité et famille égales, la fiche AVEC point passe devant (« Hôpital Foch » : deux fiches, une sans)", () => {
    const sans = { ...cand("920041597", "HOPITAL FOCH", "mco", "92073", 1), coords: null };
    const avec = cand("920000098", "HOPITAL FOCH", "mco", "92073", 1);
    const r = resolveFinessNameCandidates("hopital foch", [sans, avec]);
    expect(r.candidats.map((c) => c.num_finess)).toEqual(["920000098", "920041597"]);
  });

  it("un seul candidat → unique + commune prouvée (un_seul_candidat)", () => {
    const r = resolveFinessNameCandidates("hopital foch", [
      cand("920000098", "HOPITAL FOCH", "mco", "92073", 1, "SURESNES CEDEX"),
      cand("640021374", "CDS DENTAIRE FOCH", "ambulatoire", "64445", 0.79),
    ]);

    expect(r.statut).toBe("unique");
    expect(r.commune_prouvee).toEqual({ code_insee: "92073", ville: "SURESNES" });
    expect(r.raison_commune).toBe("un_seul_candidat");
  });

  it("rien au-dessus du seuil → aucun, mais meilleure_similarite dit à quel point on est passé près", () => {
    const r = resolveFinessNameCandidates("georges pompidou", [
      cand(
        "190000141",
        "INSTITUT MEDICO-EDUCATIF GEORGES POMPIER",
        "handicap_enfants",
        "19203",
        0.76,
      ),
      cand(
        "750803447",
        "GHU APHP CENTRE-UNIVERSITE PARIS CITE SITE G POMPIDOU",
        "mco",
        "75115",
        0.56,
      ),
    ]);

    expect(r.statut).toBe("aucun");
    expect(r.candidats).toEqual([]);
    expect(r.commune_prouvee).toBeNull();
    expect(r.raison_commune).toBe("aucun_candidat");
    expect(r.communes_candidates).toEqual([]);
    expect(r.meilleure_similarite).toBe(0.76);
  });

  it("le seuil est bien 0,8 : 0,80 retenu, 0,79 écarté", () => {
    expect(FINESS_NAME_MATCH_THRESHOLD).toBe(0.8);
    const r = resolveFinessNameCandidates("x y z", [
      cand("1", "A", "mco", "01001", 0.8),
      cand("2", "B", "mco", "01001", 0.79),
    ]);
    expect(r.candidats.map((c) => c.num_finess)).toEqual(["1"]);
  });

  it("Paris (RPC déjà bornée 75101-75120) : hôpital avant pharmacie, commune-mère 75056 prouvée en MAJUSCULES", () => {
    const rows = [
      cand("750026833", "PHARMACIE NECKER", "pharmacie", "75115", 1, "Paris"),
      cand(
        "750100208",
        "GHU APHP CENTRE-UNIVERSITE PARIS CITE NECKER ENFANTS MALADES",
        "mco",
        "75115",
        1,
        "PARIS CEDEX 15",
      ),
    ];
    const r = resolveFinessNameCandidates("necker", rows);

    expect(r.candidats.map((c) => c.num_finess)).toEqual(["750100208", "750026833"]);
    expect(r.commune_prouvee).toEqual({ code_insee: "75056", ville: "PARIS" });
    expect(r.communes_candidates).toEqual(["75056"]);
  });

  it("deux arrondissements de Paris sans hint → même commune-mère → commune prouvée 75056", () => {
    const r = resolveFinessNameCandidates("pompidou", [
      cand(
        "750803447",
        "GHU APHP CENTRE-UNIVERSITE PARIS CITE SITE G POMPIDOU",
        "mco",
        "75115",
        1,
        "PARIS CEDEX 15",
      ),
      cand("750068835", "CDS DENTAIRE POMPIDOU", "ambulatoire", "75103", 1, "PARIS"),
    ]);

    expect(r.commune_prouvee?.code_insee).toBe("75056");
    expect(r.candidats[0]?.num_finess).toBe("750803447");
  });

  it("invariants : aucun ⇔ candidats vides ⇔ commune null ; commune prouvée ⇒ une seule commune candidate", () => {
    const jeux = [
      [],
      [cand("1", "A", "mco", "94076", 0.5)],
      [cand("1", "A", "mco", "94076", 1)],
      [cand("1", "A", "mco", "94076", 1), cand("2", "B", "mco", "94076", 0.9)],
      [cand("1", "A", "mco", "94076", 1), cand("2", "B", "mco", "94021", 1)],
    ];
    for (const rows of jeux) {
      const r = resolveFinessNameCandidates("x", rows);
      expect(r.statut === "aucun").toBe(r.candidats.length === 0);
      if (r.statut === "aucun") expect(r.commune_prouvee).toBeNull();
      if (r.commune_prouvee) expect(r.communes_candidates).toHaveLength(1);
      expect(r.statut === "unique").toBe(r.candidats.length === 1);
    }
  });
});

describe("searchFinessByName (wrapper RPC)", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const row = (over: Record<string, unknown>) => ({
    num_finess: "940000664",
    raison_sociale: "INSTITUT GUSTAVE ROUSSY SITE VILLE JUIF",
    categorie_code: "131",
    categorie_libelle: "CLCC",
    voie: "RUE EDOUARD VAILLANT",
    code_postal: "94805",
    code_departement: "94 ",
    code_insee: "94076",
    ville: "VILLEJUIF CEDEX",
    telephone: null,
    email: null,
    geom: { type: "Point", coordinates: [2.3494, 48.7913] },
    distance_meters: null,
    siret: null,
    geom_source: "ans",
    similarite: 1,
    ...over,
  });

  it("normalise le nom avant la RPC et passe les hints tels quels sur une commune ordinaire", async () => {
    mockRpc.mockResolvedValue({ data: [row({})], error: null });

    const r = await searchFinessByName({ nom: "Institut Gustave-Roussy", code_insee: "94076" });

    expect(mockRpc).toHaveBeenCalledWith("finess_search_by_name", {
      p_query: "institut gustave roussy",
      p_insee_min: "94076",
      p_insee_max: "94076",
      p_departement: null,
      p_limit: 50,
    });
    expect(r.query_normalisee).toBe("institut gustave roussy");
    expect(r.statut).toBe("unique");
    expect(r.candidats[0]?.coords).toEqual({ lat: 48.7913, lon: 2.3494 });
    expect(r.candidats[0]?.geo_precision).toBe("adresse");
    expect(r.candidats[0]?.categorie.famille).toBe("mco");
  });

  it("Paris (75056) → la RPC reçoit la PLAGE des arrondissements (les FINESS portent 75101-75120)", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await searchFinessByName({ nom: "necker", code_insee: "75056" });

    expect(mockRpc).toHaveBeenCalledWith("finess_search_by_name", {
      p_query: "necker",
      p_insee_min: "75101",
      p_insee_max: "75120",
      p_departement: null,
      p_limit: 50,
    });
  });

  it("code_insee + departement → RangeError (les deux en AND rendraient un faux « aucun »)", async () => {
    await expect(
      searchFinessByName({ nom: "necker", code_insee: "75056", departement: "75" }),
    ).rejects.toThrow(/SOIT `code_insee` SOIT `departement`/);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("réalisme PostgREST : similarite en STRING est coercée, pas comparée lexicalement", async () => {
    mockRpc.mockResolvedValue({
      data: [row({ similarite: "1" }), row({ num_finess: "000000001", similarite: "0.53" })],
      error: null,
    });

    const r = await searchFinessByName({ nom: "gustave roussy" });

    expect(r.candidats).toHaveLength(1);
    expect(r.candidats[0]?.similarite).toBe(1);
    expect(r.meilleure_similarite).toBe(1);
  });

  it("similarite illisible → ligne ignorée + warn + comptée dans lignes_rejetees (dégradation visible)", async () => {
    mockRpc.mockResolvedValue({
      data: [row({ similarite: null }), row({ num_finess: "000000002", similarite: "0.9" })],
      error: null,
    });

    const r = await searchFinessByName({ nom: "gustave roussy" });

    expect(r.candidats.map((c) => c.num_finess)).toEqual(["000000002"]);
    expect(r.lignes_rejetees).toBe(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("des lignes rendues mais AUCUNE lisible → throw (drift RPC), jamais « aucun candidat »", async () => {
    mockRpc.mockResolvedValue({
      data: [row({ similarite: null }), row({ num_finess: "000000002", similarite: "N/A" })],
      error: null,
    });

    await expect(searchFinessByName({ nom: "gustave roussy" })).rejects.toThrow(/AUCUNE lisible/);
  });

  it("fenêtre pleine dont la DERNIÈRE ligne est encore ≥ 0,8 → tronque:true, commune NON prouvée", async () => {
    mockRpc.mockResolvedValue({
      data: [row({}), row({ num_finess: "000000002", similarite: 0.8 })],
      error: null,
    });

    const r = await searchFinessByName({ nom: "gustave roussy", limit: 2 });

    expect(r.tronque).toBe(true);
    expect(r.statut).toBe("ambigu");
    expect(r.commune_prouvee).toBeNull();
    expect(r.raison_commune).toBe("tronque");
  });

  it("fenêtre pleine mais remplie par du bruit sous le seuil → PAS tronqué (mesuré : 50 lignes dès 0,5)", async () => {
    mockRpc.mockResolvedValue({
      data: [row({}), row({ num_finess: "000000002", similarite: 0.61 })],
      error: null,
    });

    const r = await searchFinessByName({ nom: "gustave roussy", limit: 2 });

    expect(r.tronque).toBe(false);
    expect(r.statut).toBe("unique");
    expect(r.commune_prouvee?.code_insee).toBe("94076");
  });

  it.each([0, 201, 2.5])("limit=%s → RangeError (jamais plafonné en silence)", async (limit) => {
    await expect(searchFinessByName({ nom: "necker", limit })).rejects.toThrow(/limit must be/);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("similarite arrondie UNE fois au mapping (0,996 → 1) — égalité tranchée par le rang de famille", async () => {
    mockRpc.mockResolvedValue({
      data: [
        row({ num_finess: "000000001", categorie_code: "620", similarite: 1 }),
        row({ num_finess: "000000002", categorie_code: "101", similarite: 0.996 }),
      ],
      error: null,
    });

    const r = await searchFinessByName({ nom: "gustave roussy" });

    expect(r.candidats.map((c) => [c.num_finess, c.similarite])).toEqual([
      ["000000002", 1],
      ["000000001", 1],
    ]);
  });

  it("erreur RPC → throw (jamais confondue avec « aucun candidat »)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "boom", code: "42883" } });
    await expect(searchFinessByName({ nom: "necker" })).rejects.toThrow(/finess_search_by_name/);
  });

  it("nom trop court, département ou code_insee invalides → RangeError AVANT la RPC", async () => {
    await expect(searchFinessByName({ nom: "IG" })).rejects.toThrow(RangeError);
    await expect(searchFinessByName({ nom: "necker", departement: "7" })).rejects.toThrow(
      RangeError,
    );
    await expect(searchFinessByName({ nom: "necker", code_insee: "751" })).rejects.toThrow(
      RangeError,
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
