/**
 * Index local de communes pour le matching CP + nom de ville lors de
 * l'ingestion (notamment Annuaire Ameli). Permet de retrouver le centroïde
 * et le code INSEE à partir des seules colonnes `coordonnees_code_postal`
 * et `coordonnees_ville` qui figurent dans le CSV public.
 *
 * Usage attendu — étape one-shot d'un workflow d'ingestion :
 *
 * ```ts
 * const communes = await fetchAllCommunes();      // 35 000 communes, 1 appel
 * const index = buildCommuneIndex(communes);
 * for (const row of stream) {
 *   const match = matchCommune(index, row.cp, row.ville);
 *   if (!match) skipUnmatchedLocality();
 *   else insert({ ...row, lon: match.lon, lat: match.lat });
 * }
 * ```
 *
 * Le matching est volontairement strict + un fallback maîtrisé :
 *   1. clé exacte `${cp}|${norm(ville)}` → 1 commune
 *   2. fallback : si le CP ne dessert qu'UNE commune, accepter même si le
 *      nom ne match pas (typos / orthographe Ameli divergente)
 *   3. sinon échec — la ligne sera skippée et comptée
 *
 * Cette stratégie privilégie la précision : on préfère skipper une ligne
 * (compteur + alerte si > 5 %) plutôt que rattacher la ligne à la mauvaise
 * commune et pourrir les requêtes par rayon.
 */

import type { Commune } from "./communes.js";
import { deptFromCodeInsee } from "./dept-codes.js";

export interface IndexedCommune {
  /** Code INSEE 5 caractères. */
  codeInsee: string;
  /** Code département canonique (2 chars métropole/Corse, 3 chars DOM). */
  codeDepartement: string;
  lon: number;
  lat: number;
}

export interface CommuneIndex {
  /** Map `${cp5}|${normName}` → IndexedCommune. */
  byCpAndName: Map<string, IndexedCommune>;
  /**
   * Map `code INSEE` → IndexedCommune. Permet une résolution autoritaire
   * quand le code INSEE est déjà connu d'une source amont fiable (ex: pivot
   * FINESS pour les CDS), en contournant le matching fragile `(cp, ville)`
   * sensible aux adresses CEDEX.
   */
  byInsee: Map<string, IndexedCommune>;
  /** Map `${cp5}` → liste des communes indexables desservies (centre valide). */
  byCp: Map<string, IndexedCommune[]>;
  /**
   * Map `${cp5}` → nombre de communes RAW (incluant celles filtrées car
   * sans `centre` valide). Sert à détecter une ambiguïté cachée : si
   * geo.api.gouv déclare 2 communes pour ce CP mais une seule a un centre,
   * `byCp.length === 1` mais `byCpRawCount === 2` → on doit refuser le
   * fallback CP-unique pour éviter un faux positif silencieux.
   */
  byCpRawCount: Map<string, number>;
}

/**
 * Normalise un nom de ville pour le matching :
 *  - uppercase
 *  - supprime accents (NFD + suppression diacritiques)
 *  - "ST " → "SAINT ", "STE " → "SAINTE " (orthographe abrégée Ameli)
 *  - tirets, apostrophes, virgules, points → espaces
 *  - espaces multiples → simple espace, trim
 */
export function normalizeCityName(name: string): string {
  return (
    name
      .normalize("NFD")
      // Strip combining diacritical marks (U+0300–U+036F). Unicode escapes
      // (not literal combining chars) so Biome doesn't flag a misleading
      // "char + combining" character class.
      .replace(/\p{M}/gu, "")
      .toUpperCase()
      .replace(/[-'’,.]/g, " ")
      .replace(/\bST\b/g, "SAINT")
      .replace(/\bSTE\b/g, "SAINTE")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Normalise un code postal Ameli :
 *  - garde les 5 premiers caractères (strip CEDEX et trailing space)
 *  - retourne null si moins de 5 chiffres
 */
export function normalizeCp(cp: string): string | null {
  const m = cp.trim().match(/^\d{5}/);
  return m ? m[0] : null;
}

/**
 * Replie un code INSEE d'arrondissement municipal sur le code de sa commune
 * parente. FINESS (et RPPS) portent l'INSEE arrondissement pour Paris / Lyon
 * / Marseille (ex 75112 = Paris 12e), alors que geo.api.gouv `/communes`
 * n'expose que la commune unique (75056 / 69123 / 13055) — sans ce repli, le
 * pivot FINESS rate 100 % des établissements de ces 3 villes (où les CDS
 * municipaux sont les plus concentrés). Ranges officiels INSEE :
 *  - Paris      75101–75120 → 75056
 *  - Lyon       69381–69389 → 69123
 *  - Marseille  13201–13216 → 13055
 * Tout autre code est rendu inchangé.
 */
export function parentCommuneInsee(codeInsee: string): string {
  if (codeInsee >= "75101" && codeInsee <= "75120") return "75056";
  if (codeInsee >= "69381" && codeInsee <= "69389") return "69123";
  if (codeInsee >= "13201" && codeInsee <= "13216") return "13055";
  return codeInsee;
}

/**
 * Bornes WGS84 enveloppant France métropole + DOM-TOM (Polynésie côté ouest,
 * Mayotte/Réunion côté est, Manche côté nord, Polynésie côté sud). Tout
 * `centre` hors de cette boîte signale un payload geo.api.gouv corrompu —
 * on refuse de l'indexer pour ne pas insérer des PS au milieu de l'océan.
 */
const FR_LON_MIN = -65;
const FR_LON_MAX = 60;
const FR_LAT_MIN = -25;
const FR_LAT_MAX = 52;

function isValidFrenchCoord(lon: number, lat: number): boolean {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= FR_LON_MIN &&
    lon <= FR_LON_MAX &&
    lat >= FR_LAT_MIN &&
    lat <= FR_LAT_MAX
  );
}

/**
 * Construit l'index à partir de la liste retournée par `fetchAllCommunes()`.
 * Communes sans `centre` valide ou sans `codesPostaux` sont ignorées et
 * comptées séparément dans `byCpRawCount`, pour permettre à `matchCommune`
 * de détecter une ambiguïté cachée lors du fallback CP-unique.
 *
 * Throw si plus de 1 % des communes ne sont pas indexables — c'est le signal
 * d'un payload geo.api.gouv corrompu, on ne continue pas silencieusement.
 */
export function buildCommuneIndex(communes: Commune[]): CommuneIndex {
  const byCpAndName = new Map<string, IndexedCommune>();
  const byInsee = new Map<string, IndexedCommune>();
  const byCp = new Map<string, IndexedCommune[]>();
  const byCpRawCount = new Map<string, number>();

  let dropped = 0;
  for (const c of communes) {
    // Track raw counts BEFORE filtering, even for communes we won't index —
    // ça permet à `matchCommune` de détecter qu'une commune homonyme du même
    // CP a été filtrée (sans centre) et de refuser le fallback CP-unique.
    for (const cp of c.codesPostaux) {
      const cp5 = normalizeCp(cp);
      if (!cp5) continue;
      byCpRawCount.set(cp5, (byCpRawCount.get(cp5) ?? 0) + 1);
    }

    if (
      !c.centre ||
      c.codesPostaux.length === 0 ||
      !isValidFrenchCoord(c.centre.lon, c.centre.lat)
    ) {
      dropped++;
      continue;
    }
    // Fall back to a derived dept when geo.api.gouv didn't ship one — the
    // shared helper handles Corse/DOM. The non-null assertion is justified:
    // we already filtered codeInsee through `c.codesPostaux.length > 0` and
    // geo.api.gouv guarantees a 5-char `code`, so deptFromCodeInsee always
    // returns a string here.
    const codeDepartement = c.codeDepartement ?? deptFromCodeInsee(c.code) ?? c.code.slice(0, 2);
    const indexed: IndexedCommune = {
      codeInsee: c.code,
      codeDepartement,
      lon: c.centre.lon,
      lat: c.centre.lat,
    };
    byInsee.set(c.code, indexed);
    const normName = normalizeCityName(c.nom);
    for (const cp of c.codesPostaux) {
      const cp5 = normalizeCp(cp);
      if (!cp5) continue;
      const key = `${cp5}|${normName}`;
      byCpAndName.set(key, indexed);
      const list = byCp.get(cp5);
      if (list) list.push(indexed);
      else byCp.set(cp5, [indexed]);
    }
  }

  // geo.api.gouv ships ~35 K communes en prod ; ~5 sont typiquement
  // non-indexables. À l'échelle du payload réel (>= 1 000 communes), 1 %
  // dropped = ~350 unités, bien au-delà du steady-state — signal robuste
  // d'une régression payload. On ne déclenche le check que sur du data
  // taille prod, sinon les fixtures de tests (petites) feraient false
  // positive sur la moindre commune sans centre.
  if (communes.length >= 1000 && dropped / communes.length > 0.01) {
    throw new Error(
      `[france-data-mcp] commune index build dropped ${dropped}/${communes.length} communes (>1%). Likely geo.api.gouv payload regression — refuse to silently lose coverage.`,
    );
  }

  return { byCpAndName, byInsee, byCp, byCpRawCount };
}

/**
 * Cherche la commune correspondant à un couple `(CP, ville)` :
 *  1. clé exacte `cp|normalize(ville)`
 *  2. fallback : si le CP ne dessert qu'une seule commune, on accepte
 *     même quand le nom diverge (orthographe Ameli ≠ INSEE)
 *  3. échec → null (ligne sera skippée upstream avec compteur)
 */
export function matchCommune(
  index: CommuneIndex,
  cp: string | null | undefined,
  ville: string | null | undefined,
): IndexedCommune | null {
  if (!cp) return null;
  const cp5 = normalizeCp(cp);
  if (!cp5) return null;

  if (ville) {
    const exact = index.byCpAndName.get(`${cp5}|${normalizeCityName(ville)}`);
    if (exact) return exact;
  }

  // Fallback CP-unique : si le CP ne dessert qu'une commune, on prend —
  // MAIS uniquement si le raw count (avant filtrage) confirme aussi 1.
  // Sinon, c'est qu'une commune homonyme du même CP a été filtrée (sans
  // centre) et on risque un faux positif silencieux.
  const candidates = index.byCp.get(cp5);
  const rawCount = index.byCpRawCount.get(cp5) ?? 0;
  if (candidates && candidates.length === 1 && rawCount === 1) {
    return candidates[0] ?? null;
  }

  return null;
}
