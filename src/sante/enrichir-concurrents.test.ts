import { afterEach, describe, expect, it, vi } from "vitest";
import * as crossMod from "./cross-source.js";
import * as dinumMod from "./dinum.js";
import { enrichirConcurrents } from "./enrichir-concurrents.js";
import * as inspectMod from "./inspect-site.js";

afterEach(() => vi.restoreAllMocks());

/** InspectSiteResult mock minimal mais valide (statut actif, 1 SIREN exploré). */
function inspectOk(numFiness: string, overrides: Record<string, unknown> = {}) {
  return {
    found: true,
    lookupStatus: "found",
    num_finess: numFiness,
    finess: { raison_sociale: `Labo ${numFiness}`, adresse: {}, telephone: null },
    statut_site: {
      verdict_site: "actif",
      verdict_groupe: "actif",
      best_match_siret: "82345678900012",
      best_match_score_adresse: 0.9,
      sirens_explored: ["823456789"],
      candidates_count: 1,
      explication: "",
      dinum_errors: [],
      method: "rpps",
      fallback_reason: null,
      naf_filter_used: [],
      disambiguation_status: "unique",
    },
    professionnels: { count: 12, truncated: false, sample: [] },
    historique: { available: false, message: "pas de SIRET candidat" },
    sources: {},
    ...overrides,
  };
}

function compareOk(numFiness: string, statut = "exact_match") {
  return {
    found: true,
    lookupStatus: "found",
    num_finess: numFiness,
    finess_raison_sociale: `Labo ${numFiness}`,
    rpps_raisons_sociales: [],
    statut,
  };
}

function entrepriseOk(siren: string, nombreEtablissements: number) {
  return {
    found: true,
    lookupStatus: "found",
    siren,
    nomComplet: "Biogroup SAS",
    nombreEtablissements,
    etablissements: [],
    finances: [],
    dirigeants: [],
    enrichmentStatus: "success",
  };
}

function mockBriquesOk(nombreEtablissements = 50) {
  vi.spyOn(inspectMod, "inspectSite").mockImplementation(
    async ({ numFiness }) => inspectOk(numFiness) as never,
  );
  vi.spyOn(crossMod, "compareRaisonSocialeFinessVsRpps").mockImplementation(
    async (numFiness) => compareOk(numFiness) as never,
  );
  vi.spyOn(dinumMod, "getEntrepriseBySiren").mockImplementation(
    async (siren) => entrepriseOk(siren, nombreEtablissements) as never,
  );
}

describe("enrichir_concurrents", () => {
  it("cap max=3 : 5 FINESS fournis → 3 enquêtés", async () => {
    mockBriquesOk();
    const spy = vi.spyOn(inspectMod, "inspectSite");
    const r = await enrichirConcurrents({ finess: ["1", "2", "3", "4", "5"], max: 3 });
    expect(r.concurrents).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("dedup des FINESS dupliqués", async () => {
    mockBriquesOk();
    const r = await enrichirConcurrents({ finess: ["1", "1", "2"] });
    expect(r.concurrents).toHaveLength(2);
  });

  it("mappe statut, équipe, groupe + signal M&A (divergent → rebranding)", async () => {
    mockBriquesOk();
    vi.spyOn(crossMod, "compareRaisonSocialeFinessVsRpps").mockResolvedValue(
      compareOk("1", "divergent_after_normalization") as never,
    );
    const r = await enrichirConcurrents({ finess: ["1"] });
    const c = r.concurrents[0];
    expect(c?.statut_actif).toBe(true);
    expect(c?.equipe_count).toBe(12);
    expect(c?.groupe).toMatchObject({ denomination: "Biogroup SAS", est_grand_groupe: true });
    expect((c?.ma_signal as { rebranding_detecte: boolean }).rebranding_detecte).toBe(true);
    expect(c?.couverture).toBe("ok");
  });

  it("un concurrent échoue → couverture 'partiel:…', les autres restent 'ok'", async () => {
    mockBriquesOk();
    vi.spyOn(inspectMod, "inspectSite").mockImplementation(async ({ numFiness }) => {
      if (numFiness === "2") throw new Error("inspect 500");
      return inspectOk(numFiness) as never;
    });
    const r = await enrichirConcurrents({ finess: ["1", "2"] });
    expect(r.concurrents.find((c) => c.finess === "2")?.couverture).toMatch(/^partiel:/);
    expect(r.concurrents.find((c) => c.finess === "1")?.couverture).toBe("ok");
  });

  it("inspect_site not_found → partiel (pas de throw global)", async () => {
    mockBriquesOk();
    vi.spyOn(inspectMod, "inspectSite").mockResolvedValue({
      found: false,
      key: "999",
      lookupStatus: "not_found",
      message: "FINESS introuvable",
    });
    const r = await enrichirConcurrents({ finess: ["999"] });
    expect(r.concurrents[0]?.couverture).toMatch(/^partiel:/);
  });

  it("échec entreprise_by_siren → données inspect/compare PRÉSERVÉES + drapeau précis", async () => {
    mockBriquesOk();
    // Seul le groupe parent échoue : statut/équipe/historique doivent survivre.
    vi.spyOn(dinumMod, "getEntrepriseBySiren").mockRejectedValue(new Error("DINUM 503"));
    const r = await enrichirConcurrents({ finess: ["1"] });
    const c = r.concurrents[0];
    expect(c?.statut_actif).toBe(true); // PRÉSERVÉ (pas null)
    expect(c?.equipe_count).toBe(12); // PRÉSERVÉ
    expect(c?.groupe).toBeNull();
    expect(c?.couverture).toMatch(/^partiel:groupe_siren:/);
  });
});
