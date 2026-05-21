import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../storage/supabase.js", () => ({
  // Les sous-tools mockés ne touchent jamais le client : un stub minimal suffit.
  getUntypedAnonClient: () => ({}),
  getAnonClient: () => ({}),
}));

import * as crossSource from "./cross-source.js";
import * as finessDb from "./finess-db.js";
import { inspectSite } from "./inspect-site.js";
import * as rppsDb from "./rpps-db.js";
import * as siretResolver from "./siret-resolver.js";

const VALID_FINESS = "590048997";
const SIRET_BEST = "50781594200218";

function fakeVerifierFound(
  overrides: Partial<crossSource.VerifierSiteActifResult> = {},
): { found: true; lookupStatus: "found" } & crossSource.VerifierSiteActifResult {
  return {
    found: true,
    lookupStatus: "found",
    num_finess: VALID_FINESS,
    finess: {
      raison_sociale: "DIAGNOVIE LBM",
      adresse: { voie: "27 BD BIZET", code_postal: "59290", ville: "WASQUEHAL" },
      telephone: "03 20 05 15 00",
    },
    candidates: [
      {
        siret: SIRET_BEST,
        sources: ["rpps", "dinum_address_match"],
        score_adresse: 0.85,
        score_nom: 0.92,
        actif: true,
        adresse_libelle: "27 BD BIZET 59290 WASQUEHAL",
        date_creation: "2020-01-01",
        raison_sociale_ul: "BIOGROUP NORD",
      },
    ],
    best_match: {
      siret: SIRET_BEST,
      sources: ["rpps", "dinum_address_match"],
      score_adresse: 0.85,
      score_nom: 0.92,
      actif: true,
      adresse_libelle: "27 BD BIZET 59290 WASQUEHAL",
      date_creation: "2020-01-01",
      raison_sociale_ul: "BIOGROUP NORD",
    },
    sirens_explored: ["507815942"],
    dinum_errors: [],
    verdict_site: "actif",
    verdict_groupe: "actif",
    explication: "Site actif côté SIRENE/DINUM (mock test).",
    method: "rpps",
    fallback_reason: null,
    naf_filter_used: [],
    disambiguation_status: "not_applicable",
    ...overrides,
  };
}

function fakeRppsResult(
  count: number,
  truncated = false,
): Awaited<ReturnType<typeof rppsDb.getRppsDansEtablissement>> {
  return {
    count,
    truncated,
    results: [],
    query_metadata: {
      geo_precision: "structure_finess",
      notes: ["mock test inspect-site"],
    },
  };
}

function fakeFinessFound(): Extract<
  Awaited<ReturnType<typeof finessDb.getFinessByNumFiness>>,
  { found: true }
> {
  return {
    found: true,
    lookupStatus: "found",
    num_finess: VALID_FINESS,
    raison_sociale: "DIAGNOVIE LBM",
    categorie: { code: "611", libelle: "LBM", famille: "labo" },
    adresse: {
      voie: "27 BD BIZET",
      code_postal: "59290",
      ville: "WASQUEHAL",
      code_departement: "59",
      code_insee: "59646",
    },
    coords: { lat: 50.67, lon: 3.13 },
    distance_km: null,
    telephone: "03 20 05 15 00",
    email: null,
  };
}

function fakeResolutionEmpty(): siretResolver.SiretResolution {
  return {
    candidates: [],
    best_match: null,
    sirens_explored: [],
    sirens_actif: {},
    dinum_errors: [],
    method: "rpps",
    fallback_reason: "no_rpps",
    naf_filter_used: [],
    disambiguation_status: "not_applicable",
  };
}

function fakeHistoriqueFound(
  status: crossSource.HistoriqueEtablissementResult["status"] = "success",
): {
  found: true;
  lookupStatus: "found";
} & crossSource.HistoriqueEtablissementResult {
  return {
    found: true,
    lookupStatus: "found",
    num_finess: VALID_FINESS,
    finess: {
      raison_sociale: "DIAGNOVIE LBM",
      adresse: { voie: "27 BD BIZET", code_postal: "59290", ville: "WASQUEHAL" },
    },
    siret_timelines: [{ siret: SIRET_BEST, sirene: null, sirene_error: "test mock" }],
    dinum_errors: [],
    status,
    method: "rpps",
    fallback_reason: null,
    naf_filter_used: [],
    disambiguation_status: "not_applicable",
  };
}

describe("inspectSite — validation input", () => {
  it("throw RangeError sur num_finess mal formé (avant tout I/O)", async () => {
    await expect(inspectSite({ numFiness: "123" })).rejects.toThrow(RangeError);
    await expect(inspectSite({ numFiness: "abcdefghi" })).rejects.toThrow(RangeError);
  });

  it.each([
    ["zéro", 0],
    ["négatif", -1],
    ["non-entier", 5.5],
    ["trop grand", 51],
  ])("throw RangeError sur rppsLimit %s", async (_label, value) => {
    await expect(inspectSite({ numFiness: VALID_FINESS, rppsLimit: value })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("inspectSite — propagation lookup et composition", () => {
  // V0.13 : inspect_site charge directement FINESS + resolution avant de
  // passer le contexte à verifier/historique. Mocks par défaut pour que les
  // tests "happy path" n'aient pas à les répéter ; les tests qui veulent
  // l'inverse (FINESS absent) override.
  beforeEach(() => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue(fakeFinessFound());
    vi.spyOn(siretResolver, "resolveSiretsForFiness").mockResolvedValue(fakeResolutionEmpty());
  });

  it("propage lookupNotFound quand FINESS DREES est absent (bail-out V0.13 amont)", async () => {
    vi.spyOn(finessDb, "getFinessByNumFiness").mockResolvedValue({
      found: false,
      key: VALID_FINESS,
      lookupStatus: "not_found",
      message: "FINESS introuvable (mock test)",
    });
    vi.spyOn(rppsDb, "getRppsDansEtablissement").mockResolvedValue(fakeRppsResult(0));

    const result = await inspectSite({ numFiness: VALID_FINESS });
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.message).toBe("FINESS introuvable (mock test)");
    }
  });

  it("agrège les 3 sections quand tout est found", async () => {
    vi.spyOn(crossSource, "verifierSiteActif").mockResolvedValue(fakeVerifierFound());
    vi.spyOn(rppsDb, "getRppsDansEtablissement").mockResolvedValue(fakeRppsResult(7));
    vi.spyOn(crossSource, "historiqueEtablissement").mockResolvedValue(
      fakeHistoriqueFound("partial"),
    );

    const lookup = await inspectSite({ numFiness: VALID_FINESS });
    expect(lookup.found).toBe(true);
    if (!lookup.found) throw new Error("unreachable");

    expect(lookup.num_finess).toBe(VALID_FINESS);
    expect(lookup.finess.raison_sociale).toBe("DIAGNOVIE LBM");
    expect(lookup.statut_site.verdict_site).toBe("actif");
    expect(lookup.statut_site.best_match_siret).toBe(SIRET_BEST);
    expect(lookup.statut_site.candidates_count).toBe(1);
    expect(lookup.professionnels.count).toBe(7);
    expect(lookup.professionnels.truncated).toBe(false);
    expect(lookup.historique.available).toBe(true);
    if (lookup.historique.available) {
      expect(lookup.historique.status).toBe("partial");
    }
    // Sources contiennent les 4 labels attendus.
    expect(lookup.sources.etablissement).toContain("FINESS");
    expect(lookup.sources.statut).toContain("DINUM");
    expect(lookup.sources.statut).toContain("SIRENE");
    expect(lookup.sources.professionnels).toContain("RPPS");
  });

  it("encapsule historique en available:false quand verifier found mais SIRET candidates vides", async () => {
    vi.spyOn(crossSource, "verifierSiteActif").mockResolvedValue(
      fakeVerifierFound({
        candidates: [],
        best_match: null,
        sirens_explored: [],
        verdict_site: "indetermine",
        verdict_groupe: "indetermine",
      }),
    );
    vi.spyOn(rppsDb, "getRppsDansEtablissement").mockResolvedValue(fakeRppsResult(0));
    vi.spyOn(crossSource, "historiqueEtablissement").mockResolvedValue({
      found: false,
      key: VALID_FINESS,
      lookupStatus: "not_found",
      message: "FINESS trouvé mais aucun SIRET candidat",
    });

    const lookup = await inspectSite({ numFiness: VALID_FINESS });
    expect(lookup.found).toBe(true);
    if (!lookup.found) throw new Error("unreachable");

    expect(lookup.statut_site.verdict_site).toBe("indetermine");
    expect(lookup.statut_site.best_match_siret).toBeNull();
    expect(lookup.historique.available).toBe(false);
    if (!lookup.historique.available) {
      expect(lookup.historique.message).toContain("aucun SIRET candidat");
    }
  });

  it("historique_detail=false : timelines omises, résumé + flag (B2/lot3)", async () => {
    vi.spyOn(crossSource, "verifierSiteActif").mockResolvedValue(fakeVerifierFound());
    vi.spyOn(rppsDb, "getRppsDansEtablissement").mockResolvedValue(fakeRppsResult(3));
    vi.spyOn(crossSource, "historiqueEtablissement").mockResolvedValue(
      fakeHistoriqueFound("partial"),
    );

    const lookup = await inspectSite({ numFiness: VALID_FINESS, historiqueDetail: false });
    expect(lookup.found).toBe(true);
    if (!lookup.found) throw new Error("unreachable");
    expect(lookup.historique.available).toBe(true);
    if (!lookup.historique.available) throw new Error("unreachable");
    expect("siret_timelines" in lookup.historique).toBe(false);
    if ("detail_omitted" in lookup.historique) {
      expect(lookup.historique.detail_omitted).toBe(true);
      expect(lookup.historique.resume.sirets).toBe(1);
      // fixture : 1 SIRET avec sirene:null → compté comme en erreur (lève
      // l'ambiguïté periodes_total:0 vs SIRENE injoignable).
      expect(lookup.historique.resume.sirets_en_erreur).toBe(1);
      expect(lookup.historique.status).toBe("partial");
    } else {
      throw new Error("variante résumé attendue");
    }
  });

  it("historique détaillé par défaut (siret_timelines présent)", async () => {
    vi.spyOn(crossSource, "verifierSiteActif").mockResolvedValue(fakeVerifierFound());
    vi.spyOn(rppsDb, "getRppsDansEtablissement").mockResolvedValue(fakeRppsResult(3));
    vi.spyOn(crossSource, "historiqueEtablissement").mockResolvedValue(
      fakeHistoriqueFound("partial"),
    );
    const lookup = await inspectSite({ numFiness: VALID_FINESS });
    if (!lookup.found || !lookup.historique.available) throw new Error("unreachable");
    expect("siret_timelines" in lookup.historique).toBe(true);
  });

  it("transmet rppsLimit à getRppsDansEtablissement (pas de surprise)", async () => {
    vi.spyOn(crossSource, "verifierSiteActif").mockResolvedValue(fakeVerifierFound());
    const rppsSpy = vi
      .spyOn(rppsDb, "getRppsDansEtablissement")
      .mockResolvedValue(fakeRppsResult(0));
    vi.spyOn(crossSource, "historiqueEtablissement").mockResolvedValue(fakeHistoriqueFound());

    await inspectSite({ numFiness: VALID_FINESS, rppsLimit: 25 });
    expect(rppsSpy).toHaveBeenCalledWith({ numFiness: VALID_FINESS, limit: 25 });
  });

  it("V0.13 — 2 phases parallélisées : (finess+rpps) puis (verifier+historique)", async () => {
    // Architecture post-V0.13 :
    //  Phase A : `getFinessByNumFiness` + `getRppsDansEtablissement` en parallèle
    //  Phase B : `verifierSiteActif(context)` + `historiqueEtablissement(context)`
    //  en parallèle (avec contexte pré-chargé → 0 appel DINUM redondant)
    //
    // Le test vérifie le parallélisme intra-phase pour les 2 phases.
    const order: string[] = [];
    vi.spyOn(finessDb, "getFinessByNumFiness").mockImplementation(async () => {
      order.push("finess:start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("finess:end");
      return fakeFinessFound();
    });
    vi.spyOn(rppsDb, "getRppsDansEtablissement").mockImplementation(async () => {
      order.push("rpps:start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("rpps:end");
      return fakeRppsResult(0);
    });
    vi.spyOn(siretResolver, "resolveSiretsForFiness").mockResolvedValue(fakeResolutionEmpty());
    vi.spyOn(crossSource, "verifierSiteActif").mockImplementation(async () => {
      order.push("verifier:start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("verifier:end");
      return fakeVerifierFound();
    });
    vi.spyOn(crossSource, "historiqueEtablissement").mockImplementation(async () => {
      order.push("historique:start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("historique:end");
      return fakeHistoriqueFound();
    });

    await inspectSite({ numFiness: VALID_FINESS });

    // Phase A : finess + rpps parallèles (starts avant ends respectifs).
    const finessStart = order.indexOf("finess:start");
    const rppsStart = order.indexOf("rpps:start");
    const finessEnd = order.indexOf("finess:end");
    const rppsEnd = order.indexOf("rpps:end");
    expect(Math.max(finessStart, rppsStart)).toBeLessThan(Math.min(finessEnd, rppsEnd));

    // Phase B : verifier + historique parallèles.
    const verifStart = order.indexOf("verifier:start");
    const histStart = order.indexOf("historique:start");
    const verifEnd = order.indexOf("verifier:end");
    const histEnd = order.indexOf("historique:end");
    expect(Math.max(verifStart, histStart)).toBeLessThan(Math.min(verifEnd, histEnd));

    // Ordre inter-phase : phase B commence APRÈS la fin de phase A (finess
    // doit être chargé pour bâtir le contexte).
    expect(Math.min(verifStart, histStart)).toBeGreaterThan(finessEnd);
  });

  it("V0.13 — factorisation : resolveSiretsForFiness appelé UNE SEULE FOIS (vs 2× en V0.10)", async () => {
    // Régression non-régression : avant V0.13, `verifier` + `historique`
    // re-résolvaient chacun la cascade DINUM → 2 appels par inspect_site.
    // Maintenant : 1 appel partagé via SiteContext (économie ~600 ms +
    // moitié de la charge rate-limit DINUM par invocation).
    const resolveSpy = vi
      .spyOn(siretResolver, "resolveSiretsForFiness")
      .mockResolvedValue(fakeResolutionEmpty());
    vi.spyOn(rppsDb, "getRppsDansEtablissement").mockResolvedValue(fakeRppsResult(0));
    vi.spyOn(crossSource, "verifierSiteActif").mockResolvedValue(fakeVerifierFound());
    vi.spyOn(crossSource, "historiqueEtablissement").mockResolvedValue(fakeHistoriqueFound());

    await inspectSite({ numFiness: VALID_FINESS });
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });
});
