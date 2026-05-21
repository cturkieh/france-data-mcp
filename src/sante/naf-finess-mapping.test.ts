import { describe, expect, it } from "vitest";
import { FINESS_FAMILY_CODES, type FinessFamilleQuery } from "./finess-categories.js";
import { NAF_SANTE } from "./naf-codes.js";
import {
  DELIBERATELY_NO_NAF,
  _NAF_BY_FAMILLE_INTERNAL,
  isNafCompatibleWithFamille,
  nafToCompatibleFamilles,
  nafsForFamille,
} from "./naf-finess-mapping.js";

describe("nafsForFamille", () => {
  it("retourne les NAF mappés pour une famille mono-NAF nette (labo, pharmacie)", () => {
    expect(nafsForFamille("labo")).toEqual(["8690B"]);
    expect(nafsForFamille("pharmacie")).toEqual(["4773Z"]);
  });

  it("imagerie inclut 8622A (radio libérale) + 8690F (centres en SCM/SEL)", () => {
    // Sans 8690F on raterait les centres d'imagerie montés en société de
    // moyens, classés dans le fourre-tout santé humaine n.c.a. côté SIRENE.
    const imagerie = nafsForFamille("imagerie");
    expect(imagerie).toContain("8622A");
    expect(imagerie).toContain("8690F");
  });

  it("retourne une liste many-to-many pour les familles fourre-tout DREES", () => {
    const handicapAdultes = nafsForFamille("handicap_adultes");
    expect(handicapAdultes.length).toBeGreaterThanOrEqual(3);
    expect(handicapAdultes).toContain("8710C");
    expect(handicapAdultes).toContain("8810C"); // ESAT (aide par le travail)

    const hebergementSocial = nafsForFamille("hebergement_social");
    expect(hebergementSocial.length).toBeGreaterThanOrEqual(4);
    expect(hebergementSocial).toContain("8899B");
  });

  it("retourne [] pour 'autre' (catch-all FINESS)", () => {
    expect(nafsForFamille("autre")).toEqual([]);
  });

  it("retourne [] pour 'groupement' (DELIBERATELY_NO_NAF)", () => {
    // Décision Q3 du cadrage Resolver V2 : fallback désactivé pour les GCS
    // (structure juridique transverse, pas d'activité économique propre).
    // Test fixture #4 du chantier garde-fou.
    expect(nafsForFamille("groupement")).toEqual([]);
  });

  it("MCO mappe vers 8610Z (activités hospitalières) et SEULEMENT 8610Z", () => {
    // Pas d'extension vers 8622B (chirurgicales) — les cliniques chir privées
    // sont quasi-toutes en 8610Z côté SIRENE. Resserrer le gate.
    expect(nafsForFamille("mco")).toEqual(["8610Z"]);
  });

  it("psychiatrie inclut le NAF d'hébergement social mental (8720A)", () => {
    // Pourquoi : les maisons santé maladies mentales (code FINESS 161) sont
    // parfois en 8720A côté SIRENE, pas seulement en 8610Z hospitalier.
    const psy = nafsForFamille("psychiatrie");
    expect(psy).toContain("8610Z");
    expect(psy).toContain("8720A");
  });
});

describe("isNafCompatibleWithFamille", () => {
  it("matche le cas labo nominal (8690B ↔ labo)", () => {
    expect(isNafCompatibleWithFamille("8690B", "labo")).toBe(true);
  });

  it("rejette le cas Franco-Britannique (école 8542Z ne matche pas labo)", () => {
    // Cas réel : Hôpital Franco-Britannique, 4 rue Kléber. 7 structures cohabitent
    // dont l'IFSI (école — pas un NAF santé). Le gate doit la rejeter pour
    // éviter le mauvais match SIRENE↔FINESS labo.
    expect(isNafCompatibleWithFamille("8542Z", "labo")).toBe(false);
  });

  it("rejette tout NAF pour la famille 'groupement' (DELIBERATELY_NO_NAF)", () => {
    expect(isNafCompatibleWithFamille("8610Z", "groupement")).toBe(false);
    expect(isNafCompatibleWithFamille("8690B", "groupement")).toBe(false);
  });

  it("rejette tout NAF pour la famille 'autre'", () => {
    expect(isNafCompatibleWithFamille("8690B", "autre")).toBe(false);
  });

  it("rejette null / undefined / chaîne vide en NAF", () => {
    expect(isNafCompatibleWithFamille(null, "labo")).toBe(false);
    expect(isNafCompatibleWithFamille(undefined, "labo")).toBe(false);
    expect(isNafCompatibleWithFamille("", "labo")).toBe(false);
  });

  it("normalise le NAF avec point (format SIRENE '86.90B' → '8690B')", () => {
    // SIRENE expose parfois le NAF avec un point séparateur (cf. fakeInseeLookupFound
    // dans cross-source.test.ts : `naf: "86.90B"`). Le gate doit accepter les deux.
    expect(isNafCompatibleWithFamille("86.90B", "labo")).toBe(true);
    expect(isNafCompatibleWithFamille("86.10Z", "mco")).toBe(true);
  });

  it("normalise la casse (NAF en minuscule)", () => {
    expect(isNafCompatibleWithFamille("8690b", "labo")).toBe(true);
  });

  it("trim les espaces autour du NAF", () => {
    expect(isNafCompatibleWithFamille(" 8690B ", "labo")).toBe(true);
  });

  it("matche correctement les familles polyvalentes (handicap_adultes)", () => {
    expect(isNafCompatibleWithFamille("8710C", "handicap_adultes")).toBe(true);
    expect(isNafCompatibleWithFamille("8810C", "handicap_adultes")).toBe(true); // ESAT
    expect(isNafCompatibleWithFamille("8730B", "handicap_adultes")).toBe(true);
    // Mais pas un NAF d'enfance protection
    expect(isNafCompatibleWithFamille("8891A", "handicap_adultes")).toBe(false);
  });
});

describe("invariants de cohérence de la table", () => {
  it("toute famille de FINESS_FAMILY_CODES est listée dans la table OU dans DELIBERATELY_NO_NAF", () => {
    // Garde-fou : ajouter une famille à `FINESS_FAMILY_CODES` sans décision
    // explicite (mapping NAF OU DELIBERATELY_NO_NAF) est un silent-failure
    // qui désactiverait le fallback géo sans qu'on s'en rende compte. Ce test
    // force la décision à code-review time. Parallèle à l'invariant similaire
    // dans finess-categories.test.ts pour DELIBERATELY_AUTRE.
    for (const famille of Object.keys(FINESS_FAMILY_CODES) as FinessFamilleQuery[]) {
      const isMapped = (_NAF_BY_FAMILLE_INTERNAL[famille] ?? []).length > 0;
      const isDeliberatelyEmpty = DELIBERATELY_NO_NAF.has(famille);
      expect(
        isMapped || isDeliberatelyEmpty,
        `Famille "${famille}" présente dans FINESS_FAMILY_CODES mais ni mappée à un NAF ni listée dans DELIBERATELY_NO_NAF. Ajouter au moins un NAF compatible OU déclarer DELIBERATELY_NO_NAF avec une justification.`,
      ).toBe(true);
    }
  });

  it("DELIBERATELY_NO_NAF est disjoint des familles mappées (pas de double déclaration)", () => {
    for (const famille of DELIBERATELY_NO_NAF) {
      const mapped = _NAF_BY_FAMILLE_INTERNAL[famille] ?? [];
      expect(
        mapped.length,
        `Famille "${famille}" est dans DELIBERATELY_NO_NAF mais a aussi des NAF mappés (${JSON.stringify(mapped)}). Retirer de l'une des deux déclarations.`,
      ).toBe(0);
    }
  });

  it("tous les NAF référencés dans la table existent dans NAF_SANTE", () => {
    // Garde-fou : un typo de code NAF dans la table casserait le gate silencieusement
    // (isNafCompatibleWithFamille retournerait false pour un NAF pourtant valide).
    const knownNafs = new Set(Object.keys(NAF_SANTE));
    for (const [famille, nafs] of Object.entries(_NAF_BY_FAMILLE_INTERNAL)) {
      for (const naf of nafs) {
        expect(
          knownNafs.has(naf),
          `Famille "${famille}" référence le NAF "${naf}" qui n'existe pas dans naf-codes.ts/NAF_SANTE. Typo ou ajout manquant ?`,
        ).toBe(true);
      }
    }
  });

  it("groupement EST déclarée DELIBERATELY_NO_NAF (verrouille fixture #4)", () => {
    // Vérification redondante avec l'invariant général, mais explicite : le
    // test fixture #4 du chantier Resolver V2 (FINESS 696/697 GCS) repose
    // SUR ce comportement. Si quelqu'un retire 'groupement' de
    // DELIBERATELY_NO_NAF sans ajouter de NAF mappés, ce test crie.
    expect(DELIBERATELY_NO_NAF.has("groupement")).toBe(true);
    expect(nafsForFamille("groupement")).toEqual([]);
  });
});

describe("nafToCompatibleFamilles", () => {
  it("retourne la famille unique pour un NAF mono-famille (8690B → [labo])", () => {
    // Le NAF labos d'analyses médicales n'est mappé QUE par la famille labo —
    // utilisé en couche 1 du gate coverage : si caller passe naf=8690B sans
    // familles, on dérive automatiquement vers ["labo"] et on borne le scope FINESS.
    expect(nafToCompatibleFamilles("8690B")).toEqual(["labo"]);
    expect(nafToCompatibleFamilles("4773Z")).toEqual(["pharmacie"]);
  });

  it("retourne plusieurs familles pour un NAF many-to-many (8610Z hospitalier)", () => {
    // 8610Z (activités hospitalières INSEE) est partagé par 8 familles DREES :
    // mco, ssr, sld, had, psychiatrie, dialyse, addictologie, prevention_sante.
    // Indispensable pour le coverage hospitalier — sans many-to-many, on
    // sous-comptera systématiquement les sites hospitaliers réels.
    const families = nafToCompatibleFamilles("8610Z");
    expect(families).toContain("mco");
    expect(families).toContain("ssr");
    expect(families).toContain("sld");
    expect(families).toContain("had");
    expect(families).toContain("psychiatrie");
    expect(families.length).toBeGreaterThanOrEqual(5);
  });

  it("retourne [] pour un NAF non mappé (cas Franco-Britannique IFSI 8542Z école)", () => {
    // Cas réel hôpital Franco-Britannique : l'IFSI co-localisé a NAF école
    // (8542Z, enseignement supérieur), qui n'est mappé par AUCUNE famille
    // FINESS sanitaire. La fonction inverse doit retourner [] proprement —
    // le caller (coverage) traduit cela en "famille non compatible".
    expect(nafToCompatibleFamilles("8542Z")).toEqual([]);
  });

  it("normalise le NAF avec point séparateur SIRENE ('86.90B' → [labo])", () => {
    expect(nafToCompatibleFamilles("86.90B")).toEqual(["labo"]);
    expect(nafToCompatibleFamilles("86.10Z").length).toBeGreaterThanOrEqual(5);
  });

  it("normalise la casse et trim les espaces autour du NAF", () => {
    expect(nafToCompatibleFamilles(" 8690b ")).toEqual(["labo"]);
  });

  it("retourne [] pour null / undefined / chaîne vide", () => {
    expect(nafToCompatibleFamilles(null)).toEqual([]);
    expect(nafToCompatibleFamilles(undefined)).toEqual([]);
    expect(nafToCompatibleFamilles("")).toEqual([]);
  });

  it("n'inclut JAMAIS les familles DELIBERATELY_NO_NAF (invariant)", () => {
    // Garde-fou : même si DELIBERATELY_NO_NAF et NAF_BY_FAMILLE étaient un
    // jour mal synchronisées, la fonction inverse ne doit jamais ressortir
    // une famille listée comme DELIBERATELY_NO_NAF. Test parcourt tous les
    // NAF santé connus et vérifie sur chacun.
    for (const naf of Object.keys(NAF_SANTE)) {
      const families = nafToCompatibleFamilles(naf);
      for (const f of DELIBERATELY_NO_NAF) {
        expect(
          families,
          `NAF "${naf}" ne doit pas dériver vers la famille "${f}" (DELIBERATELY_NO_NAF).`,
        ).not.toContain(f);
      }
    }
  });

  it("la fonction inverse est cohérente avec nafsForFamille (round-trip)", () => {
    // Invariant croisé : si famille X a NAF Y, alors nafToCompatibleFamilles(Y)
    // doit contenir X. Toute désynchro est un silent failure du gate.
    for (const famille of Object.keys(FINESS_FAMILY_CODES) as FinessFamilleQuery[]) {
      const nafs = nafsForFamille(famille);
      for (const naf of nafs) {
        expect(
          nafToCompatibleFamilles(naf),
          `Round-trip cassé : famille "${famille}" mappe le NAF "${naf}", mais nafToCompatibleFamilles("${naf}") ne contient pas "${famille}".`,
        ).toContain(famille);
      }
    }
  });
});
