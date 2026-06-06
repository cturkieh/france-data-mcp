/**
 * Service DVF (Demandes de Valeurs Foncières) — cache paresseux par commune.
 *
 * Source : geo-dvf (data.gouv.fr) — CSV par commune, URL canonique :
 *   https://files.data.gouv.fr/geo-dvf/latest/csv/<YEAR>/communes/<DEP>/<INSEE>.csv
 * (retourne 302 → fetch suit les redirections par défaut).
 *
 * Stratégie de cache :
 *   - `dvf_commune_cache` enregistre les communes déjà ingérées + date.
 *   - `ensureCommuneCached(insee, maxAgeDays)` court-circuite si la cache est
 *     fraîche ; sinon télécharge le CSV, upsert dans `dvf_mutations`, marque le
 *     cache.
 *   - `dvfInRadius(lat, lon, radiusKm)` résout les communes couvrant le cercle
 *     (via geo.api.gouv.fr `?lat=&lon=&distance_max=`), s'assure qu'elles sont
 *     cachées, puis appelle la RPC `dvf_in_radius`.
 */

import { parseCsv } from "../core/csv.js";
import { DEFAULT_USER_AGENT } from "../core/http.js";
import { formatRpcError, validateCoords, validateRadiusKm } from "../sante/db-helpers.js";
import { getUntypedAnonClient } from "../storage/supabase.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DvfMutation {
  id_mutation: string;
  /** NOT NULL côté DB (composant de la PK). Les rows CSV sans date sont skippées. */
  date_mutation: string;
  nature_mutation: string | null;
  valeur_fonciere: number | null;
  code_commune: string;
  /** NOT NULL DEFAULT '' côté DB (composant de la PK). `''` si type_local absent. */
  type_local: string;
  surface_reelle_bati: number | null;
  surface_terrain: number | null;
  /** Calculé : valeur_fonciere / surface_reelle_bati, null si non applicable. */
  prix_m2: number | null;
  longitude: number | null;
  latitude: number | null;
}

export interface DvfCacheRow {
  code_commune: string;
  fetched_at: string;
  source_year: number | null;
  row_count: number;
}

export interface DvfAggregate {
  prix_m2_median: number | null;
  prix_m2_p25: number | null;
  prix_m2_p75: number | null;
  n_ventes: number;
  n_terrains: number;
  prix_terrain_median: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Types de locaux « bâtis » pour lesquels le prix_m2 a un sens. */
const BUILT_TYPES = new Set(["Maison", "Appartement"]);

const GEO_DVF_BASE = "https://files.data.gouv.fr/geo-dvf/latest/csv";

/** Année de départ pour le fallback (on essaie CURRENT_YEAR → CURRENT_YEAR - 1). */
const CURRENT_YEAR = new Date().getFullYear();

// ---------------------------------------------------------------------------
// Dept prefix derivation
// ---------------------------------------------------------------------------

/**
 * Dérive le code département au format geo-dvf depuis un code INSEE commune.
 *
 * Règles :
 *  - Corse 2A/2B : le code INSEE commence par "2A" ou "2B" → département = "2A" | "2B"
 *  - DOM 97x : les 3 premiers chiffres (971-978) → département = "971" … "978"
 *  - Métropole + COM : 2 premiers chiffres
 *
 * geo-dvf organise les CSV sous `communes/<DEP>/` en respectant ces mêmes règles.
 */
export function deptPrefixFromInsee(codeInsee: string): string {
  if (codeInsee.startsWith("2A") || codeInsee.startsWith("2B")) {
    return codeInsee.slice(0, 2);
  }
  if (/^97[1-8]/.test(codeInsee)) {
    return codeInsee.slice(0, 3);
  }
  return codeInsee.slice(0, 2);
}

// ---------------------------------------------------------------------------
// CSV download & parse
// ---------------------------------------------------------------------------

export interface FetchCommuneCsvResult {
  mutations: DvfMutation[];
  /** Année effectivement utilisée (CURRENT_YEAR ou CURRENT_YEAR - 1 sur fallback). */
  year: number;
}

/**
 * Télécharge et parse le CSV DVF pour une commune.
 * Essaie CURRENT_YEAR en premier, puis CURRENT_YEAR - 1 sur 404.
 * Retourne `{ mutations, year }` — `year` est l'année RÉELLEMENT utilisée
 * (peut être CURRENT_YEAR - 1 sur fallback 404) pour que le cache estampille
 * la bonne valeur `source_year`.
 */
export async function fetchCommuneCsv(insee: string): Promise<FetchCommuneCsvResult> {
  const dept = deptPrefixFromInsee(insee);

  for (const year of [CURRENT_YEAR, CURRENT_YEAR - 1]) {
    const url = `${GEO_DVF_BASE}/${year}/communes/${dept}/${insee}.csv`;
    let response: Response;
    try {
      // fetch suit les redirections (302) par défaut (redirect: "follow" est le défaut)
      response = await fetch(url, {
        headers: { "User-Agent": DEFAULT_USER_AGENT },
        redirect: "follow",
      });
    } catch (err) {
      const msg = `[france-data-mcp] dvf fetchCommuneCsv(${insee}, year=${year}): network error: ${(err as Error).message}`;
      console.error(msg);
      throw new Error(msg);
    }

    if (response.status === 404) {
      // Essai année précédente seulement si c'est la première tentative
      if (year === CURRENT_YEAR) continue;
      // Année précédente aussi absente → commune sans données DVF
      return { mutations: [], year };
    }

    if (!response.ok) {
      throw new Error(
        `[france-data-mcp] dvf fetchCommuneCsv(${insee}, year=${year}): HTTP ${response.status}`,
      );
    }

    const text = await response.text();
    return { mutations: parseDvfCsv(insee, text, year), year };
  }

  // Les deux années ont retourné 404 (loop exhausted via continue above)
  return { mutations: [], year: CURRENT_YEAR - 1 };
}

/**
 * Parse le contenu CSV DVF d'une commune.
 * - Filtre les lignes sans lon/lat.
 * - Calcule prix_m2 pour les types bâtis avec surface > 0.
 */
function parseDvfCsv(codeCommune: string, csvText: string, _year: number): DvfMutation[] {
  const rows = parseCsv(csvText, { delimiter: "," });
  const mutations: DvfMutation[] = [];

  for (const row of rows) {
    const lon = Number.parseFloat(row.longitude ?? "");
    const lat = Number.parseFloat(row.latitude ?? "");

    // On ignore les lignes sans coordonnées valides
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    // date_mutation est composant de la PK (NOT NULL côté DB) : une row sans
    // date ne peut pas être insérée → on la skip (cohérent avec le skip lon/lat).
    const dateMutation = (row.date_mutation ?? "").trim();
    if (dateMutation === "") continue;

    const vf = Number.parseFloat(row.valeur_fonciere ?? "");
    const srb = Number.parseFloat(row.surface_reelle_bati ?? "");
    const st = Number.parseFloat(row.surface_terrain ?? "");
    // type_local est NOT NULL DEFAULT '' côté DB (composant de la PK) : un type
    // absent ou vide est normalisé en chaîne vide (cas terrain nu, dépendance…).
    const typeLocal = (row.type_local ?? "").trim();

    // prix_m2 : uniquement pour les types bâtis avec surface > 0
    let prix_m2: number | null = null;
    if (BUILT_TYPES.has(typeLocal) && Number.isFinite(srb) && srb > 0 && Number.isFinite(vf)) {
      prix_m2 = vf / srb;
    }

    mutations.push({
      id_mutation: row.id_mutation ?? "",
      date_mutation: dateMutation,
      nature_mutation: row.nature_mutation ?? null,
      valeur_fonciere: Number.isFinite(vf) ? vf : null,
      code_commune: row.code_commune ?? codeCommune,
      type_local: typeLocal,
      surface_reelle_bati: Number.isFinite(srb) && srb > 0 ? srb : null,
      surface_terrain: Number.isFinite(st) && st > 0 ? st : null,
      prix_m2,
      longitude: lon,
      latitude: lat,
    });
  }

  return mutations;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Lit la ligne de cache pour une commune (null si absente).
 */
export async function getCacheRow(insee: string): Promise<DvfCacheRow | null> {
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase
    .from("dvf_commune_cache")
    .select("code_commune, fetched_at, source_year, row_count")
    .eq("code_commune", insee)
    .limit(1);

  if (error) {
    throw new Error(formatRpcError("dvf_commune_cache select", error));
  }

  const rows = data as DvfCacheRow[] | null;
  return rows?.[0] ?? null;
}

/**
 * Upsert un lot de mutations dans `dvf_mutations`.
 * Utilise le client untyped car la table n'est pas encore dans les types générés.
 */
export async function upsertMutations(rows: DvfMutation[]): Promise<void> {
  if (rows.length === 0) return;

  const supabase = getUntypedAnonClient();

  // On insère par batch de 500 pour éviter les payloads trop lourds
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);

    // `geom` est une colonne GENERATED STORED (calculée par Postgres depuis
    // longitude/latitude) — elle NE DOIT PAS figurer dans le payload (Postgres
    // rejette toute écriture sur une colonne générée). Conflit résolu sur la PK
    // composite (id_mutation, code_commune, date_mutation, type_local).
    const { error } = await supabase.from("dvf_mutations").upsert(
      batch.map((r) => ({
        id_mutation: r.id_mutation,
        date_mutation: r.date_mutation,
        nature_mutation: r.nature_mutation,
        valeur_fonciere: r.valeur_fonciere,
        code_commune: r.code_commune,
        type_local: r.type_local,
        surface_reelle_bati: r.surface_reelle_bati,
        surface_terrain: r.surface_terrain,
        prix_m2: r.prix_m2,
        longitude: r.longitude,
        latitude: r.latitude,
      })),
      { onConflict: "id_mutation,code_commune,date_mutation,type_local" },
    );

    if (error) {
      throw new Error(formatRpcError("dvf_mutations upsert", error));
    }
  }
}

/**
 * Marque une commune comme ingérée dans `dvf_commune_cache`.
 */
export async function markCommuneCached(
  insee: string,
  year: number,
  rowCount: number,
): Promise<void> {
  const supabase = getUntypedAnonClient();
  const { error } = await supabase.from("dvf_commune_cache").upsert(
    {
      code_commune: insee,
      fetched_at: new Date().toISOString(),
      source_year: year,
      row_count: rowCount,
    },
    { onConflict: "code_commune" },
  );
  if (error) {
    throw new Error(formatRpcError("dvf_commune_cache upsert", error));
  }
}

// ---------------------------------------------------------------------------
// ensureCommuneCached
// ---------------------------------------------------------------------------

/**
 * S'assure que la commune est en cache. Short-circuit si `fetched_at` < maxAgeDays.
 * Sinon : télécharge le CSV, upsert les mutations, marque le cache.
 */
export async function ensureCommuneCached(insee: string, maxAgeDays = 180): Promise<void> {
  const cacheRow = await getCacheRow(insee);

  if (cacheRow) {
    const ageMs = Date.now() - new Date(cacheRow.fetched_at).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < maxAgeDays) {
      // Cache frais → no-op
      return;
    }
  }

  // Cache absent ou périmé → ingestion
  const { mutations, year } = await fetchCommuneCsv(insee);
  await upsertMutations(mutations);
  await markCommuneCached(insee, year, mutations.length);
}

// ---------------------------------------------------------------------------
// dvfInRadius
// ---------------------------------------------------------------------------

/**
 * Retourne les mutations DVF dans un rayon géographique.
 *
 * 1. Résout les communes couvrant le cercle via geo.api.gouv.fr.
 * 2. Pour chaque commune : `ensureCommuneCached`.
 * 3. Appelle la RPC `dvf_in_radius` et retourne les rows.
 */
export async function dvfInRadius(
  lat: number,
  lon: number,
  radiusKm: number,
): Promise<DvfMutation[]> {
  validateCoords(lat, lon);
  validateRadiusKm(radiusKm);

  // Résolution des communes dans le cercle via geo.api.gouv.fr
  const communeCodes = await fetchCommunesInRadius(lat, lon, radiusKm);

  // Cache paresseux : parallélisation plafonnée (Promise.allSettled pour ne pas
  // bloquer sur une commune sans données)
  const results = await Promise.allSettled(communeCodes.map((code) => ensureCommuneCached(code)));

  // Log les échecs sans bloquer la requête principale
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r && r.status === "rejected") {
      console.warn(
        `[france-data-mcp] dvfInRadius: ensureCommuneCached(${communeCodes[i] ?? "?"}) failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
    }
  }

  // Appel RPC
  const supabase = getUntypedAnonClient();
  const { data, error } = await supabase.rpc("dvf_in_radius", {
    p_lat: lat,
    p_lon: lon,
    p_radius_meters: radiusKm * 1000,
    p_limit: 500,
  });

  if (error) {
    throw new Error(formatRpcError("dvf_in_radius", error));
  }

  if (!Array.isArray(data)) {
    throw new Error(
      `[france-data-mcp] dvf_in_radius: RPC contract violation — expected array, got ${typeof data}`,
    );
  }

  return data as DvfMutation[];
}

// ---------------------------------------------------------------------------
// Commune resolution helper (geo.api.gouv.fr)
// ---------------------------------------------------------------------------

interface GeoApiCommune {
  code: string;
}

/**
 * Retourne les codes INSEE des communes dont le centre est à moins de
 * `radiusKm` km du point (lat, lon). Utilise le paramètre `?lat=&lon=`
 * de geo.api.gouv.fr qui tri par distance ascendante.
 *
 * Le paramètre `distance_max` en mètres est supporté par l'API DINUM
 * (communes dans le rayon). On plafonne à 50 km (= RADIUS_MAX_KM).
 */
export async function fetchCommunesInRadius(
  lat: number,
  lon: number,
  radiusKm: number,
): Promise<string[]> {
  const distanceMax = Math.round(radiusKm * 1000);
  const url = `https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&distance_max=${distanceMax}&fields=code&format=json&limit=50`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": DEFAULT_USER_AGENT },
    });
  } catch (err) {
    const msg = `[france-data-mcp] fetchCommunesInRadius: network error: ${(err as Error).message}`;
    console.error(msg);
    throw new Error(msg);
  }

  if (!response.ok) {
    throw new Error(`[france-data-mcp] fetchCommunesInRadius: HTTP ${response.status} on ${url}`);
  }

  const communes = (await response.json()) as GeoApiCommune[];
  return communes.map((c) => c.code);
}

// ---------------------------------------------------------------------------
// aggregatePrix
// ---------------------------------------------------------------------------

/**
 * Calcule les agrégats de prix à partir d'un tableau de mutations.
 *
 * - `prix_m2_median` / `_p25` / `_p75` : sur les ventes bâties avec prix_m2 non null.
 * - `n_terrains` : mutations avec surface_terrain > 0.
 * - `prix_terrain_median` : valeur_fonciere médiane des mutations terrains.
 */
export function aggregatePrix(rows: DvfMutation[]): DvfAggregate {
  // Prix m2 des ventes bâties
  const prixM2s = rows
    .filter((r) => r.prix_m2 !== null)
    .map((r) => r.prix_m2 as number)
    .sort((a, b) => a - b);

  const n_ventes = prixM2s.length;
  const prix_m2_median = n_ventes > 0 ? median(prixM2s) : null;
  const prix_m2_p25 = n_ventes > 0 ? percentile(prixM2s, 25) : null;
  const prix_m2_p75 = n_ventes > 0 ? percentile(prixM2s, 75) : null;

  // Terrains
  const terrainRows = rows.filter((r) => r.surface_terrain !== null && r.surface_terrain > 0);
  const n_terrains = terrainRows.length;

  const terrainPrix = terrainRows
    .filter((r) => r.valeur_fonciere !== null)
    .map((r) => r.valeur_fonciere as number)
    .sort((a, b) => a - b);

  const prix_terrain_median = terrainPrix.length > 0 ? median(terrainPrix) : null;

  return {
    prix_m2_median,
    prix_m2_p25,
    prix_m2_p75,
    n_ventes,
    n_terrains,
    prix_terrain_median,
  };
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? 0;
  return loVal + (hiVal - loVal) * frac;
}
