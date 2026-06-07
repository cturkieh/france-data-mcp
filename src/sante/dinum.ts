/**
 * DINUM Recherche Entreprises — annuaire des entreprises françaises (SIRENE + RNE).
 *
 * URL : https://recherche-entreprises.api.gouv.fr/search
 * Doc : https://recherche-entreprises.api.gouv.fr/docs/
 *
 * Rate limit documenté : 7 req/s. Observé en pratique : ~1 req/s effectif après le
 * premier 429 (header retry-after: 4 systématique). Le helper fetchJson respecte
 * retry-after, mais ne pas dépasser 1 req/s en burst pour éviter les 429 répétés.
 *
 * Sans clé API, sans authentification, CORS autorisé.
 *
 * Données utiles côté santé : le filtre `activite_principale` (NAF) permet de
 * cibler labos (8690B), pharmacies (4773Z), maisons médicales (8621Z), SSR
 * (8610Z), EHPAD (8710A), centres médico-sociaux, etc.
 */

import { parseCoordinates } from "../core/coords.js";
import { HttpError, fetchJson } from "../core/http.js";
import { type LookupResult, lookupFound, lookupNotFound } from "../core/lookup-result.js";
import { clamp } from "../core/numbers.js";
import { pickDefined } from "../core/object-utils.js";
import type { Coordinates } from "../core/types.js";
import { getInseeApiKey, lookupSirenViaInsee } from "./insee-sirene.js";

const BASE_URL = "https://recherche-entreprises.api.gouv.fr/search";
/**
 * Endpoint DINUM dédié à la recherche de proximité (audit P3). `/search`
 * (full-text + filtres administratifs) NE supporte PAS `lat/long/radius` →
 * envoyer des coords sur `/search` provoque un HTTP 400. La proximité a son
 * endpoint propre, mutuellement exclusif avec `q`/`code_postal`/`departement`/
 * `etat_administratif`. `/near_point` accepte : lat, long, radius (≤50),
 * activite_principale (NAF), page, per_page.
 */
const NEAR_POINT_URL = "https://recherche-entreprises.api.gouv.fr/near_point";

export type Etablissement = {
  /** SIRET 14 chiffres */
  siret: string;
  /** Adresse complète */
  adresse: string;
  /** Code postal */
  codePostal?: string;
  /** Commune */
  commune?: string;
  /** Coordonnées GPS si l'adresse est géocodée */
  point?: Coordinates;
  /** Code NAF de l'établissement */
  naf?: string;
  /** Établissement actif administrativement (etat_administratif === "A") */
  actif: boolean;
  /** Tranche d'effectif salarié (codes INSEE 0..53) */
  trancheEffectif?: string;
  /** Date de création de l'établissement */
  dateCreation?: string;
};

export type Finance = {
  annee: number;
  ca?: number;
  resultatNet?: number;
  /**
   * Signal de fiabilité du `ca`. `false` quand `ca===0` ET `resultatNet>0` :
   * pattern observé à 100% sur les SELARL pharma (NAF 47.73Z) qui ne déclarent
   * pas leur CA au RNE — il ne faut pas l'afficher comme un vrai 0. Vraie
   * dormance (`resultatNet<=0` ou undefined) reste `caFiable: true`.
   */
  caFiable: boolean;
};

export type Dirigeant = {
  nom?: string;
  prenoms?: string;
  fonction?: string;
  qualite?: string;
};

/**
 * État de l'enrichissement de la liste `etablissements` :
 *
 * - `not_attempted` : monosite (ou data SIRENE manquante) — pas de second appel.
 * - `success` : `etablissements.length === nombreEtablissements` (ou >=).
 * - `partial` : second appel OK mais retourne moins que le total SIRENE
 *   (cause typique : entreprise multi-département ou NAF secondaires).
 * - `failed` : second appel a échoué (rate limit, panne API, parsing…).
 *   `enrichmentWarning` contient le message d'erreur.
 */
export type EnrichmentStatus = "not_attempted" | "success" | "partial" | "failed";

/** Source d'origine du lookup d'une `Entreprise`. Voir champ `siren_source` ci-dessous. */
export type EntrepriseSirenSource = "dinum" | "insee_v3";

export type Entreprise = {
  /** SIREN 9 chiffres */
  siren: string;
  /** SIRET du siège (14 chiffres) */
  siretSiege?: string;
  /** Nom complet (raison sociale ou nom + prénom pour entrepreneurs individuels) */
  nomComplet: string;
  /** Code NAF principal */
  naf?: string;
  /** Libellé NAF principal */
  nafLibelle?: string;
  /** Tranche d'effectif (CA / RN dans `finances`) */
  trancheEffectif?: string;
  /** Code juridique INSEE */
  natureJuridique?: string;
  /** Finances historiques par année (les plus récentes sont en premier) */
  finances: Finance[];
  /** Dirigeants déclarés au RNE */
  dirigeants: Dirigeant[];
  /**
   * Établissements actifs et inactifs.
   *
   * ⚠️ Pour `searchEntreprises({ q })` ou `getEntrepriseBySiren()`, ce champ peut
   * ne contenir que le siège — l'API DINUM ne retourne que les établissements
   * « matchant » la requête. `getEntrepriseBySiren()` fait un second appel
   * automatique pour récupérer les établissements du même NAF principal dans
   * le département du siège.
   *
   * **Le caller doit lire `enrichmentStatus`** pour savoir si la liste est
   * complète (`success`), tronquée (`partial`), ou si l'enrichissement a échoué
   * (`failed`). Comparer aussi `etablissements.length` à `nombreEtablissements`.
   */
  etablissements: Etablissement[];
  /** Nombre total d'établissements (actifs + fermés), source SIRENE */
  nombreEtablissements?: number;
  /** Nombre d'établissements actuellement ouverts, source SIRENE */
  nombreEtablissementsOuverts?: number;
  /**
   * État de l'enrichissement multi-sites (cf. `EnrichmentStatus`).
   * Toujours présent pour les retours de `getEntrepriseBySiren()`.
   * Absent pour les `searchEntreprises()` (pas d'enrichissement tenté).
   */
  enrichmentStatus?: EnrichmentStatus;
  /** Message d'aide quand `enrichmentStatus` ∈ {"partial", "failed"}. */
  enrichmentWarning?: string;
  /**
   * Source effective du lookup. `"dinum"` (défaut implicite) = retour de l'API
   * recherche-entreprises.api.gouv.fr. `"insee_v3"` = fallback SIRENE INSEE V3
   * activé quand DINUM ne connaît pas le SIREN (cas diffusion partielle). En
   * mode insee_v3, finances/dirigeants/etablissements sont vides — l'API
   * /siren/{siren} ne les expose pas sans appels supplémentaires /siret.
   */
  siren_source?: EntrepriseSirenSource;
  /** Statut administratif global */
  actif: boolean;
};

export type SearchEntreprisesOptions = {
  /** Recherche textuelle (raison sociale, dirigeant…) */
  q?: string;
  /** Filtre exact sur le code NAF (ex: "8690B" pour labos d'analyses médicales) */
  naf?: string;
  /** Filtre par code postal */
  codePostal?: string;
  /** Filtre par département (code 2 ou 3 caractères) */
  departement?: string;
  /** Filtre par code commune INSEE */
  codeCommune?: string;
  /**
   * Recherche géographique : centre + rayon (km, max 50). DOIT être combiné
   * avec `q` (recherche textuelle) — l'API DINUM rejette `naf + lat/lon/radius`
   * directement. Pour combiner NAF + zone géographique, utiliser le tool MCP
   * `entreprises_in_radius` qui applique un fallback automatique
   * (reverseGeocode → département → filtre Haversine).
   */
  center?: Coordinates;
  /** Rayon en km (1-50). Requis si `center` est fourni. */
  radiusKm?: number;
  /** Limiter aux établissements administrativement actifs (défaut: true) */
  onlyActive?: boolean;
  /** Page de résultats (1-indexed, défaut 1) */
  page?: number;
  /** Résultats par page (1-25, défaut 10) */
  perPage?: number;
  signal?: AbortSignal;
};

export type SearchEntreprisesResult = {
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
  entreprises: Entreprise[];
};

type ApiSiege = {
  siret?: string;
  adresse?: string;
  code_postal?: string;
  libelle_commune?: string;
  // L'API DINUM peut renvoyer `null` (pas seulement `undefined`) pour les
  // sites sans géocodage SIRENE. `parseCoordinates` ci-dessous accepte les
  // deux et renvoie `undefined` proprement.
  latitude?: string | number | null;
  longitude?: string | number | null;
  activite_principale?: string;
  etat_administratif?: string;
  tranche_effectif_salarie?: string;
  date_creation?: string;
};

type ApiMatchingEt = ApiSiege;

type ApiFinances = Record<
  string,
  {
    ca?: number;
    resultat_net?: number;
  }
>;

type ApiDirigeant = {
  nom?: string;
  prenoms?: string;
  fonction?: string;
  qualite?: string;
};

type ApiEntreprise = {
  siren: string;
  nom_complet?: string;
  nom_raison_sociale?: string;
  activite_principale?: string;
  libelle_activite_principale?: string;
  nature_juridique?: string;
  tranche_effectif_salarie?: string;
  etat_administratif?: string;
  nombre_etablissements?: number;
  nombre_etablissements_ouverts?: number;
  finances?: ApiFinances;
  dirigeants?: ApiDirigeant[];
  siege?: ApiSiege;
  matching_etablissements?: ApiMatchingEt[];
};

type ApiResponse = {
  results: ApiEntreprise[];
  total_results: number;
  page: number;
  per_page: number;
  total_pages: number;
};

/**
 * Recherche d'entreprises avec filtres NAF / géo / texte libre.
 *
 * @example Tous les labos de bio médicale dans 5 km autour d'un point
 * ```ts
 * const labos = await searchEntreprises({
 *   naf: "8690B",
 *   center: { lon: 4.7192, lat: 49.7672 },
 *   radiusKm: 5,
 * });
 * ```
 *
 * @example Toutes les pharmacies du 08
 * ```ts
 * const pharma = await searchEntreprises({ naf: "4773Z", departement: "08" });
 * ```
 */
export async function searchEntreprises(
  options: SearchEntreprisesOptions,
): Promise<SearchEntreprisesResult> {
  const {
    q,
    naf,
    codePostal,
    departement,
    codeCommune,
    center,
    radiusKm,
    onlyActive = true,
    page = 1,
    perPage = 10,
    signal,
  } = options;

  if (!q && !naf && !codePostal && !departement && !codeCommune && !center) {
    throw new RangeError(
      "searchEntreprises: au moins un critère est requis (q, naf, codePostal, departement, codeCommune ou center+radiusKm)",
    );
  }

  if (center && (radiusKm === undefined || radiusKm <= 0)) {
    throw new RangeError("searchEntreprises: radiusKm > 0 requis quand center est fourni");
  }

  const params = new URLSearchParams();
  let endpoint: string;

  if (center && radiusKm !== undefined) {
    // Recherche de proximité → endpoint `/near_point` dédié (audit P3). Il
    // n'accepte QUE lat/long/radius + activite_principale (+ pagination).
    // `q`, filtres administratifs et `etat_administratif` y sont rejetés
    // (HTTP 400) — ce sont des paramètres de `/search`, endpoint distinct.
    if (q) {
      throw new RangeError(
        "searchEntreprises: la recherche de proximité DINUM (/near_point) ne supporte pas `q`. " +
          "Options : (1) `naf` + center+radiusKm (filtrage activité géolocalisé, supporté nativement), " +
          "(2) `q` + `codePostal`/`departement` (recherche textuelle administrative, sans rayon).",
      );
    }
    if (codePostal || departement || codeCommune) {
      throw new RangeError(
        "searchEntreprises: center+radiusKm (proximité) est exclusif avec codePostal/departement/codeCommune " +
          "(filtres administratifs). Choisir un seul mode de recherche.",
      );
    }
    endpoint = NEAR_POINT_URL;
    params.set("lat", String(center.lat));
    params.set("long", String(center.lon));
    params.set("radius", String(Math.min(radiusKm, 50)));
    if (naf) params.set("activite_principale", normalizeNafCode(naf));
  } else {
    endpoint = BASE_URL;
    if (q) params.set("q", q);
    if (naf) params.set("activite_principale", normalizeNafCode(naf));
    if (codePostal) params.set("code_postal", codePostal);
    if (departement) params.set("departement", departement);
    if (codeCommune) params.set("code_commune", codeCommune);
    if (onlyActive) params.set("etat_administratif", "A");
  }
  params.set("page", String(Math.max(1, page)));
  params.set("per_page", String(clamp(perPage, 1, 25)));

  const url = `${endpoint}?${params.toString()}`;
  // Un NAF BIEN FORMÉ mais INEXISTANT (ex. `71.12Z` — 7112 est éclaté en
  // 71.12A/71.12B, pas de `…Z`) passe `normalizeNafCode` puis est rejeté par DINUM
  // en HTTP 400 (« activite_principale non valide » — seule la nomenclature sait
  // qu'un code n'existe pas). Faute d'INPUT caller, pas une panne : on la convertit
  // en RangeError (→ JSON-RPC -32602) au lieu de la laisser remonter en HttpError
  // capturée Sentry `error`. Discrimination ÉTROITE (400 + `naf` fourni + body
  // `activite_principale`) ; tout autre 400 et les 5xx transitoires restent des
  // HttpError. Repro FRANCE-DATA-MCP-G (jumeau « existence-invalide » de
  // FRANCE-DATA-MCP-A « format-invalide », lui rejeté pré-réseau par normalizeNafCode).
  let data: ApiResponse;
  try {
    data = await fetchJson<ApiResponse>(url, { signal });
  } catch (err) {
    if (
      naf && // truthy : aligné sur le `if (naf)` qui POSE `activite_principale` (l.315/319)
      err instanceof HttpError &&
      err.status === 400 &&
      /activite_principale/i.test(err.body ?? "")
    ) {
      console.warn(
        `[france-data-mcp] searchEntreprises: NAF \`${naf}\` rejeté par DINUM (HTTP 400 activite_principale) → RangeError -32602 (input caller invalide, pas une panne amont)`,
      );
      throw new RangeError(
        `searchEntreprises: code NAF \`${naf}\` rejeté par l'API DINUM — bien formé mais hors nomenclature NAF rév.2 (ex. 7112 n'a pas de \`…Z\` : c'est \`71.12A\`/\`71.12B\`). Utiliser une sous-classe RÉELLE à 5 caractères (ex. \`71.12B\` ingénierie, \`86.90B\` labos).`,
      );
    }
    throw err;
  }

  return {
    total: data.total_results,
    page: data.page,
    perPage: data.per_page,
    totalPages: data.total_pages,
    entreprises: data.results.map(toEntreprise),
  };
}

/**
 * Récupère une entreprise par son SIREN (9 chiffres).
 * Renvoie null si introuvable. Throw si l'API DINUM est en panne ou rate-limit dépassé.
 *
 * Implémentation :
 * 1. `q=<siren>` (l'API DINUM matche le SIREN dans le full-text), filtrage côté
 *    client sur l'égalité exacte du SIREN.
 * 2. **Limitation API DINUM** : `q=<siren>` ne retourne que le siège dans
 *    `matching_etablissements`. Pour récupérer les autres établissements, on
 *    fait un second appel `activite_principale=<naf>&departement=<dept_siège>`
 *    qui retourne tous les établissements de l'entreprise ayant le NAF
 *    principal dans le département du siège (couvre la majorité des
 *    multi-sites). Les `etablissements` du résultat fusionnent siège + ces
 *    établissements supplémentaires (déduplication par SIRET).
 * 3. `nombreEtablissements` / `nombreEtablissementsOuverts` reflètent toujours
 *    le total réel SIRENE (non limité par l'API DINUM).
 *
 * **Limitation indexation DINUM** : certaines entreprises pourtant actives à
 * l'INSEE/SIRENE ne sont PAS indexées par `recherche-entreprises.api.gouv.fr`
 * (statut de diffusion partielle au sens INSEE — `statut_diffusion ∈ {P,N}` —
 * ou exclusion sectorielle/légale). Ces SIREN reviennent `null` ici alors
 * qu'ils existent réellement. L'audit post-v0.2.0 a vérifié ce comportement
 * sur le SIREN 787120435 (Bio Ard'Aisne, SAS Rethel) : présent dans SIRENE
 * via la "fabrique social.gouv" mais absent de l'API DINUM publique.
 * Pour ce cas d'usage, fallback : interroger SIRENE INSEE directement (avec
 * authentification API), ou utiliser `entreprises_in_radius` par zone géo.
 */
export async function getEntrepriseBySiren(
  siren: string,
  signal?: AbortSignal,
): Promise<LookupResult<Entreprise>> {
  if (!/^\d{9}$/.test(siren)) {
    throw new RangeError(`getEntrepriseBySiren: SIREN invalide "${siren}" (attendu 9 chiffres)`);
  }
  const result = await searchEntreprises({ q: siren, perPage: 5, onlyActive: false, signal });
  const match = result.entreprises.find((e) => e.siren === siren);
  if (!match) {
    if (result.entreprises.length > 0) {
      // L'API a renvoyé des résultats mais aucun ne matche le SIREN exact —
      // bizarre, peut signaler une régression côté DINUM (recherche full-text
      // qui matche sur autre chose que le SIREN). À surveiller.
      console.warn(
        `[france-data-mcp] getEntrepriseBySiren(${siren}): l'API a renvoyé ${result.entreprises.length} résultat(s) sans match exact du SIREN.`,
      );
      return lookupNotFound(
        siren,
        `L'API DINUM a renvoyé ${result.entreprises.length} résultat(s) full-text mais aucun ne correspond exactement au SIREN ${siren}. Possible régression côté API DINUM ou faux positif full-text.`,
        "ambiguous",
      );
    }
    // "pas indexé par DINUM" ≠ "n'existe pas dans SIRENE". Comportement
    // normal pour les SIREN en diffusion partielle (cf. JSDoc ci-dessus, cas
    // Bio Ard'Aisne). On tente le fallback SIRENE INSEE V3 si configuré.
    const inseeMatch = await lookupSirenViaInsee(siren);
    if (inseeMatch) return lookupFound(inseeMatch);
    const inseeSuffix = getInseeApiKey()
      ? "Fallback SIRENE INSEE V3 a aussi retourné null (SIREN absent de SIRENE, clé révoquée, ou panne API — voir logs)."
      : "Fallback SIRENE INSEE V3 non configuré (env var INSEE_SIRENE_API_KEY absente).";
    return lookupNotFound(
      siren,
      `SIREN ${siren} non trouvé via DINUM (statut diffusion partielle probable). ${inseeSuffix}`,
    );
  }

  // Trouve le siège : on préfère le SIRET déclaré comme siège plutôt que
  // l'index 0 du tableau (l'ordre n'est pas garanti et peut changer si on
  // ré-ordonne plus tard).
  const siege =
    match.etablissements.find((e) => e.siret === match.siretSiege) ?? match.etablissements[0];
  const siegePostalCode = siege?.codePostal;
  const departement = deptFromPostal(siegePostalCode);
  const naf = match.naf;
  const totalSirene = match.nombreEtablissements ?? 0;

  if (totalSirene <= 1) {
    match.enrichmentStatus = "not_attempted";
    return lookupFound(match);
  }
  if (!naf || !departement) {
    match.enrichmentStatus = "not_attempted";
    match.enrichmentWarning = warnSkipped({ naf, siegePostalCode, departement });
    return lookupFound(match);
  }

  // Second appel : l'API DINUM expose les autres établissements dans
  // `matching_etablissements` uniquement quand on filtre par NAF + département.
  // ⚠️ Coût : ce wrapper consomme 2 appels DINUM par invocation pour les
  // multi-sites (rate limit observé ~1 req/s effectif après 429). Throttler
  // côté caller en cas de batch.
  try {
    const more = await searchEntreprises({
      naf,
      departement,
      perPage: 25,
      onlyActive: false,
      signal,
    });
    const enriched = more.entreprises.find((e) => e.siren === siren);
    if (enriched) {
      const seen = new Set(match.etablissements.map((e) => e.siret));
      for (const et of enriched.etablissements) {
        if (et.siret && !seen.has(et.siret)) {
          match.etablissements.push(et);
          seen.add(et.siret);
        }
      }
    }

    if (match.etablissements.length >= totalSirene) {
      match.enrichmentStatus = "success";
    } else {
      match.enrichmentStatus = "partial";
      match.enrichmentWarning = warnPartial({
        found: match.etablissements.length,
        totalSirene,
        naf,
        departement,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errType = err instanceof Error ? err.constructor.name : typeof err;
    console.error(
      `[france-data-mcp] getEntrepriseBySiren(${siren}): échec enrichissement (errType=${errType}, naf=${naf}, departement=${departement}): ${msg}`,
    );
    match.enrichmentStatus = "failed";
    match.enrichmentWarning = warnFailed({ errType, msg, totalSirene });
  }

  return lookupFound(match);
}

function warnSkipped(opts: {
  naf: string | undefined;
  siegePostalCode: string | undefined;
  departement: string | undefined;
}): string {
  return `Enrichissement ignoré (naf=${opts.naf ?? "absent"}, codePostal=${opts.siegePostalCode ?? "absent"}, departement=${opts.departement ?? "non déductible"}).`;
}

function warnPartial(opts: {
  found: number;
  totalSirene: number;
  naf: string;
  departement: string;
}): string {
  return `Enrichissement partiel : ${opts.found}/${opts.totalSirene} établissements. Stratégie API DINUM (naf=${opts.naf} + departement=${opts.departement}) ne couvre pas les sites multi-département ni les établissements à NAF différent du siège. Pour exhaustivité : utiliser \`entreprises_in_radius\` par zone géographique, ou interroger SIRENE directement.`;
}

function warnFailed(opts: { errType: string; msg: string; totalSirene: number }): string {
  return `Enrichissement échoué (${opts.errType}: ${opts.msg}). nombreEtablissements=${opts.totalSirene} mais seul le siège est listé. Réessayer plus tard, ou utiliser \`entreprises_in_radius\` pour cibler géographiquement.`;
}

/**
 * Extrait le code département depuis un code postal français.
 *
 * Cas couverts :
 * - Métropole : `08000` → `"08"`, `75001` → `"75"`
 * - DOM (codes 971-978) : `97400` → `"974"`, `97600` → `"976"`
 * - TOM (codes 988) : `98800` → `"988"`
 * - Corse : `20100` → `"2A"` (Corse-du-Sud, 20000-20190),
 *           `20200` → `"2B"` (Haute-Corse, 20200-20620)
 *
 * Note : différent de `deptFromCommune` (api/tools.ts) qui prend un code
 * commune INSEE (Corse `2A004` → `"2A"` directement). Ici on travaille sur
 * les codes postaux (Corse `20xxx`) qui demandent un mapping par plage.
 */
function deptFromPostal(codePostal: string | undefined): string | undefined {
  if (!codePostal || codePostal.length < 2) return undefined;
  if (codePostal.startsWith("97") || codePostal.startsWith("98")) {
    return codePostal.length >= 3 ? codePostal.slice(0, 3) : undefined;
  }
  if (codePostal.startsWith("20") && /^\d{5}$/.test(codePostal)) {
    const n = Number.parseInt(codePostal, 10);
    if (n >= 20000 && n <= 20190) return "2A";
    if (n >= 20200 && n <= 20620) return "2B";
    return undefined;
  }
  return codePostal.slice(0, 2);
}

/**
 * Normalise un code NAF vers le format attendu par l'API DINUM (`XX.XXY`), ou
 * `throw RangeError` si l'entrée n'est pas une sous-classe NAF rév.2 complète.
 *
 * L'API DINUM (`/near_point` et `/search`) n'accepte QUE les sous-classes
 * pointées (`62.01Z`, `86.90B`). Elle accepte aussi le format INSEE compact
 * (`8690B`) qu'on convertit. Tout autre code — division à 2 chiffres (`62`),
 * code tronqué sans lettre (`8690`), libellé — est REJETÉ ICI plutôt que laissé
 * filer vers l'API : un code partiel y produit un HTTP 400 capté en Sentry
 * `error` (faute caller déguisée en panne serveur — issue FRANCE-DATA-MCP-A).
 * Rejeter au boundary mappe sur JSON-RPC `-32602` (invalid params), erreur
 * exploitable par le LLM appelant. Tous les codes valides DINUM matchent
 * `\d{2}\.\d{2}[A-Z]` après normalisation, donc aucun code légitime n'est
 * écarté (call-sites internes : `nafsForFamille` → sous-classes du mapping).
 */
function normalizeNafCode(naf: string): string {
  // Déjà au format pointé : "86.90B"
  if (/^\d{2}\.\d{2}[A-Z]$/.test(naf)) return naf;
  // Format compact : "8690B" → "86.90B"
  if (/^\d{4}[A-Z]$/.test(naf)) return `${naf.slice(0, 2)}.${naf.slice(2)}`;
  throw new RangeError(
    `searchEntreprises: code NAF invalide \`${naf}\`. L'API DINUM exige une sous-classe NAF complète à 5 caractères (ex. \`62.01Z\` ou \`8690B\`), pas une division à 2 chiffres ni un code tronqué.`,
  );
}

function toEntreprise(api: ApiEntreprise): Entreprise {
  const finances: Finance[] = [];
  if (api.finances) {
    for (const [year, fin] of Object.entries(api.finances)) {
      const annee = Number.parseInt(year, 10);
      if (Number.isFinite(annee)) {
        // caFiable: false uniquement quand `ca === 0 && resultatNet > 0` —
        // signal "non déclaré DINUM/RNE" (audit SELARL pharma 2026-05-09). Si
        // ca est undefined OU resultatNet est <= 0/undefined, on considère
        // l'absence ou le 0 comme fiable (entreprise dormante plausible).
        const caFiable = !(fin.ca === 0 && fin.resultat_net !== undefined && fin.resultat_net > 0);
        const f: Finance = { annee, caFiable };
        if (fin.ca !== undefined) f.ca = fin.ca;
        if (fin.resultat_net !== undefined) f.resultatNet = fin.resultat_net;
        finances.push(f);
      }
    }
    finances.sort((a, b) => b.annee - a.annee);
  }

  const etablissements: Etablissement[] = [];
  if (api.siege) etablissements.push(toEtablissement(api.siege));
  if (api.matching_etablissements) {
    for (const m of api.matching_etablissements) {
      if (!api.siege || m.siret !== api.siege.siret) {
        etablissements.push(toEtablissement(m));
      }
    }
  }

  const entreprise: Entreprise = {
    siren: api.siren,
    nomComplet: api.nom_complet ?? api.nom_raison_sociale ?? api.siren,
    finances,
    dirigeants: (api.dirigeants ?? []).map(toDirigeant),
    etablissements,
    actif: (api.etat_administratif ?? "A") === "A",
    // Toujours présent côté retour DINUM pour cohérence du contrat caller :
    // distingue explicitement "DINUM a répondu" du fallback "insee_v3".
    siren_source: "dinum",
    ...pickDefined({
      siretSiege: api.siege?.siret,
      naf: api.activite_principale,
      nafLibelle: api.libelle_activite_principale,
      trancheEffectif: api.tranche_effectif_salarie,
      natureJuridique: api.nature_juridique,
    }),
  };
  if (api.nombre_etablissements !== undefined) {
    entreprise.nombreEtablissements = api.nombre_etablissements;
  }
  if (api.nombre_etablissements_ouverts !== undefined) {
    entreprise.nombreEtablissementsOuverts = api.nombre_etablissements_ouverts;
  }
  return entreprise;
}

function toDirigeant(api: ApiDirigeant): Dirigeant {
  return pickDefined({
    nom: api.nom,
    prenoms: api.prenoms,
    fonction: api.fonction,
    qualite: api.qualite,
  });
}

function toEtablissement(api: ApiSiege): Etablissement {
  const point = parseCoordinates(api.longitude, api.latitude);
  return {
    siret: api.siret ?? "",
    adresse: api.adresse ?? "",
    actif: (api.etat_administratif ?? "A") === "A",
    ...pickDefined({
      codePostal: api.code_postal,
      commune: api.libelle_commune,
      naf: api.activite_principale,
      trancheEffectif: api.tranche_effectif_salarie,
      dateCreation: api.date_creation,
    }),
    ...(point ? { point } : {}),
  };
}
