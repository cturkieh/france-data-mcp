/**
 * `profil_iris` — profil démographique d'un îlot ou d'un bassin (Phase B
 * étape 5). CONTRAT consommé par GEO Intel (docs/plans/iris-infracommunal.md §5).
 *
 * 3 règles d'agrégation LOAD-BEARING (responsabilité serveur MCP) :
 *  - R1 — Revenu : PROXY (moyenne pondérée population des médianes d'îlots
 *    COUVERTS FILOSOFI), JAMAIS « médiane du bassin » (la médiane d'une union ≠
 *    moyenne des médianes). Exposé `revenu_median_pondere` + `couverture`.
 *  - R2 — Inclusion par CENTROÏDE dans le rayon (fait en SQL, `iris_in_radius`) :
 *    chaque îlot compté 1 fois. PAS « intersectant le disque » (surcompte).
 *  - R3 — Parts (âge, CSP) sur COMPTES BRUTS : Σ(catégorie) / Σ(total), jamais
 *    une moyenne de pourcentages d'îlots.
 *
 * R1/R3 sont calculés ICI en TS pur (`aggregateBassin`) → unit-testables sans
 * DB (mandat spec §7). R2 (le spatial) est dans la RPC.
 */

import { type LookupResult, lookupFound, lookupNotFound } from "../core/lookup-result.js";
import {
  type IrisProfilRow,
  assertIrisCode,
  fetchIrisAtPoint,
  fetchIrisInRadius,
  fetchIrisInRadiusOfCode,
  fetchIrisProfilByCode,
} from "./iris-db.js";

/** Borne du rayon : au-delà ce n'est plus un « bassin quartier ». */
const MAX_RAYON_KM = 10;

const RP_SOURCE = "INSEE RP 2022 (âge, CSP, familles) + FILOSOFI 2021 (revenu), niveau IRIS";

/** Parts CSP exposées (sur Σ pop_15p). Clés = libellés produits stables. */
export interface CspParts {
  agriculteurs: number | null;
  artisans_comm: number | null;
  cadres: number | null;
  prof_interm: number | null;
  employes: number | null;
  ouvriers: number | null;
  retraites: number | null;
  autres: number | null;
}

export interface AgeParts {
  part_65_plus: number | null;
  part_75_plus: number | null;
}

/** Profil d'un îlot unique (mode sans rayon). */
export interface IletProfile {
  mode: "ilot";
  code_iris: string;
  code_commune: string;
  libelle: string | null;
  type_iris: string | null;
  population: number;
  age: AgeParts;
  csp: CspParts;
  familles_avec_enfants: number | null;
  /** Médiane RÉELLE de l'îlot (€/UC), `null` hors couverture FILOSOFI. */
  revenu_median: number | null;
  taux_pauvrete: number | null;
  source: string;
}

/** Profil agrégé d'un bassin (mode avec rayon). */
export interface BassinProfile {
  mode: "bassin";
  rayon_km: number;
  nb_iris_agreges: number;
  population_bassin: number;
  age: AgeParts;
  csp: CspParts;
  familles_avec_enfants: number;
  /** R1 — PROXY (moyenne pondérée des médianes), pas une vraie médiane de bassin. */
  revenu_median_pondere: number | null;
  couverture: {
    /** Part de la population du bassin couverte par FILOSOFI (0-1). */
    revenu_pct_population: number;
    /** Nombre d'îlots du bassin sans donnée revenu (communes < 5000 hab). */
    iris_revenu_manquants: number;
  };
  source: string;
}

export interface ProfilIrisInput {
  point?: { lon: number; lat: number };
  codeIris?: string;
  rayonKm?: number;
}

// Coercition finite-safe : un NUMERIC corrompu (string non numérique via
// PostgREST) → 0 au lieu de NaN qui empoisonnerait toute la Σ du bassin servie
// en `found` (asymétrie évitée vs getPopulationByIris). null → 0 (somme neutre).
const n = (v: number | null): number => {
  if (v == null) return 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Part `numerateur / denominateur`, arrondie à 4 décimales, `null` si denom ≤ 0. */
function part(numerateur: number, denominateur: number): number | null {
  if (denominateur <= 0) return null;
  return Math.round((numerateur / denominateur) * 10000) / 10000;
}

function cspParts(sums: Record<keyof CspParts, number>, pop15p: number): CspParts {
  return {
    agriculteurs: part(sums.agriculteurs, pop15p),
    artisans_comm: part(sums.artisans_comm, pop15p),
    cadres: part(sums.cadres, pop15p),
    prof_interm: part(sums.prof_interm, pop15p),
    employes: part(sums.employes, pop15p),
    ouvriers: part(sums.ouvriers, pop15p),
    retraites: part(sums.retraites, pop15p),
    autres: part(sums.autres, pop15p),
  };
}

/** Profil d'un îlot unique (parts R3 sur ses propres comptes). PURE. */
export function buildIletProfile(row: IrisProfilRow): IletProfile {
  const pop15p = n(row.pop_15p);
  const cspSums = {
    agriculteurs: n(row.csp_agriculteurs),
    artisans_comm: n(row.csp_artisans_comm),
    cadres: n(row.csp_cadres),
    prof_interm: n(row.csp_prof_interm),
    employes: n(row.csp_employes),
    ouvriers: n(row.csp_ouvriers),
    retraites: n(row.csp_retraites),
    autres: n(row.csp_autres),
  };
  const popTotal = n(row.pop_total);
  const famAvecEnf =
    row.couples_avec_enfants == null && row.familles_monoparentales == null
      ? null
      : n(row.couples_avec_enfants) + n(row.familles_monoparentales);
  return {
    mode: "ilot",
    code_iris: row.code_iris,
    code_commune: row.code_commune,
    libelle: row.libelle,
    type_iris: row.type_iris,
    population: Math.round(popTotal),
    age: {
      part_65_plus: part(n(row.pop_65p), popTotal),
      part_75_plus: part(n(row.pop_75p), popTotal),
    },
    csp: cspParts(cspSums, pop15p),
    familles_avec_enfants: famAvecEnf == null ? null : Math.round(famAvecEnf),
    revenu_median: row.revenu_median,
    taux_pauvrete: row.taux_pauvrete,
    source: RP_SOURCE,
  };
}

/**
 * Agrégat de bassin (R1 + R3 + couverture). PURE — les lignes en entrée sont
 * DÉJÀ sélectionnées par centroïde (R2) côté RPC. Σ sur comptes BRUTS (décimaux
 * INSEE conservés pour la précision ; population arrondie en sortie).
 */
export function aggregateBassin(rows: IrisProfilRow[], rayonKm: number): BassinProfile {
  let pop = 0;
  let pop65 = 0;
  let pop75 = 0;
  let pop15p = 0;
  let famEnf = 0;
  const csp = {
    agriculteurs: 0,
    artisans_comm: 0,
    cadres: 0,
    prof_interm: 0,
    employes: 0,
    ouvriers: 0,
    retraites: 0,
    autres: 0,
  };
  // R1 : numérateur Σ(médiane × pop) et dénominateur Σ(pop) sur les SEULS îlots
  // couverts FILOSOFI ; `popCouverte` sert aussi au taux de couverture.
  let revNum = 0;
  let popCouverte = 0;
  let irisRevenuManquants = 0;

  for (const r of rows) {
    pop += n(r.pop_total);
    pop65 += n(r.pop_65p);
    pop75 += n(r.pop_75p);
    pop15p += n(r.pop_15p);
    famEnf += n(r.couples_avec_enfants) + n(r.familles_monoparentales);
    csp.agriculteurs += n(r.csp_agriculteurs);
    csp.artisans_comm += n(r.csp_artisans_comm);
    csp.cadres += n(r.csp_cadres);
    csp.prof_interm += n(r.csp_prof_interm);
    csp.employes += n(r.csp_employes);
    csp.ouvriers += n(r.csp_ouvriers);
    csp.retraites += n(r.csp_retraites);
    csp.autres += n(r.csp_autres);
    if (r.revenu_median != null && r.pop_total != null) {
      // Pondération par la population de l'îlot (proxy R1).
      revNum += r.revenu_median * r.pop_total;
      popCouverte += r.pop_total;
    } else {
      // Revenu absent OU non pondérable (pop_total null) → compté MANQUANT, jamais
      // avalé silencieusement (un îlot couvert mais sans pop, quasi inexistant
      // car FILOSOFI dérive du RP, ne doit pas disparaître de la couverture).
      irisRevenuManquants++;
    }
  }

  return {
    mode: "bassin",
    rayon_km: rayonKm,
    nb_iris_agreges: rows.length,
    population_bassin: Math.round(pop),
    age: {
      part_65_plus: part(pop65, pop),
      part_75_plus: part(pop75, pop),
    },
    csp: cspParts(csp, pop15p),
    familles_avec_enfants: Math.round(famEnf),
    revenu_median_pondere: popCouverte > 0 ? Math.round(revNum / popCouverte) : null,
    couverture: {
      revenu_pct_population: part(popCouverte, pop) ?? 0,
      iris_revenu_manquants: irisRevenuManquants,
    },
    source: RP_SOURCE,
  };
}

function assertRayon(rayonKm: number): void {
  if (!Number.isFinite(rayonKm) || rayonKm <= 0 || rayonKm > MAX_RAYON_KM) {
    throw new RangeError(
      `rayon_km doit être un nombre dans ]0, ${MAX_RAYON_KM}] (un bassin au-delà n'est plus une analyse de quartier).`,
    );
  }
}

/**
 * Profil IRIS — îlot seul (sans rayon) OU bassin (avec rayon). Entrée :
 * EXACTEMENT un de `point {lon,lat}` ou `codeIris`. Retourne un `LookupResult`
 * discriminé (`not_found` motivé : code absent, ou point hors IRIS/mer).
 */
export async function getProfilIris(
  input: ProfilIrisInput,
): Promise<LookupResult<IletProfile | BassinProfile>> {
  const hasPoint = input.point !== undefined;
  const hasCode = input.codeIris !== undefined;
  if (hasPoint === hasCode) {
    throw new RangeError(
      "Fournir EXACTEMENT un de `point` {lon, lat} OU `code_iris` (pas les deux, pas aucun).",
    );
  }
  const code = input.codeIris?.trim();
  if (code !== undefined) assertIrisCode(code);
  const point = input.point;
  if (point && (!Number.isFinite(point.lon) || !Number.isFinite(point.lat))) {
    throw new RangeError("`point` doit fournir `lon` et `lat` numériques.");
  }

  // ── Mode ÎLOT (sans rayon) ──────────────────────────────────────────────
  if (input.rayonKm === undefined) {
    const row =
      code !== undefined
        ? await fetchIrisProfilByCode(code)
        : await fetchIrisAtPoint(
            (point as { lon: number; lat: number }).lon,
            (point as { lon: number; lat: number }).lat,
          );
    if (!row) {
      const key = code ?? `${point?.lon},${point?.lat}`;
      return lookupNotFound(
        key,
        code !== undefined
          ? `IRIS "${code}" absent du référentiel (contours IGN 2024).`
          : "Aucun IRIS ne contient ce point (hors métropole, en mer, ou coordonnées invalides).",
      );
    }
    return lookupFound(buildIletProfile(row));
  }

  // ── Mode BASSIN (avec rayon) ────────────────────────────────────────────
  assertRayon(input.rayonKm);
  const rayonM = input.rayonKm * 1000;
  const rows =
    code !== undefined
      ? await fetchIrisInRadiusOfCode(code, rayonM)
      : await fetchIrisInRadius(
          (point as { lon: number; lat: number }).lon,
          (point as { lon: number; lat: number }).lat,
          rayonM,
        );
  if (rows.length === 0) {
    // code_iris : un code valide inclut TOUJOURS son propre centroïde → 0 ligne
    // = code absent. point : aucun centroïde d'IRIS dans le rayon (mer/étranger).
    const key = code ?? `${point?.lon},${point?.lat}`;
    return lookupNotFound(
      key,
      code !== undefined
        ? `IRIS "${code}" absent du référentiel — bassin impossible.`
        : "Aucun IRIS dans ce rayon (point hors métropole ou en mer).",
    );
  }
  return lookupFound(aggregateBassin(rows, input.rayonKm));
}
