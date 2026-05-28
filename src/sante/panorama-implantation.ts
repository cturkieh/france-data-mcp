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

import { plmDept } from "../territoire/commune-index.js";
import { deptFromCodeInsee } from "../territoire/dept-codes.js";
import { geocode } from "../territoire/geocode.js";

const LOG_TAG = "[france-data-mcp] panorama_implantation_complet";

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

export async function panoramaImplantationComplet(
  input: PanoramaImplantationInput,
): Promise<PanoramaImplantationResult> {
  const anchor = await resolveAnchor(input);

  // Sections câblées en Task 3 (Promise.all). Pour l'instant : meta + ancrage.
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
      sources: [],
      generated_at: new Date().toISOString(),
    },
    couverture: {},
    territoire: null,
    demande: null,
    concurrents: null,
    pourvoyeurs: null,
    prescripteurs: null,
    cds: null,
    referentiels: null,
  };
}
