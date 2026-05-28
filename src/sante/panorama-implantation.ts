/**
 * `panorama_implantation_complet` — composite « grand frère » de
 * `panorama_sante_territoire`, taillé pour l'étude d'implantation d'un labo.
 *
 * Géocode l'adresse (ancrage), puis agrège EN PARALLÈLE 7 sections hétérogènes
 * (territoire, demande bassin IRIS, concurrents, pourvoyeurs, prescripteurs,
 * cds, referentiels) sur 5 sources (FINESS, RPPS, Ameli/CNAM, INSEE/FILOSOFI,
 * SIRENE). Collapse une étude de ~15 round-trips connecteur Anthropic à ~2.
 *
 * Doctrine de dégradation (spec §4.4) — divergence ASSUMÉE vs
 * `panorama_sante_territoire` (qui rejette tout) : 7 sections hétérogènes ≠ 4
 * densités homogènes. Donc :
 *  - Échec d'ANCRAGE (géocode KO / confidence_low / code_insee indérivable) →
 *    rejet total `RangeError` (→ -32602). Rien n'est calculable sans le point.
 *  - Échec d'une SECTION → drapeau `couverture` = `indisponible:<raison>` +
 *    `console.warn` structuré, le RESTE est renvoyé. Jamais silencieux : le LLM
 *    voit le trou via `couverture` et le comble par l'outil unitaire.
 *
 * Réutilise les briques lib existantes sans les modifier — aucune nouvelle
 * requête DB brute, aucune migration.
 */

import { getDataFreshness } from "../storage/ingest-log.js";
import { plmDept } from "../territoire/commune-index.js";
import { deptFromCodeInsee } from "../territoire/dept-codes.js";
import { geocode } from "../territoire/geocode.js";
import { getProfilIris } from "../territoire/iris-profil.js";
import { getAmeliInRadius } from "./ameli-db.js";
import { getCdsInRadius } from "./cds-db.js";
import { getCoverageFinessVsSireneInRadius } from "./coverage.js";
import type { FinessFamille } from "./finess-categories.js";
import { type FinessResult, getFinessInRadius } from "./finess-db.js";
import { panoramaSanteTerritoire } from "./panorama.js";
import { getRppsInRadius } from "./rpps-db.js";

const LOG_TAG = "[france-data-mcp] panorama_implantation_complet";

/** Codes nomenclature internalisés (le LLM n'a plus à les connaître). */
const RPPS_PROFESSION_MEDECIN = "10";
const AMELI_SPECIALITE_IDEL = "24";
const NAF_LABO = "8690B";
const FAMILLES_POURVOYEURS = ["mco", "ehpad", "ssr", "dialyse"] as const satisfies FinessFamille[];

/** Une coordonnée géo précise (adresse BAN ou rattachement FINESS), cf. spec §4.5. */
const PRECISIONS_FIABLES = new Set(["adresse", "etablissement_finess"]);

export interface PanoramaImplantationInput {
  /** Adresse cible (géocodée IGN). XOR avec (`point` + `codeInsee`). */
  adresse?: string;
  /** Point déjà connu — skip géocodage (requiert `codeInsee`). */
  point?: { lat: number; lon: number };
  /** Code INSEE déjà connu (avec `point`). */
  codeInsee?: string;
  /** Nom commune (optionnel, pour `meta`). */
  commune?: string;
  /** Rayon du bassin de l'étude. Défaut 5 km. */
  rayonKm?: number;
}

/** Statut de couverture d'une section (anti-incomplétude, spec §4.2). */
export type SectionStatus = "ok" | `partiel:${string}` | `indisponible:${string}`;

export interface PanoramaImplantationMeta {
  adresse_demandee: string | null;
  point: { lat: number; lon: number };
  code_insee: string;
  code_dept: string;
  commune: string;
  rayon_km: number;
  geocode: { score: number; confidence_low: boolean };
  /** true si Paris/Lyon/Marseille → densité/territoire calculés au département. */
  plm_mode: boolean;
  sources: string[];
  generated_at: string;
}

export interface PanoramaImplantationResult {
  meta: PanoramaImplantationMeta;
  couverture: Record<string, SectionStatus>;
  territoire: unknown | null;
  demande: unknown | null;
  concurrents: unknown | null;
  pourvoyeurs: unknown | null;
  prescripteurs: unknown | null;
  cds: unknown | null;
  referentiels: unknown | null;
}

/** Résultat d'une section : la donnée (ou `null` si dégradée) + son statut. */
export interface SectionOutcome<T> {
  data: T | null;
  status: SectionStatus;
}

/**
 * Exécute une brique de section avec dégradation NON silencieuse (spec §4.4) :
 * un échec passe la section en `indisponible:<raison>` + `console.warn`
 * structuré (observabilité MCP), et le reste du panorama est préservé. Le LLM
 * client voit le trou via `couverture` et le comble par l'outil unitaire.
 * JAMAIS de catch muet (règle projet « zéro catch silencieux »).
 */
export async function runSection<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<SectionOutcome<T>> {
  try {
    const data = await fn();
    return { data, status: "ok" };
  } catch (err) {
    const raison = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG_TAG}: section '${name}' indisponible — ${raison} (panorama préservé)`);
    return { data: null, status: `indisponible:${raison}` };
  }
}

/** Ancrage résolu — toutes les sections en dépendent. */
interface Anchor {
  point: { lat: number; lon: number };
  codeInsee: string;
  codeDept: string;
  commune: string;
  rayonKm: number;
  plmMode: boolean;
  geocodeScore: number;
  confidenceLow: boolean;
  adresseDemandee: string | null;
}

/**
 * Résout l'ancrage : géocode l'adresse (ou prend le point fourni), dérive
 * `code_insee`/`code_dept`, détecte PLM. Un échec est un rejet total
 * (`RangeError` → -32602) — sans point fiable, aucune section n'a de sens.
 */
async function resolveAnchor(input: PanoramaImplantationInput): Promise<Anchor> {
  const rayonKm = input.rayonKm ?? 5;

  // Voie rapide : point + code INSEE déjà connus (skip géocodage).
  if (input.point && input.codeInsee) {
    const codeDept = deptFromCodeInsee(input.codeInsee);
    if (!codeDept) {
      throw new RangeError(`${LOG_TAG}: ancrage — code_insee invalide "${input.codeInsee}"`);
    }
    return {
      point: input.point,
      codeInsee: input.codeInsee,
      codeDept,
      commune: input.commune ?? "",
      rayonKm,
      plmMode: plmDept(input.codeInsee) !== null,
      geocodeScore: 1,
      confidenceLow: false,
      adresseDemandee: null,
    };
  }

  if (!input.adresse || input.adresse.trim().length === 0) {
    throw new RangeError(`${LOG_TAG}: ancrage — 'adresse' OU ('point' + 'codeInsee') requis`);
  }

  const g = await geocode(input.adresse);
  if (!g) {
    throw new RangeError(`${LOG_TAG}: ancrage — géocodage sans résultat pour "${input.adresse}"`);
  }
  if (g.confidence_low) {
    throw new RangeError(
      `${LOG_TAG}: ancrage — confidence_low (score=${g.score}), point non fiable pour "${input.adresse}"`,
    );
  }
  const codeInsee = g.codeCommune;
  if (!codeInsee) {
    throw new RangeError(`${LOG_TAG}: ancrage — code_insee indérivable du géocodage`);
  }
  const codeDept = deptFromCodeInsee(codeInsee);
  if (!codeDept) {
    throw new RangeError(`${LOG_TAG}: ancrage — code_insee invalide "${codeInsee}"`);
  }

  return {
    point: { lat: g.point.lat, lon: g.point.lon },
    codeInsee,
    codeDept,
    commune: g.commune ?? "",
    rayonKm,
    plmMode: plmDept(codeInsee) !== null,
    geocodeScore: g.score,
    confidenceLow: false,
    adresseDemandee: input.adresse,
  };
}

/** Nombre de PS géolocalisés PRÉCISÉMENT (adresse / rattachement FINESS, §4.5). */
function countPrecis(results: ReadonlyArray<{ geo_precision?: string }>): number {
  return results.filter(
    (r) => r.geo_precision !== undefined && PRECISIONS_FIABLES.has(r.geo_precision),
  ).length;
}

/** Projection d'un établissement FINESS en entrée de résumé (pas de liste brute, §3). */
function finessSummary(f: FinessResult) {
  return {
    finess: f.num_finess,
    raison_sociale: f.raison_sociale,
    distance_km: f.distance_km,
    coords: f.coords,
    code_insee: f.adresse.code_insee,
  };
}

/** Concurrents directs : labos FINESS dans le rayon — résumé count + top 15 distance. */
async function sectionConcurrents(point: { lat: number; lon: number }, rayonKm: number) {
  const r = await getFinessInRadius({
    center: { lat: point.lat, lon: point.lon },
    radiusKm: rayonKm,
    familles: ["labo"],
    limit: 50,
  });
  const top = r.results.slice(0, 15).map(finessSummary);
  return { count: r.count, top, au_dela_count: Math.max(0, r.count - top.length) };
}

/** Pourvoyeurs écosystémiques (MCO/EHPAD/SSR/dialyse) groupés par famille — top 3 chacun. */
async function sectionPourvoyeurs(point: { lat: number; lon: number }, rayonKm: number) {
  const r = await getFinessInRadius({
    center: { lat: point.lat, lon: point.lon },
    radiusKm: rayonKm,
    familles: [...FAMILLES_POURVOYEURS],
    limit: 200,
  });
  const groupes: Record<string, FinessResult[]> = {};
  for (const f of r.results) {
    (groupes[f.categorie.famille] ??= []).push(f);
  }
  const mk = (fam: FinessFamille) => {
    const list = groupes[fam] ?? [];
    return { count: list.length, top3: list.slice(0, 3).map(finessSummary) };
  };
  return { mco: mk("mco"), ehpad: mk("ehpad"), ssr: mk("ssr"), dialyse: mk("dialyse") };
}

/** Prescripteurs : MG (RPPS, geo_precision) + IDEL (Ameli, spe 24). En parallèle. */
async function sectionPrescripteurs(point: { lat: number; lon: number }, rayonKm: number) {
  const center = { lat: point.lat, lon: point.lon };
  const [mg, idel] = await Promise.all([
    getRppsInRadius({
      center,
      radiusKm: rayonKm,
      professionCodes: [RPPS_PROFESSION_MEDECIN],
      preciseOnly: false,
      limit: 200,
    }),
    getAmeliInRadius({
      center,
      radiusKm: rayonKm,
      specialiteCodes: [AMELI_SPECIALITE_IDEL],
      limit: 200,
    }),
  ]);
  return {
    mg: {
      count: mg.count,
      precis_count: countPrecis(mg.results),
      top: mg.results.slice(0, 10).map((r) => ({
        nom: r.identite.nom,
        distance_km: r.distance_km,
        geo_precision: r.geo_precision ?? null,
      })),
    },
    idel: {
      count: idel.count,
      precis_count: countPrecis(idel.results),
      top: idel.results.slice(0, 10).map((r) => ({
        nom: r.identite.nom,
        distance_km: r.distance_km,
        geo_precision: r.geo_precision ?? null,
      })),
    },
  };
}

/** CDS : centroïde commune (jamais de distance individuelle, §4.5). */
async function sectionCds(point: { lat: number; lon: number }, rayonKm: number) {
  const r = await getCdsInRadius({
    center: { lat: point.lat, lon: point.lon },
    radiusKm: rayonKm,
    limit: 50,
  });
  return {
    count: r.count,
    liste: r.results.slice(0, 15).map((c) => ({
      finess: c.etab_finess,
      nom: c.raison_sociale,
      commune: c.adresse.ville,
    })),
  };
}

/** Qualité référentiel : couverture FINESS↔SIRENE pour le NAF labo. */
async function sectionReferentiels(point: { lat: number; lon: number }, rayonKm: number) {
  const r = await getCoverageFinessVsSireneInRadius({
    center: { lon: point.lon, lat: point.lat },
    radiusKm: rayonKm,
    naf: NAF_LABO,
    familles: ["labo"],
  });
  return {
    coverage_status: r.coverage_status,
    finess_sites: r.finess_sites,
    sirene_sirets: r.sirene_sirets,
    finess_only: r.finess_only_count,
    sirene_only: r.sirene_only_count,
    coverage_ratio: r.coverage_ratio,
  };
}

/** Profil de la commune (densités + établissements + demande commune IRIS). */
function summariseTerritoire(p: Awaited<ReturnType<typeof panoramaSanteTerritoire>>) {
  return {
    niveau_etablissements: p.niveauEtablissements,
    densites: p.densitesProfessionnels,
    etablissements_par_famille: p.etablissementsParFamille,
    demande_commune: p.demande,
  };
}

/** Profil du bassin (rayon) — la DEMANDE actionnable. Résumé du BassinProfile. */
function summariseDemande(b: {
  population_bassin: number;
  age: unknown;
  csp: unknown;
  familles_avec_enfants: number;
  revenu_median_pondere: number | null;
  nb_iris_agreges: number;
  couverture: { revenu_pct_population: number; iris_revenu_manquants: number };
}) {
  return {
    population_bassin: b.population_bassin,
    age: b.age,
    csp: b.csp,
    familles_avec_enfants: b.familles_avec_enfants,
    revenu_median_pondere: b.revenu_median_pondere,
    nb_iris_agreges: b.nb_iris_agreges,
    couverture: b.couverture,
  };
}

export async function panoramaImplantationComplet(
  input: PanoramaImplantationInput,
): Promise<PanoramaImplantationResult> {
  const anchor = await resolveAnchor(input);
  const { point, codeInsee, codeDept, rayonKm, plmMode } = anchor;
  // Piège PLM (§4.5) : densité/territoire au niveau département (sinon RangeError
  // côté RPC, RPPS rattaché aux arrondissements). Les sections radius restent
  // sur le point — un rayon géographique n'a pas le problème PLM.
  const territoireKey = plmMode ? codeDept : codeInsee;

  const [
    territoire,
    demande,
    concurrents,
    pourvoyeurs,
    prescripteurs,
    cds,
    referentiels,
    freshness,
  ] = await Promise.all([
    runSection("territoire", async () =>
      summariseTerritoire(await panoramaSanteTerritoire({ codeInsee: territoireKey })),
    ),
    runSection("demande", async () => {
      const r = await getProfilIris({ point: { lon: point.lon, lat: point.lat }, rayonKm });
      if (!r.found) {
        throw new Error(`profil_iris: ${r.message}`);
      }
      if (r.mode !== "bassin") {
        throw new Error("profil_iris: mode îlot inattendu (rayon non pris en compte)");
      }
      return summariseDemande(r);
    }),
    runSection("concurrents", () => sectionConcurrents(point, rayonKm)),
    runSection("pourvoyeurs", () => sectionPourvoyeurs(point, rayonKm)),
    runSection("prescripteurs", () => sectionPrescripteurs(point, rayonKm)),
    runSection("cds", () => sectionCds(point, rayonKm)),
    runSection("referentiels", () => sectionReferentiels(point, rayonKm)),
    runSection("freshness", () => getDataFreshness()),
  ]);

  // FILOSOFI partiel (§4.5) : la demande est servie mais la couverture revenu
  // est incomplète → drapeau `partiel` explicite (le LLM relativise le revenu).
  let demandeStatus = demande.status;
  if (demande.status === "ok" && demande.data) {
    const pct = demande.data.couverture.revenu_pct_population;
    if (typeof pct === "number" && pct < 1) {
      demandeStatus = `partiel:revenu_pct_population=${pct}`;
    }
  }

  const couverture: Record<string, SectionStatus> = {
    territoire: territoire.status,
    demande: demandeStatus,
    concurrents: concurrents.status,
    pourvoyeurs: pourvoyeurs.status,
    prescripteurs: prescripteurs.status,
    cds: cds.status,
    referentiels: referentiels.status,
  };

  // Labels de sources tracées (freshness best-effort — jamais bloquant).
  const sources = (freshness.data ?? []).map(
    (row) => `${row.source} (maj ${row.last_success_at ?? "?"}, ${row.cadence_hint})`,
  );
  sources.push("IGN Géoplateforme (géocodage)");

  return {
    meta: {
      adresse_demandee: anchor.adresseDemandee,
      point: anchor.point,
      code_insee: anchor.codeInsee,
      code_dept: anchor.codeDept,
      commune: anchor.commune,
      rayon_km: anchor.rayonKm,
      geocode: { score: anchor.geocodeScore, confidence_low: anchor.confidenceLow },
      plm_mode: anchor.plmMode,
      sources,
      generated_at: new Date().toISOString(),
    },
    couverture,
    territoire: territoire.data,
    demande: demande.data,
    concurrents: concurrents.data,
    pourvoyeurs: pourvoyeurs.data,
    prescripteurs: prescripteurs.data,
    cds: cds.data,
    referentiels: referentiels.data,
  };
}
