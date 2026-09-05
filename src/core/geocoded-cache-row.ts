// Ligne du cache `geocoded_addresses` telle que rendue par la RPC
// `rpps_geocoded_cache_lookup` (JSONB agrégé, lue par `scripts/ban-backfill.mjs`)
// et règle « rejet PÉRIMÉ ». Vit dans `core/` (même seam que `ban-last-status.ts`
// / `normalizeAddressKey`) pour être TYPÉE et testée : le backfill est un `.mjs`
// hors `tsc`, un renommage de champ RPC y dégraderait en `undefined` silencieux.

import { meetsBanAcceptanceGate } from "./ban-bulk-client.js";
import type { BanLastStatus } from "./ban-last-status.js";

/**
 * Forme JSONB d'une ligne de cache. Les 3 champs de GATE (`ban_last_status`,
 * `result_score`, `result_type`) existent depuis la migration `20260905T180000` ;
 * optionnels tant qu'une RPC pré-migration peut répondre — `hasGateFields` le
 * détecte pour que le caller le DISE (fenêtre push-code ↔ apply-migration).
 * `result_score` est `DOUBLE PRECISION` (arrive en number via JSONB) ; `string`
 * toléré par défense (évolution de type de colonne, sérialisation PostgREST).
 */
export type GeocodedCacheRow = {
  address_key: string;
  accepted: boolean;
  ban_attempt_count: number;
  ban_last_status?: BanLastStatus | string | null;
  result_score?: number | string | null;
  result_type?: string | null;
};

/** Vrai si la ligne porte les 3 champs de gate (RPC ≥ 20260905T180000). */
export function hasGateFields(row: GeocodedCacheRow): boolean {
  return "ban_last_status" in row && "result_score" in row && "result_type" in row;
}

export type StaleRejectionOptions = {
  /** Seuil d'acceptation courant (`BAN_ACCEPT_SCORE` côté backfill). */
  scoreThreshold: number;
  /**
   * `ban_attempt_count` à partir duquel une clé n'est PLUS JAMAIS re-soumise, même
   * périmée = `BAN_MAX_ATTEMPTS + 1` : UNE tentative au-delà du cap. Sans cette
   * borne, une ligne à score/type acceptables mais coords invalides (rejetée par
   * `hasCoords` côté client, score et type persistés) redeviendrait « périmée » à
   * chaque run, indéfiniment.
   */
  resubmitCap: number;
};

/**
 * REJET PÉRIMÉ : une clé `rejected_low_score`, figée par le cap de tentatives,
 * dont le cache porte ENCORE un résultat que le gate ACTUEL (`meetsBanAcceptanceGate`,
 * source unique) accepterait → rejetée sous une règle PLUS STRICTE (gate 0,7 du
 * 2026-05-18, assoupli à 0,5 le 2026-05-19). Le cap protège d'une adresse
 * durablement irrésolue, pas d'un changement de règle. Prouvé prod 2026-09-05 :
 * 9 305 clés (toutes à attempts=3, géocodées le 2026-05-18), 15 903 lignes `rpps`
 * au centroïde ; échantillon re-géocodé 248 → 247 acceptées. Les coords ayant été
 * nullifiées au rejet, seule une re-soumission peut les récupérer.
 *
 * Défense boundary : `ban_attempt_count` ou `result_score` illisibles → `false` +
 * `console.warn` (jamais muet — un `undefined < cap` silencieux re-soumettrait à
 * l'infini ; `Number(null) === 0` accepterait un score absent).
 */
export function isStaleRejection(row: GeocodedCacheRow, opts: StaleRejectionOptions): boolean {
  if (row.accepted || row.ban_last_status !== "rejected_low_score") return false;
  const attempts = Number(row.ban_attempt_count);
  if (!Number.isFinite(attempts)) {
    console.warn(
      `[france-data-mcp] geocoded_addresses: ban_attempt_count illisible (${String(row.ban_attempt_count)}) pour ${row.address_key} — clé ignorée`,
    );
    return false;
  }
  if (attempts >= opts.resubmitCap) return false;
  return meetsBanAcceptanceGate(
    { resultScore: cacheScore(row), resultType: row.result_type ?? null },
    opts.scoreThreshold,
  );
}

function cacheScore(row: GeocodedCacheRow): number | null {
  const raw = row.result_score;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  console.warn(
    `[france-data-mcp] geocoded_addresses: result_score illisible ("${String(raw)}") pour ${row.address_key} — traité comme null`,
  );
  return null;
}
