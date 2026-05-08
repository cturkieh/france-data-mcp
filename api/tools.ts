/**
 * Définition des outils MCP exposés par le serveur france-data-mcp.
 *
 * V0.4 : 11 tools exposés. Territoire + DINUM (live), FINESS (Supabase
 * dump bimestriel, V0.2), Annuaire Santé Ameli (Supabase dump hebdo, V0.4).
 * Les CSV bruts (FINESS 35 Mo, Ameli 154 Mo) restent disponibles dans la lib
 * npm pour les usages hors serveur MCP.
 */

import { getAmeliBySpecialiteDept, getAmeliInRadius } from "../src/sante/ameli-db.js";
import { FINESS_FAMILY_CODES } from "../src/sante/finess-categories.js";
import {
  type FinessFamilleQuery,
  getFinessByCategorie,
  getFinessByNumFiness,
  getFinessInRadius,
} from "../src/sante/finess-db.js";
import { haversineDistance } from "../src/sante/finess.js";
import {
  type SearchEntreprisesResult,
  getEntrepriseBySiren,
  searchEntreprises,
} from "../src/sante/index.js";
import { deptFromCodeInsee } from "../src/territoire/dept-codes.js";
import {
  geocode,
  getCommuneByCode,
  reverseGeocode,
  searchCommunes,
} from "../src/territoire/index.js";

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

/** Garde de typage : renvoie la valeur si c'est une string, sinon undefined. */
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Garde de typage : renvoie la valeur si c'est un number fini, sinon undefined. */
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Familles FINESS exposées en input. Dérivé directement des clés de
 * `FINESS_FAMILY_CODES` pour avoir une seule source de vérité — ajouter une
 * famille là-bas l'expose automatiquement ici.
 */
const FINESS_FAMILLE_INPUTS = Object.keys(FINESS_FAMILY_CODES) as readonly FinessFamilleQuery[];

/** Liste des familles formatée pour les descriptions des tools MCP. */
const FAMILLES_LIST = FINESS_FAMILLE_INPUTS.join(", ");

/** Garde de typage : valide qu'une string est une famille FINESS queryable. */
function asFinessFamille(v: unknown): FinessFamilleQuery | undefined {
  if (typeof v !== "string") return undefined;
  return (FINESS_FAMILLE_INPUTS as readonly string[]).includes(v)
    ? (v as FinessFamilleQuery)
    : undefined;
}

/** Parse + valide un tableau de familles FINESS. Throw si une valeur est invalide. */
function parseFamilles(v: unknown): FinessFamilleQuery[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new Error(
      `familles doit être un tableau (reçu ${typeof v}). Valeurs autorisées : ${FINESS_FAMILLE_INPUTS.join(", ")}.`,
    );
  }
  const parsed: FinessFamilleQuery[] = [];
  for (const item of v) {
    const f = asFinessFamille(item);
    if (!f) {
      throw new Error(
        `famille FINESS invalide : "${String(item)}". Valeurs autorisées : ${FINESS_FAMILLE_INPUTS.join(", ")}.`,
      );
    }
    parsed.push(f);
  }
  return parsed;
}

/** Bornes radius_km pour les outils FINESS (cohérent avec les wrappers). */
const FINESS_RADIUS_MIN_KM = 0.1;
const FINESS_RADIUS_MAX_KM = 50;

/** Valide radiusKm : throw RangeError si hors [0.1, 50]. */
function validateFinessRadiusKm(radiusKm: number): void {
  if (radiusKm < FINESS_RADIUS_MIN_KM || radiusKm > FINESS_RADIUS_MAX_KM) {
    throw new RangeError(
      `radius_km doit être dans [${FINESS_RADIUS_MIN_KM}, ${FINESS_RADIUS_MAX_KM}], reçu ${radiusKm}`,
    );
  }
}

/**
 * Parse un tableau de strings depuis l'input MCP. Throw si l'argument n'est
 * pas un tableau, contient une chaîne vide, ou un élément non-string.
 * Renvoie `undefined` si l'argument est absent OU si le tableau est vide
 * — les deux signifient sémantiquement "pas de filtre", donc on les
 * normalise au même output pour éviter qu'un tableau vide accidentel
 * (`["foo"].filter(predicateThatRejectsAll) → []`) ne devienne un filtre
 * silencieusement vide côté SQL.
 */
function parseStringArray(v: unknown, paramName: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new Error(`${paramName} doit être un tableau de strings (reçu ${typeof v}).`);
  }
  if (v.length === 0) return undefined;
  for (const item of v) {
    if (typeof item !== "string") {
      throw new Error(
        `${paramName}: chaque élément doit être une string (reçu ${typeof item} dans le tableau).`,
      );
    }
    if (item === "") {
      throw new Error(
        `${paramName}: la chaîne vide n'est pas autorisée — passer le tableau sans cet élément ou omettre le paramètre pour ne pas filtrer.`,
      );
    }
  }
  return v as string[];
}

/** Bornes radius_km Ameli (cohérent avec validateRadiusKm dans ameli-db.ts). */
const AMELI_RADIUS_MIN_KM = 0.1;
const AMELI_RADIUS_MAX_KM = 50;

/** Valide radiusKm Ameli côté tool-layer pour un message d'erreur clair (cohérent avec FINESS). */
function validateAmeliRadiusKm(radiusKm: number): void {
  if (radiusKm < AMELI_RADIUS_MIN_KM || radiusKm > AMELI_RADIUS_MAX_KM) {
    throw new RangeError(
      `radius_km doit être dans [${AMELI_RADIUS_MIN_KM}, ${AMELI_RADIUS_MAX_KM}], reçu ${radiusKm}`,
    );
  }
}

/**
 * Mention CGU obligatoire pour la réutilisation des données Annuaire Santé
 * Ameli (art. L.1461-2 CSP). Affichée dans la description de chaque tool
 * Ameli pour que tout caller MCP la voie avant d'invoquer.
 */
const AMELI_CGU =
  "Source : Annuaire santé Ameli (Assurance Maladie), MAJ hebdomadaire. " +
  "Réutilisation soumise à l'art. L.1461-2 CSP — citer la source et la date de sync.";

/**
 * Réponse enrichie du fallback `naf + center+radiusKm` (limite API DINUM).
 *
 * Le champ `fallback` documente la stratégie ET signale honnêtement quand la
 * réponse peut être incomplète (`truncated: true` quand l'API a renvoyé plus
 * d'entreprises NAF dans le département qu'on n'a pu en évaluer).
 *
 * - `total` : nombre d'entreprises dans le rayon (post-filtrage Haversine).
 * - `fallback.totalInDepartement` : nombre total NAF dans le département (avant Haversine).
 * - `fallback.evaluees` : nombre d'entreprises effectivement évaluées (max 25).
 * - `fallback.truncated` : true si on a évalué moins que `totalInDepartement`.
 * - `fallback.warning` : message actionnable pour le caller, présent uniquement quand truncated.
 */
type EntreprisesInRadiusFallbackResult = SearchEntreprisesResult & {
  fallback: {
    strategy: string;
    departementUtilise: string;
    evaluees: number;
    totalInDepartement: number;
    truncated: boolean;
    warning?: string;
  };
};

/**
 * Extrait le code département d'un code commune INSEE.
 * Alias historique conservé pour la compat des callers — la logique vit
 * dans `src/territoire/dept-codes.ts` (consolidation V0.4).
 */
export const deptFromCommune = deptFromCodeInsee;

/**
 * Contourne la limitation API DINUM : `activite_principale + lat/long/radius`
 * n'est pas supporté nativement (les coords requièrent un `q` textuel).
 *
 * Stratégie : reverseGeocode du centre → département → searchEntreprises filtré
 * → filtre Haversine côté serveur sur les sièges des établissements.
 *
 * Limitation : seules les 25 premières entreprises NAF du département sont
 * évaluées (cap `perPage` API DINUM).
 */
async function searchByNafInRadius(params: {
  naf: string;
  center: { lon: number; lat: number };
  radiusKm: number;
}): Promise<EntreprisesInRadiusFallbackResult> {
  const { naf, center, radiusKm } = params;

  let reverse: Awaited<ReturnType<typeof reverseGeocode>>;
  try {
    reverse = await reverseGeocode(center);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[france-data-mcp] entreprises_in_radius fallback: reverseGeocode failed for lon=${center.lon} lat=${center.lat}: ${msg}`,
    );
    throw new Error(
      `entreprises_in_radius: reverseGeocode IGN a échoué (${msg}). Fournir 'departement' ou 'codePostal' explicitement pour contourner.`,
    );
  }

  const fallbackDept = deptFromCommune(reverse?.codeCommune);
  if (!fallbackDept) {
    throw new Error(
      `entreprises_in_radius: impossible de déduire le département du point lon=${center.lon} lat=${center.lat} via reverseGeocode (codeCommune="${reverse?.codeCommune ?? "absent"}"). Fournir 'departement' ou 'codePostal' explicitement.`,
    );
  }

  const result = await searchEntreprises({
    naf,
    departement: fallbackDept,
    perPage: 25,
    page: 1,
  });
  const radiusMeters = radiusKm * 1000;
  const filtered = result.entreprises.filter((e) =>
    e.etablissements.some((et) => et.point && haversineDistance(center, et.point) <= radiusMeters),
  );

  const evaluees = result.entreprises.length;
  const totalInDepartement = result.total;
  const truncated = totalInDepartement > evaluees;
  const fallback: EntreprisesInRadiusFallbackResult["fallback"] = {
    strategy: "reverseGeocode + departement + Haversine client-side filter",
    departementUtilise: fallbackDept,
    evaluees,
    totalInDepartement,
    truncated,
  };
  if (truncated) {
    fallback.warning = `Seules ${evaluees}/${totalInDepartement} entreprises NAF ${naf} du département ${fallbackDept} ont été évaluées (limite API DINUM 25 par page). Le résultat peut sous-estimer le nombre réel d'entreprises dans le rayon. Pour exhaustivité, restreindre par 'codePostal' précis ou utiliser un 'q' textuel avec center+radiusKm.`;
  }

  return {
    ...result,
    entreprises: filtered,
    total: filtered.length,
    totalPages: 1,
    fallback,
  };
}

export const TOOLS: McpTool[] = [
  {
    name: "autocomplete_commune",
    description:
      "Recherche de communes françaises par nom, code postal ou code INSEE. Idéal pour autocomplétion. Source : geo.api.gouv.fr (DINUM/Etalab).",
    inputSchema: {
      type: "object",
      properties: {
        nom: { type: "string", description: "Recherche par nom (autocomplétion)." },
        codePostal: { type: "string", description: "Code postal exact (5 chiffres)." },
        code: { type: "string", description: "Code INSEE exact (5 caractères)." },
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-30, défaut 10).",
          default: 10,
        },
        boostPopulation: {
          type: "boolean",
          description:
            "Trier par population décroissante. Recommandé pour les noms ambigus (ex: 'Charleville').",
          default: true,
        },
      },
    },
    handler: async (args) => {
      const opts: Parameters<typeof searchCommunes>[0] = {
        boostPopulation: args.boostPopulation !== false,
      };
      const nom = asString(args.nom);
      const codePostal = asString(args.codePostal);
      const code = asString(args.code);
      const limit = asNumber(args.limit);
      if (nom) opts.nom = nom;
      if (codePostal) opts.codePostal = codePostal;
      if (code) opts.code = code;
      if (limit !== undefined) opts.limit = limit;
      return searchCommunes(opts);
    },
  },
  {
    name: "get_commune_by_code",
    description: "Récupère une commune par son code INSEE. Renvoie null si introuvable.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Code INSEE (5 caractères)." },
      },
      required: ["code"],
    },
    handler: async (args) => {
      if (typeof args.code !== "string") throw new Error("code (string) requis");
      return getCommuneByCode(args.code);
    },
  },
  {
    name: "geocode_adresse",
    description:
      "Géocode une adresse française en coordonnées GPS. Source : IGN Géoplateforme (data.geopf.fr). Précision au numéro de rue.",
    inputSchema: {
      type: "object",
      properties: {
        adresse: { type: "string", description: "Adresse complète à géocoder." },
        codePostal: {
          type: "string",
          description: "Optionnel — limiter le résultat à un code postal pour désambiguïser.",
        },
        codeCommune: {
          type: "string",
          description: "Optionnel — limiter au code INSEE de commune.",
        },
      },
      required: ["adresse"],
    },
    handler: async (args) => {
      const adresse = asString(args.adresse);
      if (!adresse) throw new Error("adresse (string) requise");
      const opts: Parameters<typeof geocode>[1] = {};
      const codePostal = asString(args.codePostal);
      const codeCommune = asString(args.codeCommune);
      if (codePostal) opts.codePostal = codePostal;
      if (codeCommune) opts.codeCommune = codeCommune;
      return geocode(adresse, opts);
    },
  },
  {
    name: "reverse_geocode",
    description:
      "Géocodage inverse : à partir de coordonnées GPS, retrouve l'adresse la plus proche. Source : IGN Géoplateforme.",
    inputSchema: {
      type: "object",
      properties: {
        lon: { type: "number", description: "Longitude (WGS84)." },
        lat: { type: "number", description: "Latitude (WGS84)." },
      },
      required: ["lon", "lat"],
    },
    handler: async (args) => {
      const lon = Number(args.lon);
      const lat = Number(args.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        throw new Error("lon et lat (number) requis");
      }
      return reverseGeocode({ lon, lat });
    },
  },
  {
    name: "entreprises_in_radius",
    description:
      "Recherche d'entreprises françaises avec filtres NAF, code postal, département ou rayon géographique. Couvre tous secteurs (santé via NAF 8690B, 4773Z, 8710A, 8621Z, etc.). Source : DINUM Recherche Entreprises (SIRENE + RNE). Renvoie CA, dirigeants, tranches d'effectif et dates de création.\n\nLimitation API DINUM : la combinaison `naf + lat/lon/radiusKm` n'est pas supportée nativement (lat/lon nécessitent un `q` textuel). Le serveur applique alors un fallback : reverseGeocode du point → recherche par département → filtrage Haversine côté serveur. Les résultats sont limités aux 25 premières entreprises du NAF dans le département (limite API).",
    inputSchema: {
      type: "object",
      properties: {
        naf: {
          type: "string",
          description:
            "Code NAF principal (ex: '8690B' = labos, '4773Z' = pharmacies, '8710A' = EHPAD, '8621Z' = MG).",
        },
        q: {
          type: "string",
          description: "Recherche textuelle libre (raison sociale, dirigeant…).",
        },
        lon: { type: "number", description: "Longitude du centre du cercle de recherche." },
        lat: { type: "number", description: "Latitude du centre du cercle de recherche." },
        radiusKm: { type: "number", description: "Rayon en km (1-50)." },
        codePostal: { type: "string", description: "Filtre alternatif : code postal exact." },
        departement: { type: "string", description: "Filtre alternatif : code département." },
        perPage: {
          type: "number",
          description: "Résultats par page (1-25, défaut 10).",
          default: 10,
        },
        page: { type: "number", description: "Page (1-indexed).", default: 1 },
      },
    },
    handler: async (args) => {
      const naf = asString(args.naf);
      const q = asString(args.q);
      const codePostal = asString(args.codePostal);
      const departement = asString(args.departement);
      const perPage = asNumber(args.perPage);
      const page = asNumber(args.page);
      const lon = asNumber(args.lon);
      const lat = asNumber(args.lat);
      const radiusKm = asNumber(args.radiusKm);
      const hasCoords = lon !== undefined && lat !== undefined && radiusKm !== undefined;

      // Cas qui pose problème côté API DINUM : `naf + lat/long/radius`. L'API
      // exige que les coords soient accompagnées d'un `q` textuel. On contourne
      // via reverseGeocode + filtrage Haversine, géré dans `searchByNafInRadius`.
      if (naf && hasCoords && !q && !departement && !codePostal) {
        return searchByNafInRadius({ naf, center: { lon, lat }, radiusKm });
      }

      const opts: Parameters<typeof searchEntreprises>[0] = {};
      if (naf) opts.naf = naf;
      if (q) opts.q = q;
      if (codePostal) opts.codePostal = codePostal;
      if (departement) opts.departement = departement;
      if (perPage !== undefined) opts.perPage = perPage;
      if (page !== undefined) opts.page = page;
      if (hasCoords) {
        opts.center = { lon, lat };
        opts.radiusKm = radiusKm;
      }
      return searchEntreprises(opts);
    },
  },
  {
    name: "entreprise_by_siren",
    description:
      "Récupère le détail d'une entreprise française par son SIREN (9 chiffres) : raison sociale, NAF, finances historiques, dirigeants, établissements. Source : DINUM Recherche Entreprises.\n\n⚠️ La liste `etablissements` peut être tronquée. Le champ `nombreEtablissements` (compté SIRENE) reflète le total réel. **Lire `enrichmentStatus`** pour savoir si la liste est complète :\n- `success` : `etablissements` contient tous les sites\n- `partial` : sites manquants (multi-département ou NAF différent du siège) — voir `enrichmentWarning`\n- `failed` : l'enrichissement a échoué (rate limit, panne API) — seul le siège est listé\n- `not_attempted` : entreprise monosite ou data SIRENE manquante\n\nPour énumération exhaustive multi-département, utiliser `entreprises_in_radius` par zone géographique. Coût : 1 ou 2 appels API DINUM par invocation (rate limit ~1 req/s effectif).",
    inputSchema: {
      type: "object",
      properties: {
        siren: { type: "string", description: "SIREN exact, 9 chiffres." },
      },
      required: ["siren"],
    },
    handler: async (args) => {
      if (typeof args.siren !== "string") throw new Error("siren (string) requis");
      return getEntrepriseBySiren(args.siren);
    },
  },
  {
    name: "etablissements_finess_in_radius",
    description: `Recherche d'établissements de santé FINESS dans un rayon géographique (PostGIS ST_DWithin). Filtrable par familles : ${FAMILLES_LIST}. Source : FINESS / DREES (dump CSV ingéré localement).`,
    inputSchema: {
      type: "object",
      properties: {
        lon: { type: "number", description: "Longitude du centre (WGS84)." },
        lat: { type: "number", description: "Latitude du centre (WGS84)." },
        radius_km: {
          type: "number",
          description: "Rayon en km (0.1-50, défaut 5).",
          minimum: FINESS_RADIUS_MIN_KM,
          maximum: FINESS_RADIUS_MAX_KM,
          default: 5,
        },
        familles: {
          type: "array",
          description:
            "Familles FINESS à inclure (mco = court séjour, ssr = soins de suite, ehpad). Si omis, toutes catégories.",
          items: { type: "string", enum: [...FINESS_FAMILLE_INPUTS] },
        },
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-500, défaut 100).",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
      },
      required: ["lon", "lat"],
    },
    handler: async (args) => {
      const lon = asNumber(args.lon);
      const lat = asNumber(args.lat);
      if (lon === undefined || lat === undefined) {
        throw new Error("lon et lat (number) requis");
      }
      const radiusKm = asNumber(args.radius_km) ?? 5;
      validateFinessRadiusKm(radiusKm);
      const familles = parseFamilles(args.familles);
      const limit = asNumber(args.limit);
      const input: Parameters<typeof getFinessInRadius>[0] = {
        center: { lon, lat },
        radiusKm,
      };
      if (familles) input.familles = familles;
      if (limit !== undefined) input.limit = limit;
      return getFinessInRadius(input);
    },
  },
  {
    name: "etablissements_finess_by_categorie",
    description: `Liste des établissements FINESS par famille (${FAMILLES_LIST}), avec filtre département ou commune optionnel. Pas de rayon — pour énumération exhaustive d'une zone administrative. Source : FINESS / DREES.`,
    inputSchema: {
      type: "object",
      properties: {
        categorie: {
          type: "string",
          description: "Famille FINESS recherchée (mco, ssr, ehpad).",
          enum: [...FINESS_FAMILLE_INPUTS],
        },
        departement: {
          type: "string",
          description:
            "Code département (2 caractères métropole/Corse, 3 pour DOM/TOM). Optionnel.",
        },
        code_insee: {
          type: "string",
          description: "Code INSEE de commune (5 caractères). Optionnel.",
        },
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-500, défaut 100).",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
      },
      required: ["categorie"],
    },
    handler: async (args) => {
      const famille = asFinessFamille(args.categorie);
      if (!famille) {
        throw new Error(`categorie (string) requis : ${FINESS_FAMILLE_INPUTS.join(", ")}.`);
      }
      const departement = asString(args.departement);
      const codeInsee = asString(args.code_insee);
      const limit = asNumber(args.limit);
      const input: Parameters<typeof getFinessByCategorie>[0] = { famille };
      if (departement) input.departement = departement;
      if (codeInsee) input.code_insee = codeInsee;
      if (limit !== undefined) input.limit = limit;
      return getFinessByCategorie(input);
    },
  },
  {
    name: "etablissement_by_finess",
    description:
      "Récupère le détail complet d'un établissement de santé par son numéro FINESS (9 chiffres) : raison sociale, catégorie + famille, adresse complète (voie + CP + ville + code INSEE + département), coordonnées GPS, téléphone. Renvoie null si introuvable. Source : FINESS / DREES.",
    inputSchema: {
      type: "object",
      properties: {
        num_finess: {
          type: "string",
          description: "Numéro FINESS exact (9 chiffres).",
        },
      },
      required: ["num_finess"],
    },
    handler: async (args) => {
      const numFiness = asString(args.num_finess);
      if (!numFiness) throw new Error("num_finess (string, 9 chiffres) requis");
      return getFinessByNumFiness(numFiness);
    },
  },
  {
    name: "professionnels_in_radius",
    description: `Recherche de professionnels de santé libéraux conventionnés dans un rayon géographique. Précision géo : centroïde commune (~3 km en moyenne — adapté à l'analyse de densité, pas au géocodage adresse). Filtres optionnels : codes spécialité Ameli (ex: '01' MG, '03' cardio, '06' dermato) et codes type PS ('1' médecin, '2' IDE, '3' sage-femme, '4' chir-dentiste, '5' pharmacien, '8' kiné, etc.). ${AMELI_CGU}`,
    inputSchema: {
      type: "object",
      properties: {
        lon: { type: "number", description: "Longitude du centre (WGS84)." },
        lat: { type: "number", description: "Latitude du centre (WGS84)." },
        radius_km: {
          type: "number",
          description: "Rayon en km (0.1-50, défaut 5).",
          minimum: 0.1,
          maximum: 50,
          default: 5,
        },
        specialite_codes: {
          type: "array",
          description:
            "Liste de codes spécialité Ameli (ex: ['01'] MG, ['03'] cardio). Si omis, toutes spécialités.",
          items: { type: "string" },
        },
        type_ps_codes: {
          type: "array",
          description:
            "Liste de codes type PS (ex: ['1'] médecins, ['2'] IDE). Si omis, tous types.",
          items: { type: "string" },
        },
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-500, défaut 100).",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
      },
      required: ["lon", "lat"],
    },
    handler: async (args) => {
      const lon = asNumber(args.lon);
      const lat = asNumber(args.lat);
      if (lon === undefined || lat === undefined) {
        throw new Error("lon et lat (number) requis");
      }
      const radiusKm = asNumber(args.radius_km) ?? 5;
      validateAmeliRadiusKm(radiusKm);
      const specialiteCodes = parseStringArray(args.specialite_codes, "specialite_codes");
      const typePsCodes = parseStringArray(args.type_ps_codes, "type_ps_codes");
      const limit = asNumber(args.limit);
      const input: Parameters<typeof getAmeliInRadius>[0] = {
        center: { lon, lat },
        radiusKm,
      };
      if (specialiteCodes) input.specialiteCodes = specialiteCodes;
      if (typePsCodes) input.typePsCodes = typePsCodes;
      if (limit !== undefined) input.limit = limit;
      return getAmeliInRadius(input);
    },
  },
  {
    name: "professionnels_par_specialite_dept",
    description: `Liste des professionnels de santé libéraux conventionnés d'un département, avec filtres optionnels par spécialité ou type de PS. Pour énumération administrative — pas de rayon. ${AMELI_CGU}`,
    inputSchema: {
      type: "object",
      properties: {
        departement: {
          type: "string",
          description:
            "Code département INSEE : 2 caractères métropole/Corse ('01'-'95', '2A'/'2B'), 3 caractères DOM ('971'-'978').",
        },
        specialite_code: {
          type: "string",
          description: "Code spécialité Ameli (ex: '03' cardio). Optionnel.",
        },
        type_ps_code: {
          type: "string",
          description: "Code type PS (ex: '1' médecin). Optionnel.",
        },
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-500, défaut 100).",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
      },
      required: ["departement"],
    },
    handler: async (args) => {
      const departement = asString(args.departement);
      if (!departement) throw new Error("departement (string) requis");
      const specialiteCode = asString(args.specialite_code);
      const typePsCode = asString(args.type_ps_code);
      const limit = asNumber(args.limit);
      const input: Parameters<typeof getAmeliBySpecialiteDept>[0] = { departement };
      if (specialiteCode) input.specialiteCode = specialiteCode;
      if (typePsCode) input.typePsCode = typePsCode;
      if (limit !== undefined) input.limit = limit;
      return getAmeliBySpecialiteDept(input);
    },
  },
];

export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((t) => t.name === name);
}
