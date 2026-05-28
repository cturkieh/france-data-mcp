/**
 * `enrichir_concurrents` — vague d'enrichissement (spec §5). Enquête approfondie
 * sur le top concurrents renvoyé par `panorama_implantation_complet` :
 *  - `inspect_site` (statut + équipe + historique),
 *  - `compare_raison_sociale_finess_vs_rpps` (signal M&A : rebranding en cours),
 *  - `entreprise_by_siren` (groupe parent : Biogroup / Cerballiance / …).
 *
 * Cap dur `max=3` (`inspect_site` ~7 K tokens/appel — jamais 10+). Dégradation
 * PAR concurrent (drapeau `couverture` individuel) : un concurrent qui échoue
 * n'annule pas les autres. Même doctrine non silencieuse que le socle (§4.4).
 */

import { compareRaisonSocialeFinessVsRpps } from "./cross-source.js";
import { getEntrepriseBySiren } from "./dinum.js";
import { type InspectSiteResult, inspectSite } from "./inspect-site.js";

const LOG_TAG = "[france-data-mcp] enrichir_concurrents";
const MAX_DEFAUT = 3;
/** Seuil heuristique « grand groupe » (réseau national type Biogroup/Cerballiance). */
const GRAND_GROUPE_SEUIL = 10;

export interface EnrichirConcurrentsInput {
  /** FINESS à enquêter (typiquement `concurrents.top[0..2].finess` du socle). */
  finess: string[];
  /** Cap dur. Défaut 3. */
  max?: number;
}

export interface ConcurrentGroupe {
  siren: string;
  denomination: string;
  nombre_etablissements: number | null;
  est_grand_groupe: boolean;
}

export interface ConcurrentMaSignal {
  rebranding_detecte: boolean;
  statut_comparaison: string;
  finess_raison_sociale: string;
  rpps_raisons_sociales: string[];
}

export interface ConcurrentEnrichi {
  finess: string;
  raison_sociale: string | null;
  /** `true` actif / `false` fermé / `null` indéterminé (verdict site FINESS+SIRENE). */
  statut_actif: boolean | null;
  /** Taille de l'échantillon PS rattaché (pas le total — cf. inspect_site). */
  equipe_count: number | null;
  historique_recent: InspectSiteResult["historique"] | null;
  ma_signal: ConcurrentMaSignal | null;
  groupe: ConcurrentGroupe | null;
  couverture: "ok" | `partiel:${string}`;
}

export interface EnrichirConcurrentsResult {
  concurrents: ConcurrentEnrichi[];
  meta: { sources: string[]; generated_at: string };
}

/** SIREN du groupe parent : SIREN exploré DINUM, sinon dérivé du SIRET best_match. */
function extractSiren(inspect: InspectSiteResult): string | null {
  const explored = inspect.statut_site.sirens_explored;
  if (explored.length > 0) return explored[0] ?? null;
  const siret = inspect.statut_site.best_match_siret;
  return siret && siret.length >= 9 ? siret.slice(0, 9) : null;
}

function verdictToActif(verdict: InspectSiteResult["statut_site"]["verdict_site"]): boolean | null {
  if (verdict === "actif") return true;
  if (verdict === "ferme") return false;
  return null;
}

/** Enquête un concurrent. Toute erreur/absence → `partiel:<raison>` (jamais throw). */
async function enrichirUn(finess: string): Promise<ConcurrentEnrichi> {
  // inspect + compare : socle de l'enquête. Si CE bloc échoue, rien d'exploitable.
  let inspectR: Awaited<ReturnType<typeof inspectSite>>;
  let compareR: Awaited<ReturnType<typeof compareRaisonSocialeFinessVsRpps>>;
  try {
    [inspectR, compareR] = await Promise.all([
      inspectSite({ numFiness: finess, historiqueDetail: false }),
      compareRaisonSocialeFinessVsRpps(finess),
    ]);
  } catch (err) {
    const raison = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_TAG}: concurrent ${finess} — inspect/compare en échec : ${raison}`);
    return partiel(finess, raison);
  }

  if (!inspectR.found) {
    return partiel(finess, `inspect_site: ${inspectR.message}`);
  }

  // Groupe parent ISOLÉ dans son propre try : un échec `entreprise_by_siren` ne
  // doit PAS jeter les données inspect/compare déjà obtenues (statut, équipe,
  // historique, signal M&A). Sur échec → `groupe: null` + drapeau précis, mais
  // le reste reste servi (review silent-failure §2 — anti perte de données).
  const siren = extractSiren(inspectR);
  let groupe: ConcurrentGroupe | null = null;
  let couverture: ConcurrentEnrichi["couverture"] = "ok";
  if (siren) {
    try {
      const groupeR = await getEntrepriseBySiren(siren);
      if (groupeR.found) {
        groupe = {
          siren: groupeR.siren,
          denomination: groupeR.nomComplet,
          nombre_etablissements: groupeR.nombreEtablissements ?? null,
          est_grand_groupe: (groupeR.nombreEtablissements ?? 0) >= GRAND_GROUPE_SEUIL,
        };
      }
    } catch (err) {
      const raison = err instanceof Error ? err.message : String(err);
      console.warn(
        `${LOG_TAG}: concurrent ${finess} — groupe SIREN ${siren} indisponible : ${raison}`,
      );
      couverture = `partiel:groupe_siren:${raison}`;
    }
  }

  const ma_signal: ConcurrentMaSignal | null = compareR.found
    ? {
        rebranding_detecte: compareR.statut === "divergent_after_normalization",
        statut_comparaison: compareR.statut,
        finess_raison_sociale: compareR.finess_raison_sociale,
        rpps_raisons_sociales: compareR.rpps_raisons_sociales,
      }
    : null;

  return {
    finess,
    raison_sociale: inspectR.finess.raison_sociale,
    statut_actif: verdictToActif(inspectR.statut_site.verdict_site),
    equipe_count: inspectR.professionnels.count,
    historique_recent: inspectR.historique,
    ma_signal,
    groupe,
    couverture,
  };
}

/** Concurrent dégradé : drapeau `partiel` + `console.warn` (jamais silencieux). */
function partiel(finess: string, raison: string): ConcurrentEnrichi {
  console.warn(`${LOG_TAG}: concurrent ${finess} partiel — ${raison}`);
  return {
    finess,
    raison_sociale: null,
    statut_actif: null,
    equipe_count: null,
    historique_recent: null,
    ma_signal: null,
    groupe: null,
    couverture: `partiel:${raison}`,
  };
}

export async function enrichirConcurrents(
  input: EnrichirConcurrentsInput,
): Promise<EnrichirConcurrentsResult> {
  const max = input.max ?? MAX_DEFAUT;
  // Dedup + cap dur (jamais 10+ inspect_site, ~7K tokens chacun).
  const cibles = [...new Set(input.finess)].slice(0, max);

  const concurrents = await Promise.all(cibles.map(enrichirUn));

  return {
    concurrents,
    meta: {
      sources: ["FINESS/ANS", "RPPS/ANS", "SIRENE/DINUM"],
      generated_at: new Date().toISOString(),
    },
  };
}
