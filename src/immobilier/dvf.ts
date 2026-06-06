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
import { DEFAULT_USER_AGENT, HttpError, fetchJson, fetchText } from "../core/http.js";
import { formatRpcError, validateCoords, validateRadiusKm } from "../sante/db-helpers.js";
import { getUntypedAnonClient, getUntypedServiceClient } from "../storage/supabase.js";
// Auto-import du module pour que `dvfInRadius` appelle `fetchCommunesInRadius`
// et `ensureCommuneCached` via la table d'exports — sinon ces appels intra-module
// se lient à la fonction locale et `vi.spyOn(dvfModule, …)` ne peut pas les
// intercepter (les tests devraient sinon descendre jusqu'au réseau/Supabase).
// Runtime strictement identique : c'est la même fonction, atteinte par le même
// binding ESM (live binding sur le namespace du module courant).
import * as self from "./dvf.js";

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

/**
 * Clés de `DvfMutation` dont la valeur est `string` — les seules valides dans une
 * clé de dédup `join` (un champ NUMERIC sérialisé en string par PostgREST, ou un
 * `number`/`null`, produirait une clé instable). Contraint `DVF_PK_COLS` au
 * compile-time (cf. `satisfies` ci-dessous).
 */
type DvfStringKey = {
  [K in keyof DvfMutation]: DvfMutation[K] extends string ? K : never;
}[keyof DvfMutation];

/**
 * Colonnes de la clé primaire composite de `dvf_mutations` — SOURCE UNIQUE qui
 * pilote À LA FOIS la clé de déduplication en mémoire ET la cible `onConflict`
 * de l'upsert. Les deux DOIVENT rester identiques : une clé de dédup qui diverge
 * de la cible de conflit réveille silencieusement le SQLSTATE 21000 (cf.
 * `upsertMutations`). Doit refléter le `PRIMARY KEY` de la migration
 * `20260606T120000_immobilier.sql`. Le `satisfies` interdit d'y mettre une
 * colonne non-`string` (qui casserait la clé `join` — garde-fou compile-time).
 */
const DVF_PK_COLS = [
  "id_mutation",
  "code_commune",
  "date_mutation",
  "type_local",
] as const satisfies readonly DvfStringKey[];

/** Cible `onConflict` de l'upsert, dérivée de la PK (source unique ci-dessus). */
export const DVF_ON_CONFLICT = DVF_PK_COLS.join(",");

/**
 * Clé de déduplication d'une mutation, dérivée de la même PK (source unique).
 * `date_mutation` est comparée comme STRING ISO `YYYY-MM-DD` (format canonique
 * geo-dvf, déjà `.trim()` au parse) — aligné sur le cast `DATE` de la PK Postgres.
 * Une représentation non canonique du même jour (`2025-1-2`) divergerait du cast
 * DB et pourrait ré-armer le 21000 ; geo-dvf garantit l'ISO.
 */
export function dvfPkKey(r: DvfMutation): string {
  return DVF_PK_COLS.map((c) => r[c]).join("|");
}

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
    let text: string;
    try {
      // `fetchText` applique la MÊME politique retry/backoff/429/5xx que `fetchJson`
      // (geo-DVF est sujet aux 429/5xx transitoires sous charge). `fetch` suit les
      // redirections (302) par défaut. Un 404 throw un `HttpError` immédiat (non
      // transitoire → pas de retry) que l'on rattrape pour le fallback année N-1.
      text = await fetchText(url, { headers: { "User-Agent": DEFAULT_USER_AGENT } });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        // Essai année précédente seulement si c'est la première tentative
        if (year === CURRENT_YEAR) continue;
        // Année précédente aussi absente → commune sans données DVF (cas
        // attendu, pas une erreur : on distingue « pas de données » de « panne »).
        console.warn(
          `[france-data-mcp] dvf fetchCommuneCsv(${insee}): aucune donnée DVF (404 sur ${CURRENT_YEAR} et ${CURRENT_YEAR - 1})`,
        );
        return { mutations: [], year };
      }
      if (err instanceof HttpError) {
        // 5xx épuisé après retries OU autre 4xx → erreur amont non récupérable.
        const msg = `[france-data-mcp] dvf fetchCommuneCsv(${insee}, year=${year}): HTTP ${err.status}`;
        console.error(msg);
        throw new Error(msg);
      }
      // Erreur réseau (DNS, socket, timeout) déjà retentée et épuisée par fetchText.
      const msg = `[france-data-mcp] dvf fetchCommuneCsv(${insee}, year=${year}): network error: ${(err as Error).message}`;
      console.error(msg);
      throw new Error(msg);
    }

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
  // Client service : `dvf_commune_cache` est une table INTERNE (RLS ON, aucune
  // policy anon — doctrine cache, cf. geocoded_addresses). Lecture/écriture du
  // cache via service_role uniquement ; le rôle anon n'y touche jamais.
  const supabase = getUntypedServiceClient();
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
 * Retourne le nombre de lignes RÉELLEMENT écrites (après dédoublonnage par PK) —
 * pour que le `row_count` du cache reflète l'état de la table, pas le nombre de
 * lignes CSV source (3107 lignes → 2073 écrites sur 50129, cf. dédup ci-dessous).
 */
export async function upsertMutations(rows: DvfMutation[]): Promise<number> {
  if (rows.length === 0) return 0;

  // Écriture du cache → client service (RLS bypass). Le rôle anon public n'a
  // PAS le droit d'écrire `dvf_mutations` (sinon n'importe quel porteur de la
  // clé anon pourrait polluer le cache de prix). Doctrine : anon lit, service écrit.
  const supabase = getUntypedServiceClient();

  // Dédoublonnage par clé primaire AVANT l'upsert. Le CSV DVF peut contenir
  // plusieurs lignes partageant la PK (ex. une vente à plusieurs lots du même
  // type) → Postgres `INSERT … ON CONFLICT` REJETTE TOUT le lot (« cannot affect
  // row a second time », SQLSTATE 21000 — prouvé prod sur 50129 : 3107 lignes →
  // 2073 clés uniques). Keep-last : on perd au plus 1 lot BÂTI par collision
  // (2 « Maison » distinctes même vente+date) → biais négligeable sur la médiane
  // €/m² communale, pas strictement nul. Dédup sur l'ENSEMBLE avant le batching
  // (clé `dvfPkKey` = cible `DVF_ON_CONFLICT`, même source) → couvre aussi une
  // collision inter-batch (même PK dans 2 slices différents).
  const byKey = new Map<string, DvfMutation>();
  for (const r of rows) {
    byKey.set(dvfPkKey(r), r);
  }
  const deduped = [...byKey.values()];

  // On insère par batch de 500 pour éviter les payloads trop lourds
  const BATCH = 500;
  for (let i = 0; i < deduped.length; i += BATCH) {
    const batch = deduped.slice(i, i + BATCH);

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
      { onConflict: DVF_ON_CONFLICT },
    );

    if (error) {
      throw new Error(formatRpcError("dvf_mutations upsert", error));
    }
  }

  return deduped.length;
}

/**
 * Marque une commune comme ingérée dans `dvf_commune_cache`.
 */
export async function markCommuneCached(
  insee: string,
  year: number,
  rowCount: number,
): Promise<void> {
  // Écriture du registre de cache → client service (table interne, cf. getCacheRow).
  const supabase = getUntypedServiceClient();
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

  // Cache absent ou périmé → ingestion. `row_count` du cache = lignes réellement
  // écrites (après dédup PK), pas le nombre de lignes CSV source.
  const { mutations, year } = await fetchCommuneCsv(insee);
  const written = await upsertMutations(mutations);
  await markCommuneCached(insee, year, written);
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

  // Résolution des communes dans le cercle via geo.api.gouv.fr.
  // Appel via `self.` (namespace du module) pour la testabilité — cf. import.
  const communeCodes = await self.fetchCommunesInRadius(lat, lon, radiusKm);

  // Cache paresseux : parallélisation plafonnée (Promise.allSettled pour ne pas
  // bloquer sur une commune sans données)
  const results = await Promise.allSettled(
    communeCodes.map((code) => self.ensureCommuneCached(code)),
  );

  // Log les échecs sans bloquer la requête principale, en comptant les rejets.
  let rejectedCount = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r && r.status === "rejected") {
      rejectedCount++;
      console.warn(
        `[france-data-mcp] dvfInRadius: ensureCommuneCached(${communeCodes[i] ?? "?"}) failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
    }
  }

  // Échec TOTAL de l'ingestion (toutes les communes ont échoué) : on NE PEUT PAS
  // distinguer « zéro vente » de « rien n'a pu être ingéré ». Retourner les rows
  // de la RPC ici afficherait un « 0 vente » faussement confiant (sous-estimation
  // silencieuse — la table peut contenir un cache périmé partiel ou rien). On
  // throw → `runSection("terrains")` dégrade en `indisponible:<raison>` au lieu
  // d'un `ok` mensonger. Échec PARTIEL (≥1 commune ok) : on procède avec la RPC
  // (les communes ingérées sont représentatives, les warns ci-dessus tracent le reste).
  if (communeCodes.length > 0 && rejectedCount === communeCodes.length) {
    const msg = `[france-data-mcp] dvfInRadius: ingestion totale échouée (${rejectedCount}/${communeCodes.length} communes) — section terrains indisponible (pas un « zéro vente »)`;
    console.error(msg);
    throw new Error(msg);
  }

  // Appel RPC — chemin de LECTURE public : client anon (couvert par la policy
  // "anon read dvf_mutations" FOR SELECT, miroir de finess_in_radius). La RPC
  // est SECURITY INVOKER → s'exécute sous anon → la policy SELECT est requise.
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

  // `fetchJson` applique retry/backoff/429/5xx (geo.api.gouv.fr renvoie parfois
  // une page d'erreur HTML transitoire → retentée comme un 5xx) + log non-silencieux.
  const communes = await fetchJson<GeoApiCommune[]>(url, {
    headers: { "User-Agent": DEFAULT_USER_AGENT },
  });

  // Garde-fou contrat : geo.api.gouv.fr DOIT renvoyer un tableau. Un objet
  // d'erreur (`{ code, message }`) passerait `.map` en runtime avec un crash
  // opaque — on échoue ici avec un message explicite (miroir du guard
  // `Array.isArray(data)` sur le retour RPC `dvf_in_radius`).
  if (!Array.isArray(communes)) {
    throw new Error(
      `[france-data-mcp] fetchCommunesInRadius: réponse inattendue (non-array) de ${url} — got ${typeof communes}`,
    );
  }

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
