// Client de géocodage de masse via l'API BAN bulk CSV (api-adresse.data.gouv.fr).
// POST multipart/form-data (un CSV en pièce jointe), réponse CSV. Best-effort :
// un chunk en échec après retries incrémente `apiFailures` sans jamais throw —
// le caller (pipeline) doit pouvoir observer le taux d'échec même BAN-down total.

import { backoffDelayMs, sleep } from "./backoff.js";
import { parseCsvLine } from "./csv.js";
import { isTransientHttpStatus } from "./http.js";

export type BanGeocodeResult = {
  accepted: boolean;
  lat: number | null;
  lon: number | null;
  resultScore: number | null;
  resultType: string | null;
};

export type BanGeocodeBatchOutcome = {
  /** Keyed by the input row's `key` field */
  results: Map<string, BanGeocodeResult>;
  /** Count of chunks that ultimately failed after retries */
  apiFailures: number;
  /** Total chunks attempted */
  chunksTotal: number;
};

const BAN_BULK_URL = "https://api-adresse.data.gouv.fr/search/csv/";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
// F2 — borne par défaut d'une requête chunk. Un socket BAN figé sans cette
// borne bloquerait indéfiniment un job de 339k rows (la première vraie passe
// de masse est le backfill). Une valeur généreuse (60 s) : un chunk de 10k
// adresses peut être lent côté BAN sans être pour autant "hung".
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// Types BAN strictement plus précis que le centroïde commune. `municipality`
// est exclu (= niveau commune, aucun gain vs le repli `commune_centroid`).
// Exporté pour que les tests pinent directement le contenu (anti-régression
// silencieuse sur un futur ajout/retrait). Détail : `docs/plans/ban-join.md`.
export const ACCEPTED_PRECISION_TYPES: ReadonlySet<string> = new Set([
  "housenumber",
  "street",
  "locality",
]);

/** Erreur sentinelle interne : la requête a été annulée par le caller. */
class CallerAbortedError extends Error {
  constructor() {
    super("geocodeAddressesBatch aborted by caller signal");
    this.name = "CallerAbortedError";
  }
}

// Explicit "the BAN did not resolve this sent address" entry. A frozen single
// source of truth so the S2 reconciliation entry can never silently drift from
// the BanGeocodeResult shape.
const UNRESOLVED: BanGeocodeResult = Object.freeze({
  accepted: false,
  lat: null,
  lon: null,
  resultScore: null,
  resultType: null,
});

/** Quote a CSV field: wrap in double-quotes if it contains comma, quote, or newline. */
function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

type InputRow = { key: string; adresse: string; codePostal: string; codeInsee: string };

/**
 * Normalise l'adresse pour la requête BAN UNIQUEMENT — jamais la clé de cache
 * (`r.key`, byte-identique au ban_join, intouchable). Le mapping réponse se
 * faisant par `key` échoué (pas par adresse), réécrire l'adresse envoyée ne
 * casse aucun appariement. Exportée pour test direct.
 *
 * Deux normalisations, dans l'ordre :
 *
 * 1. TRONCATURE AU 1er VIRGULE, GATÉE « la ligne de voie commence par un n° »
 *    (levier dominant — 73 % des lignes éligibles Ameli prouvé prod). Les
 *    adresses Ameli sont massivement suffixées du NOM DE STRUCTURE après une
 *    virgule (`116 RUE JEAN MERMOZ, CLINIQUE JUGE SELARL`, `38 RUE …, MSP LES
 *    HIRONDELLES`). BAN géocode la chaîne ENTIÈRE → le nom de structure fait
 *    chuter le score sous le seuil voire renvoie 0 résultat. La ligne de voie
 *    seule résout au bâtiment (mesuré : `…, CLINIQUE JUGE` → NONE vs
 *    `116 RUE JEAN MERMOZ` → 0,976 ; 4 cas testés tous NONE/rejeté → 0,76-0,98).
 *    Sûr : le `code_insee` voyage en colonne `citycode` séparée → la commune est
 *    déjà épinglée, le complément post-virgule (résidence, bâtiment, structure)
 *    n'apporte rien au géocodage de voie.
 *    GATE LOAD-BEARING (anti-faux-positif, silent-failure-hunter HIGH) : on ne
 *    tronque QUE si l'adresse commence par un chiffre. Sinon l'ordre peut être
 *    STRUCTURE-EN-TÊTE (`CLINIQUE SAINT-JEAN, 5 RUE DURAND` — 15 % prouvé prod) :
 *    tronquer donnerait `CLINIQUE SAINT-JEAN`, que BAN matcherait en POI/locality
 *    confidemment FAUX (≥0,5, mis en cache, servi précis) en JETANT la vraie voie.
 *    Démarrer par un n° = signal haute précision « c'est bien une voie numérotée ».
 *    Une voie sans n° (`RUE X, HAMEAU Y`) reste envoyée ENTIÈRE (pas d'amélioration
 *    plutôt qu'un faux positif). Résidu accepté : un n° de voie ambigu intra-commune
 *    dont le hameau post-virgule était le désambiguïsateur (rare sur voie numérotée).
 *    Résidu LOW « nom de structure À CHIFFRE EN TÊTE » (`2 PASTEUR CENTRE, 10 RUE …`,
 *    `13008 MARSEILLE, RUE …`) : le gate tronque à tort, MAIS neutralisé en aval —
 *    le fragment ne résout pas en housenumber/street/locality à la commune épinglée
 *    → `municipality`/unresolved → REJETÉ → repli centroïde (statu quo), jamais un
 *    faux positif précis (acceptance gate `ACCEPTED_PRECISION_TYPES` = filet).
 *
 * 2. DÉZÉROTAGE du n° de voie de TÊTE (`0002 BD MARIN` → `2 BD MARIN`) — la BAN
 *    rejette les zéros de tête. Un n° TOUT-À-ZÉRO (`0`, `00`) = pas de n° civique
 *    réel → token retiré (la voie seule résout en `street`). Un `8` interne
 *    (`RUE DU 8 MAI`) n'est jamais touché (ancre `^` + séparateur obligatoire).
 *
 * DOCTRINE ANTI-FAUX-POSITIF (santé) — « ne jamais fabriquer une adresse
 * DIFFÉRENTE qui géocoderait confidemment FAUX » (acceptée au seuil permissif
 * ≥0,5, mise en cache, servie comme point précis). Garde-fous additionnels :
 *   a. Le numéro doit être suivi d'un SÉPARATEUR : on ne gère PAS les suffixes
 *      accolés (`0002B`) — préférer « pas d'amélioration » (laissé intact) à une
 *      corruption type `0RUE` → `DE PARIS` (un groupe suffixe avalerait un mot
 *      de rue collé au numéro).
 *   b. Si la normalisation ne laisse AUCUN token de voie alphabétique (`"0"`,
 *      `"0,13008"`), on renvoie l'ORIGINAL : un fragment numérique seul
 *      géocoderait en `locality`/`street` faux ; l'original sera classé
 *      `municipality`/unresolved par BAN → rejeté proprement.
 */
export function normalizeAddressForBan(adresse: string): string {
  // 1. Troncature GATÉE : seulement si la ligne de voie démarre par un n°
  //    (`/^\s*\d/`) — sinon risque structure-en-tête (cf. doctrine ci-dessus).
  const commaIdx = adresse.indexOf(",");
  const streetLine = commaIdx >= 0 && /^\s*\d/.test(adresse) ? adresse.slice(0, commaIdx) : adresse;
  // 2. Dézérotage du n° de tête sur la ligne de voie.
  const out = streetLine.replace(
    /^(\s*)0*(\d+)(\s|$)/,
    (_full, lead: string, digits: string, sep: string) =>
      // `0*` a déjà mangé les zéros de tête : `digits` ne vaut `"0"` que dans le
      // cas TOUT-À-ZÉRO (`0`, `00` → backtrack, `(\d+)` capture `"0"`) → pas de
      // n° civique réel, token retiré. Sinon on émet le n° déjà dézéroté.
      digits === "0" ? lead : `${lead}${digits}${sep}`,
  );
  // Garde-fou b : sortie sans aucune lettre = fragment ininterprétable → original.
  return /[A-Za-z]/.test(out) ? out : adresse;
}

/**
 * Build the multipart/form-data CSV body for a chunk.
 * We include a passthrough `key` column as the first field so we can map
 * response rows back to input rows by value (not just position). BAN preserves
 * row order but echoing the key back is more robust against any future change.
 */
function buildFormData(chunk: InputRow[]): FormData {
  const header = "key,adresse,code_postal,citycode";
  // `buildFormData` est PARTAGÉ par les backfills RPPS et Ameli (via
  // geocodeAddressesBatch) : `normalizeAddressForBan` s'applique donc aux DEUX
  // sources. Inoffensif côté RPPS (pas de complément virgule ni de zéro de tête
  // → adresse inchangée), nécessaire côté Ameli (nom de structure + zéros massifs).
  const dataRows = chunk.map(
    (r) =>
      `${csvEscape(r.key)},${csvEscape(normalizeAddressForBan(r.adresse))},${csvEscape(r.codePostal)},${csvEscape(r.codeInsee)}`,
  );
  const csvContent = [header, ...dataRows].join("\n");

  const form = new FormData();
  form.append("data", new Blob([csvContent], { type: "text/csv" }), "addresses.csv");
  form.append("columns", "adresse");
  form.append("postcode", "code_postal");
  form.append("citycode", "citycode");
  return form;
}

/**
 * Parse BAN bulk CSV response text into a map of key → BanGeocodeResult.
 * The BAN echoes the input columns then appends result_* columns.
 * With our passthrough `key` column, the response header looks like:
 *   key,adresse,code_postal,citycode,latitude,longitude,result_score,result_type,result_label,...
 *
 * Returns `null` (hard parse failure) if:
 *  - the body has <2 lines (truncated proxy 200, empty body) — we never send
 *    empty chunks, so a <2-line body for a non-empty chunk is always an error,
 *    never a legitimate empty result (S1);
 *  - the `key` passthrough column OR any required result column is missing —
 *    without `key` we cannot map rows back to inputs at all.
 * In both cases an empty Map would be a SILENT zero-results/zero-failures data
 * loss. The caller must treat null as a chunk failure (apiFailures++).
 */
function parseBanCsvResponse(
  text: string,
  scoreThreshold: number,
): Map<string, BanGeocodeResult> | null {
  const results = new Map<string, BanGeocodeResult>();
  const lines = text.split(/\r?\n/);
  // S1 — body trop court (<2 lignes : proxy tronqué, body vide). On n'envoie
  // jamais de chunk vide ⇒ toujours une erreur, jamais un résultat vide légitime.
  if (lines.length < 2) {
    console.warn(
      "[france-data-mcp] geocodeAddressesBatch: BAN response too short (<2 lines), cannot map response — treating chunk as failed",
    );
    return null;
  }

  const headerLine = lines[0] ?? "";
  const headers = parseCsvLine(headerLine, { delimiter: "," });

  const idxKey = headers.indexOf("key");
  const idxLat = headers.indexOf("latitude");
  const idxLon = headers.indexOf("longitude");
  const idxScore = headers.indexOf("result_score");
  const idxType = headers.indexOf("result_type");

  // Missing the passthrough `key` OR any result column = we cannot map the
  // response safely. Return null (hard failure) so the chunk is counted as
  // an apiFailure rather than a silent empty success.
  if (idxKey === -1 || idxLat === -1 || idxLon === -1 || idxScore === -1 || idxType === -1) {
    console.warn(
      "[france-data-mcp] geocodeAddressesBatch: unexpected BAN CSV header (missing key or result column), cannot map response",
    );
    return null;
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const fields = parseCsvLine(line, { delimiter: "," });
    const key = fields[idxKey] ?? "";
    if (!key) continue;

    const latStr = fields[idxLat] ?? "";
    const lonStr = fields[idxLon] ?? "";
    const scoreStr = fields[idxScore] ?? "";
    const resultType = fields[idxType] ?? "";

    const lat = latStr !== "" ? Number(latStr) : null;
    const lon = lonStr !== "" ? Number(lonStr) : null;
    const resultScore = scoreStr !== "" ? Number(scoreStr) : null;

    // Acceptation par PRÉCISION (`result_type`) — cf. `ACCEPTED_PRECISION_TYPES`
    // + `docs/plans/ban-join.md`. `Number.isFinite` rejette NaN/Infinity ; le
    // range guard rejette une lat/lon hors plage géographique (cache pollué
    // sinon — BAN ne devrait jamais sortir hors France, le client n'a pas à
    // l'accepter). Normalisation casse/espaces sur `resultType` : défense
    // contre une dérive contractuelle BAN ; la forme normalisée est ALSO
    // celle persistée downstream (sinon un `"Housenumber"` accepté ici serait
    // jeté par tout filtre aval sur lowercase = panne silencieuse aval).
    const normalizedType = resultType.trim().toLowerCase();
    const hasCoords =
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      (lat as number) >= -90 &&
      (lat as number) <= 90 &&
      (lon as number) >= -180 &&
      (lon as number) <= 180;
    const meetsConfidence = resultScore !== null && resultScore >= scoreThreshold;
    const isMorePreciseThanCommune = ACCEPTED_PRECISION_TYPES.has(normalizedType);
    const accepted = hasCoords && meetsConfidence && isMorePreciseThanCommune;

    results.set(key, {
      accepted,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      resultScore: Number.isFinite(resultScore) ? resultScore : null,
      resultType: normalizedType !== "" ? normalizedType : null,
    });
  }

  return results;
}

/**
 * POST one chunk to the BAN bulk CSV API with bounded retry on transient errors.
 * Returns null if all retries are exhausted OR the response body is unparsable
 * (best-effort: the caller counts null as an apiFailure, never a silent empty).
 *
 * F2 — chaque tentative est bornée par `requestTimeoutMs` (socket BAN figé ⇒
 * AbortError au lieu d'un hang infini). Un timeout est traité comme une erreur
 * TRANSITOIRE (≈ 5xx) : il est RETRY-é dans la boucle MAX_RETRIES — mais comme
 * CHAQUE tentative est elle-même bornée par `requestTimeoutMs`, le temps total
 * du chunk reste borné par (MAX_RETRIES+1) × requestTimeoutMs + backoffs : il
 * ne peut JAMAIS redevenir non-borné silencieusement. Si le caller fournit un
 * `signal` et qu'il abort, on propage une `CallerAbortedError` pour arrêter
 * net (pas de retry sur un abort caller : l'intention est d'annuler le batch).
 */
async function postChunk(
  chunk: InputRow[],
  chunkIndex: number,
  scoreThreshold: number,
  requestTimeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<Map<string, BanGeocodeResult> | null> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const isFinal = attempt === MAX_RETRIES;
    // Total-attempts framing so "attempt 3/4" isn't misread as the final call.
    const attemptLabel = `attempt ${attempt + 1}/${MAX_RETRIES + 1}`;

    // Un abort caller survenu entre deux tentatives = stop immédiat.
    if (callerSignal?.aborted) throw new CallerAbortedError();

    // F2 — borne par-tentative via AbortController + setTimeout (PAS
    // AbortSignal.timeout : un setTimeout reste contrôlable par les faux
    // timers de test et le timer est explicitement clearé en `finally`, donc
    // aucun timer fantôme ne fuit même quand la requête répond à temps). Si
    // le caller fournit un `signal`, on propage SON abort sur le même
    // controller : la requête abort si le timeout OU le caller se déclenche.
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    const onCallerAbort = () => controller.abort();
    if (callerSignal) callerSignal.addEventListener("abort", onCallerAbort);

    try {
      const response = await fetch(BAN_BULK_URL, {
        method: "POST",
        body: buildFormData(chunk),
        signal: controller.signal,
      });

      if (response.ok) {
        const text = await response.text();
        const parsed = parseBanCsvResponse(text, scoreThreshold);
        // Unparsable body (missing key/result columns) = chunk failure, not
        // a silent empty success — parseBanCsvResponse already logged a warn.
        if (parsed === null) return null;
        return parsed;
      }

      if (isTransientHttpStatus(response.status)) {
        lastError = `HTTP ${response.status}`;
        if (isFinal) break;
        console.warn(
          `[france-data-mcp] geocodeAddressesBatch: chunk ${chunkIndex} transient error (${response.status}), ${attemptLabel} — retrying`,
        );
        await sleep(backoffDelayMs(attempt, BASE_DELAY_MS));
        continue;
      }

      // Non-retryable 4xx (except 429 already covered by isTransientHttpStatus)
      console.error(
        `[france-data-mcp] geocodeAddressesBatch: chunk ${chunkIndex} non-retryable error HTTP ${response.status} — giving up`,
      );
      return null;
    } catch (err) {
      // F2 — distinguer 3 cas d'abort/erreur :
      //  (1) caller signal aborté → CallerAbortedError : on propage (le batch
      //      veut s'arrêter, pas de retry).
      //  (2) timeout par-tentative (`timedOut`) → AbortError, le caller n'a
      //      PAS aborté : transitoire, on retry (CHAQUE tentative est elle-
      //      même bornée → temps total borné par retries × timeout).
      //  (3) erreur réseau (ENOTFOUND, ECONNRESET…) → transitoire, on retry.
      if (callerSignal?.aborted) {
        // Le caller a annulé pendant la requête en vol — stop net.
        throw new CallerAbortedError();
      }
      const isTimeout = timedOut;
      lastError = isTimeout
        ? `request timed out after ${requestTimeoutMs}ms`
        : (err as Error).message;
      if (isFinal) break;
      console.warn(
        isTimeout
          ? `[france-data-mcp] geocodeAddressesBatch: chunk ${chunkIndex} request timed out (>${requestTimeoutMs}ms), ${attemptLabel} — retrying`
          : `[france-data-mcp] geocodeAddressesBatch: chunk ${chunkIndex} network error (${lastError}), ${attemptLabel} — retrying`,
      );
      await sleep(backoffDelayMs(attempt, BASE_DELAY_MS));
    } finally {
      // Toujours clearer le timer (réponse à temps OU abort) — aucun timer
      // non-unref'd ne fuit dans un job de 339k rows ni dans les tests.
      clearTimeout(timeoutId);
      if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }

  console.error(
    `[france-data-mcp] geocodeAddressesBatch: chunk ${chunkIndex} failed after ${MAX_RETRIES + 1} attempts (${lastError ?? "unknown"}) — continuing with other chunks`,
  );
  return null;
}

/**
 * Mass-geocode addresses through the French BAN bulk CSV API.
 * Best-effort: a chunk failure increments apiFailures but never throws.
 *
 * F2 — `opts.requestTimeoutMs` borne CHAQUE requête chunk (défaut 60 s) :
 * un socket BAN figé devient un échec de chunk compté, pas un hang infini sur
 * un job de 339k rows. `opts.signal` (optionnel) annule TOUT le batch : une
 * fois aborté, aucun nouveau chunk ne démarre et tous les chunks non traités
 * sont comptés en `apiFailures` (JAMAIS un succès partiel silencieux). Les
 * deux options sont purement additives : un caller existant (sans elles)
 * conserve exactement le même comportement, sauf qu'un hang est désormais borné.
 */
export async function geocodeAddressesBatch(
  rows: InputRow[],
  opts: {
    chunkSize: number;
    scoreThreshold: number;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<BanGeocodeBatchOutcome> {
  const { chunkSize, scoreThreshold, signal, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = opts;
  const results = new Map<string, BanGeocodeResult>();
  let apiFailures = 0;

  // Split into chunks
  const chunks: InputRow[][] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize));
  }

  const chunksTotal = chunks.length;
  // F2 — flag d'arrêt : une fois le caller aborté (avant ou pendant un chunk)
  // on NE démarre plus aucun chunk et on compte les restants en apiFailures.
  let callerAborted = false;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || chunk.length === 0) continue;

    // Caller-abort déjà constaté (ou aborté avant même le 1er chunk) → ne
    // PAS lancer ce chunk : compter en apiFailure (jamais un succès muet).
    if (callerAborted || signal?.aborted) {
      if (!callerAborted) {
        callerAborted = true;
        console.error(
          `[france-data-mcp] geocodeAddressesBatch: caller signal aborted — ${chunks.length - i} remaining chunk(s) not submitted, counted as apiFailures`,
        );
      }
      apiFailures++;
      continue;
    }

    let chunkResults: Map<string, BanGeocodeResult> | null;
    try {
      chunkResults = await postChunk(chunk, i, scoreThreshold, requestTimeoutMs, signal);
    } catch (err) {
      // Seul cas propagé par postChunk : CallerAbortedError (annulation du
      // batch). On bascule en mode arrêt : ce chunk + les suivants comptent
      // en apiFailures, sans throw (best-effort) ni hang.
      if (err instanceof CallerAbortedError) {
        callerAborted = true;
        console.error(
          `[france-data-mcp] geocodeAddressesBatch: caller signal aborted mid-flight — chunk ${i} and ${chunks.length - i - 1} subsequent chunk(s) counted as apiFailures`,
        );
        apiFailures++;
        continue;
      }
      // Tout autre throw inattendu : best-effort, on ne casse pas le batch.
      console.error(
        `[france-data-mcp] geocodeAddressesBatch: chunk ${i} unexpected error (${err instanceof Error ? err.message : String(err)}) — counted as apiFailure`,
      );
      apiFailures++;
      continue;
    }

    if (chunkResults === null) {
      apiFailures++;
      continue;
    }

    // S2 — per-key reconciliation against the SENT chunk. The BAN only
    // guarantees chunk-level observability: it may echo fewer rows than sent,
    // blank a row's `key` cell, or even echo a key we never sent (a mis-mapping
    // symptom). The output MUST be scoped to the keys we actually sent: a key
    // the BAN returned that we never sent must NOT leak into `results` (a
    // caller would otherwise treat it as a real geocoded address it never
    // asked for). The client knows the keys it sent, so close the gap here
    // (single chokepoint) instead of pushing reconciliation onto every caller.
    // Distinct keys only: duplicate input keys collapse in the result Map
    // (last-write-wins), so the reconciliation unit is the distinct sent key
    // set, consistent with Map semantics.
    const sentKeys = new Set(chunk.map((r) => r.key));
    let genuinelyMapped = 0;
    for (const sentKey of sentKeys) {
      const mapped = chunkResults.get(sentKey);
      if (mapped !== undefined) {
        results.set(sentKey, mapped);
        genuinelyMapped++;
        continue;
      }
      // Absent from the parsed map → explicit unresolved entry so every sent
      // address's fate stays observable (real result | explicit unresolved |
      // counted+logged chunk failure). NOT an apiFailure: the HTTP call
      // succeeded — this is a data-quality signal, distinct from an API error.
      results.set(sentKey, UNRESOLVED);
    }

    // Systemic mis-mapping: the body was 2+ lines and parsed, yet NONE of our
    // sent keys matched. One data-quality warn so it's visible. Still NOT an
    // apiFailure (HTTP succeeded) — per "distinguish no-result from API-error".
    if (genuinelyMapped === 0 && sentKeys.size > 0) {
      console.warn(
        `[france-data-mcp] geocodeAddressesBatch: chunk of ${sentKeys.size} addresses returned 0 mapped rows — all marked unresolved`,
      );
    }
  }

  return { results, apiFailures, chunksTotal };
}
