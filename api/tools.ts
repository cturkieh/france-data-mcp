/**
 * Définition des outils MCP exposés par le serveur france-data-mcp.
 *
 * V0.4 : 11 tools exposés. Territoire + DINUM (live), FINESS (Supabase
 * dump bimestriel, V0.2), Annuaire Santé Ameli (Supabase dump hebdo, V0.4).
 * Les CSV bruts (FINESS 35 Mo, Ameli 154 Mo) restent disponibles dans la lib
 * npm pour les usages hors serveur MCP.
 */

import {
  type AmeliQueryResult,
  type AmeliResult,
  getAmeliBySpecialiteDept,
  getAmeliInRadius,
  listAmeliSpecialites,
  listAmeliTypesPs,
} from "../src/sante/ameli-db.js";
import { RADIUS_MAX_KM, RADIUS_MIN_KM } from "../src/sante/db-helpers.js";
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

/**
 * Garde de typage tolérante : accepte un number direct OU une string
 * numérique (`"49.7724"`). Beaucoup de clients MCP sérialisent les nombres
 * comme strings au passage par leur transport JSON-RPC, donc rejeter
 * `typeof !== "number"` strict bloque des callers parfaitement légitimes
 * (audit empirique 2026-05-08 sur le client Claude Code).
 *
 * Renvoie `undefined` pour tout ce qui n'est pas un nombre fini après
 * coercition — booleans, objets, NaN, `Infinity`, strings non-numériques,
 * absent. Confond donc "absent" et "invalide" : préférer `coerceNumber`
 * dans les call-sites qui ont un fallback `?? default`, sinon une saisie
 * erronée (`radius_km: "50 km"`) tomberait silencieusement sur le default.
 */
function asNumber(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Variante stricte de `asNumber` : throw sur input invalide non-absent.
 * Renvoie `undefined` UNIQUEMENT si l'argument est absent (`undefined`/`null`).
 *
 * À utiliser pour tout paramètre qui a un fallback (`?? default`) ou qui
 * forward `undefined` à un wrapper qui défaut. Sans cette discrimination,
 * `asNumber("abc") ?? 5` retourne 5 silencieusement et masque la saisie
 * invalide — silent failure que CLAUDE.md interdit explicitement.
 */
function coerceNumber(v: unknown, paramName: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = asNumber(v);
  if (n === undefined) {
    // RangeError plutôt qu'Error pour cohérence avec les autres validators
    // (clampLimit, validateRadiusKm…). Permet à `api/mcp.ts` de mapper sur
    // JSON-RPC -32602 (Invalid params) au lieu de -32603 (Internal error).
    throw new RangeError(`${paramName} doit être un nombre fini (reçu : ${JSON.stringify(v)})`);
  }
  return n;
}

/**
 * Coercition booléenne tolérante. Mêmes raisons que `asNumber` : les transports
 * MCP peuvent stringifier `true` → `"true"`. Sans ce helper, `dedupe_by_ps:
 * "true"` côté client retourne silencieusement le résultat non-dédupliqué,
 * variante du même silent failure que `asNumber("50 km") ?? 5`.
 *
 * Reconnu : `true`/`false`, `"true"`/`"false"` (insensible casse), `"1"`/`"0"`,
 * `1`/`0`. Tout autre input est rejeté avec throw — pas de fallback silencieux.
 */
function coerceBoolean(v: unknown, paramName: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (v === 1) return true;
    if (v === 0) return false;
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  // RangeError pour cohérence (cf. coerceNumber) → JSON-RPC -32602.
  throw new RangeError(`${paramName} doit être un booléen (reçu : ${JSON.stringify(v)})`);
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

/**
 * Mention CGU obligatoire pour la réutilisation des données Annuaire Santé
 * Ameli (art. L.1461-2 CSP). Affichée dans la description de chaque tool
 * Ameli pour que tout caller MCP la voie avant d'invoquer.
 *
 * `AMELI_SCOPE_WARNING` cadre le périmètre exact de la source amont. Le piège
 * récurrent (audit Charleville 2026-05-08) : un caller voit "Annuaire Santé
 * Ameli" et croit à un répertoire exhaustif des PS — alors que c'est UNIQUEMENT
 * les libéraux conventionnés. Les hospitaliers salariés, biologistes médicaux
 * salariés en LBM, anatomopathologistes hospitaliers, médecins du travail et
 * médecine légale en sont absents par construction. Pour un référentiel tous
 * statuts, il faut RPPS / Annuaire Santé ANS (esante.gouv.fr) — non couvert
 * par ce serveur en v0.4.
 */
const AMELI_CGU =
  "Source : Annuaire santé Ameli (Assurance Maladie), MAJ hebdomadaire. " +
  "Réutilisation soumise à l'art. L.1461-2 CSP — citer la source et la date de sync.";

const AMELI_SCOPE_WARNING =
  "PÉRIMÈTRE : libéraux conventionnés UNIQUEMENT. " +
  "HORS PÉRIMÈTRE : médecins exclusivement hospitaliers/salariés, " +
  "biologistes médicaux salariés en LBM, anatomopathologistes hospitaliers, " +
  "médecins du travail, médecine légale. " +
  "Pour effectifs tous statuts, voir Annuaire Santé ANS (RPPS, esante.gouv.fr) — non couvert par ce serveur.";

/**
 * Aide à la sélection des codes type_ps Ameli, intégrée à toutes les
 * descriptions de tools de prospection. Volontairement courte pour ne pas
 * bloater le token budget côté caller : la nomenclature exhaustive vit dans
 * les tools `lister_specialites_ameli` et `lister_types_ps_ameli`.
 *
 * Le code "2" est intentionnellement décrit comme "fourre-tout" — c'est le
 * piège récurrent (audit Charleville 2026-05-09). Sans cette précision, un
 * caller filtrant `type_ps_codes=["2"]` pour cibler les IDE récupère en
 * réalité IDE + kinés + sages-femmes + podologues + orthophonistes + IPA,
 * soit ~2x les volumes attendus.
 */
const AMELI_TYPE_PS_HELP =
  "Codes type_ps Ameli présents en base (3) : '1' médecins, '2' auxiliaires médicaux (fourre-tout : IDE, kinés, sages-femmes, podologues, orthophonistes, orthoptistes, IPA), '5' chirurgiens-dentistes.";

/**
 * Réponse enrichie du fallback `naf + center+radiusKm` (limite API DINUM).
 *
 * Le champ `fallback` documente la stratégie ET signale honnêtement quand la
 * réponse peut être incomplète (`truncated: true` quand l'API a renvoyé plus
 * d'entreprises NAF dans le département qu'on n'a pu en évaluer).
 *
 * - `total` : nombre d'entreprises dans le rayon (post-filtrage Haversine, AVANT
 *   troncature `perPage`). Le caller voit le décompte réel, pas l'estimation
 *   tronquée — important pour ne pas sous-estimer une zone à la prospection.
 * - `truncated_by_per_page` : true quand `total > perPage` et que la liste
 *   `entreprises` est tronquée à `perPage`. Signal explicite, pas implicite.
 * - `fallback.totalInDepartement` : nombre total NAF dans le département (avant Haversine).
 * - `fallback.evaluees` : nombre d'entreprises effectivement évaluées (max 25).
 * - `fallback.truncated` : true si on a évalué moins que `totalInDepartement`.
 * - `fallback.warning` : message actionnable pour le caller, présent uniquement quand truncated.
 */
type EntreprisesInRadiusFallbackResult = SearchEntreprisesResult & {
  truncated_by_per_page?: boolean;
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
 * Site d'exercice d'un PS dédupliqué — sous-ensemble par-site de `AmeliResult`.
 * `Pick` lie le shape à la source canonique : ajouter un champ par-site dans
 * `AmeliResult` (ex: `horaires_ouverture`) propagera ici via compile-error,
 * pas via silencieux drop. Plus robuste qu'une duplication manuelle.
 */
type AmeliPsSite = Pick<
  AmeliResult,
  "id" | "adresse" | "coords" | "distance_km" | "telephone" | "conventions"
>;

/** Praticien dédupliqué — identité partagée + tableau des sites d'exercice. */
type AmeliPsDedup = Pick<AmeliResult, "identite" | "specialite" | "type_ps"> & {
  sites: AmeliPsSite[];
};

/**
 * Sortie du dédupe Ameli. Champ `count` = nombre de **praticiens distincts**
 * (≠ raw `count` qui compte les **entrées** Ameli, une par site).
 *
 * `rawCount` propage le décompte amont AVANT regroupement pour qu'un caller
 * paginant en mode dédupe puisse calculer correctement le `nextOffset` :
 * `nextOffset = previousOffset + rawCount` (PAS `+ count` qui sous-estime
 * et fait sauter des entrées sur les pages suivantes).
 *
 * `warning` est posé si la dédup tourne sur un résultat tronqué : le même PS
 * peut occuper deux pages, et apparaîtra alors comme deux praticiens distincts
 * — la dédup est partielle. Pattern aligné sur `entreprises_in_radius`
 * `fallback.warning` qui surface honnêtement les limites côté caller.
 */
type AmeliDedupedResult = {
  count: number;
  rawCount: number;
  truncated: boolean;
  results: AmeliPsDedup[];
  warning?: string;
};

const DEDUPE_TRUNCATED_WARNING =
  "Dédup partielle : appliquée sur un résultat tronqué amont. " +
  "Un même praticien à cheval sur deux pages apparaîtra comme deux entrées distinctes. " +
  "Re-paginer (offset + rawCount) jusqu'à truncated=false avant de cumuler les counts uniques.";

/**
 * Regroupe les entrées Ameli par praticien (clé : nom + prenom + civilite +
 * specialite_code + type_ps_code + raison_sociale). Les sites multiples du
 * même PS sont listés dans `sites[]` au lieu d'occuper N entrées séparées.
 *
 * Pourquoi cette clé : (nom, prenom) seuls collisionnent (3 "DUPONT JEAN" en
 * France). Ajouter civilité + spécialité + raison sociale réduit à un taux de
 * collision négligeable. La source publique n'expose pas RPPS/ADELI (commentaire
 * de la migration `20260508000016`), donc on ne peut pas faire mieux côté
 * serveur ; un caller voulant une dédup parfaite doit cross-référencer avec
 * un autre référentiel (ANS RPPS).
 *
 * Note `Array.prototype.join` : null/undefined dans les éléments du tableau
 * sont coerced en chaîne vide automatiquement (ES1 spec) — pas besoin de
 * `?? ""` défensif.
 */
function dedupeAmeliByPs(result: AmeliQueryResult): AmeliDedupedResult {
  const grouped = new Map<string, AmeliPsDedup>();
  // Iteration order = input order, which is already sorted by distance/name
  // upstream — preserve it to keep the output deterministic.
  for (const row of result.results) {
    // JSON.stringify plutôt que `[...].join("|")` : la raison sociale peut
    // contenir un pipe ("SELARL X | Y") qui collisionnerait sinon avec un
    // praticien différent post-split. Garantit l'unicité de la clé sans
    // séparateur fragile.
    const key = JSON.stringify([
      row.identite.nom,
      row.identite.prenom,
      row.identite.civilite,
      row.identite.raison_sociale,
      row.specialite.code,
      row.type_ps.code,
    ]);
    const { identite, specialite, type_ps, ...site } = row;
    const existing = grouped.get(key);
    if (existing) {
      existing.sites.push(site);
    } else {
      grouped.set(key, { identite, specialite, type_ps, sites: [site] });
    }
  }
  const results = Array.from(grouped.values());
  const out: AmeliDedupedResult = {
    count: results.length,
    rawCount: result.count,
    truncated: result.truncated,
    results,
  };
  if (result.truncated) out.warning = DEDUPE_TRUNCATED_WARNING;
  return out;
}

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
  /**
   * Troncature finale appliquée APRÈS le filtre Haversine. Défaut 10 (cohérent
   * avec le schéma MCP). L'API DINUM amont fixe son `per_page` à 25 (max) pour
   * maximiser la couverture du département avant filtrage géo — `perPage` ici
   * ne contrôle QUE la troncature de la sortie au caller MCP.
   */
  perPage?: number;
}): Promise<EntreprisesInRadiusFallbackResult> {
  const { naf, center, radiusKm } = params;
  // Défaut 10 aligné sur le schéma `perPage` du tool MCP. Sans cette troncature
  // finale, un caller demandant `perPage: 3` recevait silencieusement le post-
  // filtre Haversine entier (jusqu'à 25). Validation explicite : entier dans
  // [1, 25]. Throw plutôt qu'un clamp silencieux — règle "afficher le critère
  // manquant" plutôt que masquer une saisie invalide (CLAUDE.md error handling).
  const perPage = params.perPage ?? 10;
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 25) {
    throw new RangeError(
      `entreprises_in_radius: perPage doit être un entier entre 1 et 25 (reçu: ${perPage}).`,
    );
  }

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

  // total annoncé = filtered.length (décompte réel post-Haversine, AVANT
  // troncature `perPage`). La troncature est explicite via `truncated_by_per_page`
  // pour qu'un caller voyant `entreprises.length < total` comprenne pourquoi.
  const truncatedByPerPage = filtered.length > perPage;
  const out: EntreprisesInRadiusFallbackResult = {
    ...result,
    entreprises: truncatedByPerPage ? filtered.slice(0, perPage) : filtered,
    total: filtered.length,
    perPage,
    totalPages: Math.max(1, Math.ceil(filtered.length / perPage)),
    fallback,
  };
  if (truncatedByPerPage) out.truncated_by_per_page = true;
  return out;
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
      const limit = coerceNumber(args.limit, "limit");
      if (nom) opts.nom = nom;
      if (codePostal) opts.codePostal = codePostal;
      if (code) opts.code = code;
      if (limit !== undefined) opts.limit = limit;
      return searchCommunes(opts);
    },
  },
  {
    name: "get_commune_by_code",
    description:
      "Récupère une commune par son code INSEE. Retourne un objet `LookupResult` discriminé par `found`. `found: true` → champs commune à plat (nom, codesPostaux, centre…). `found: false` → `{ found: false, key, lookupStatus: 'not_found', message }` orientant vers `autocomplete_commune` pour disambiguer.",
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
      // coerceNumber (vs asNumber) : un caller passant `radiusKm: "50 km"`
      // tomberait silencieusement sur "pas de filtre géo" au lieu de signaler
      // la saisie. Même silent-failure shape que le bug Charleville sur
      // `professionnels_in_radius` corrigé en V0.4.1 — propagé ici par cohérence.
      const perPage = coerceNumber(args.perPage, "perPage");
      const page = coerceNumber(args.page, "page");
      const lon = coerceNumber(args.lon, "lon");
      const lat = coerceNumber(args.lat, "lat");
      const radiusKm = coerceNumber(args.radiusKm, "radiusKm");
      const hasCoords = lon !== undefined && lat !== undefined && radiusKm !== undefined;

      // Cas qui pose problème côté API DINUM : `naf + lat/long/radius`. L'API
      // exige que les coords soient accompagnées d'un `q` textuel. On contourne
      // via reverseGeocode + filtrage Haversine, géré dans `searchByNafInRadius`.
      // `perPage` propagé pour que la troncature finale honore le contrat MCP —
      // sans propagation, le filtre Haversine peut retourner > perPage matches.
      if (naf && hasCoords && !q && !departement && !codePostal) {
        const fallbackParams: Parameters<typeof searchByNafInRadius>[0] = {
          naf,
          center: { lon, lat },
          radiusKm,
        };
        if (perPage !== undefined) fallbackParams.perPage = perPage;
        return searchByNafInRadius(fallbackParams);
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
      "Récupère le détail d'une entreprise française par son SIREN (9 chiffres) : raison sociale, NAF, finances historiques, dirigeants, établissements. Source : DINUM Recherche Entreprises.\n\n**Format de retour** : objet `LookupResult` discriminé par `found`.\n- `found: true` → l'entreprise est retournée à plat (champs `siren`, `nomComplet`, `etablissements`, `enrichmentStatus`, …)\n- `found: false` → `{ found: false, key, lookupStatus: 'not_found' | 'ambiguous', message }`. `not_found` : SIREN non indexé par DINUM (souvent diffusion partielle INSEE — l'entreprise peut quand même exister dans SIRENE). `ambiguous` : régression API à signaler.\n\n⚠️ Quand `found: true`, la liste `etablissements` peut être tronquée. Le champ `nombreEtablissements` (compté SIRENE) reflète le total réel. **Lire `enrichmentStatus`** pour savoir si la liste est complète :\n- `success` : `etablissements` contient tous les sites\n- `partial` : sites manquants (multi-département ou NAF différent du siège) — voir `enrichmentWarning`\n- `failed` : l'enrichissement a échoué (rate limit, panne API) — seul le siège est listé\n- `not_attempted` : entreprise monosite ou data SIRENE manquante\n\nPour énumération exhaustive multi-département, utiliser `entreprises_in_radius` par zone géographique. Coût : 1 ou 2 appels API DINUM par invocation (rate limit ~1 req/s effectif).",
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
    description: `Recherche d'établissements de santé FINESS dans un rayon géographique (PostGIS ST_DWithin). Filtrable par familles. 24 valeurs disponibles : ${FAMILLES_LIST}. Source : FINESS / DREES (dump CSV ingéré localement). Note : champ \`email\` toujours \`null\` (non exposé par FINESS public).`,
    inputSchema: {
      type: "object",
      properties: {
        lon: { type: "number", description: "Longitude du centre (WGS84)." },
        lat: { type: "number", description: "Latitude du centre (WGS84)." },
        radius_km: {
          type: "number",
          description: "Rayon en km (0.1-50, défaut 5).",
          minimum: RADIUS_MIN_KM,
          maximum: RADIUS_MAX_KM,
          default: 5,
        },
        familles: {
          type: "array",
          description:
            "Familles FINESS à inclure (24 valeurs disponibles, voir enum). Si omis, toutes catégories.",
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
      const lon = coerceNumber(args.lon, "lon");
      const lat = coerceNumber(args.lat, "lat");
      if (lon === undefined || lat === undefined) {
        throw new Error("lon et lat (number) requis");
      }
      const radiusKm = coerceNumber(args.radius_km, "radius_km") ?? 5;
      // Bornes radius validées au DB layer (validateRadiusKm dans
      // finess-db.ts/ameli-db.ts via db-helpers) — source unique.
      const familles = parseFamilles(args.familles);
      const limit = coerceNumber(args.limit, "limit");
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
    description: `Liste des établissements FINESS par famille, avec filtre département ou commune optionnel. Pas de rayon — pour énumération exhaustive d'une zone administrative. 24 familles disponibles : ${FAMILLES_LIST}. Source : FINESS / DREES. Note : champ \`email\` toujours \`null\` (non exposé par FINESS public).`,
    inputSchema: {
      type: "object",
      properties: {
        categorie: {
          type: "string",
          description: "Famille FINESS recherchée (24 valeurs disponibles, voir enum).",
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
      const limit = coerceNumber(args.limit, "limit");
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
      "Récupère le détail complet d'un établissement de santé par son numéro FINESS (9 chiffres) : raison sociale, catégorie + famille, adresse complète (voie + CP + ville + code INSEE + département), coordonnées GPS, téléphone. Retourne un objet `LookupResult` discriminé par `found`. `found: true` → champs FINESS à plat. `found: false` → `{ found: false, key, lookupStatus: 'not_found', message }`. Le référentiel DREES a 1-2 mois de retard sur le terrain : pour des structures émergentes (CPTS récentes, MSP en agrément), cross-check ARS / Service Public. Source : FINESS / DREES. Note : champ `email` toujours `null` (non exposé par FINESS public).",
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
    description: `Recherche de professionnels de santé libéraux conventionnés dans un rayon géographique. Précision géo : centroïde commune (~3 km en moyenne — adapté à l'analyse de densité, pas au géocodage adresse). ${AMELI_TYPE_PS_HELP} Pour cibler une profession précise (ex: IDE seuls, kinés seuls, podologues seuls), passer par \`specialite_codes\` plutôt que \`type_ps_codes\` qui ratisse plus large. Liste exhaustive des codes spécialité disponibles via le tool \`lister_specialites_ameli\`. Multi-sites : par défaut un PS exerçant sur N adresses apparaît N fois — utiliser \`dedupe_by_ps=true\` pour regrouper par praticien et lister les sites en sous-objet. Distance retournée en km vol d'oiseau (haversine PostGIS) — pour distance routière, croiser avec un service externe (OSRM, ORS). ${AMELI_SCOPE_WARNING} ${AMELI_CGU}`,
    inputSchema: {
      type: "object",
      properties: {
        lon: { type: "number", description: "Longitude du centre (WGS84)." },
        lat: { type: "number", description: "Latitude du centre (WGS84)." },
        radius_km: {
          type: "number",
          description: "Rayon en km (0.1-50, défaut 5).",
          minimum: RADIUS_MIN_KM,
          maximum: RADIUS_MAX_KM,
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
            "Liste de codes type PS Ameli (3 valeurs présentes en base : '1' médecins, '2' auxiliaires médicaux fourre-tout — IDE/kinés/sages-femmes/podologues/orthophonistes/orthoptistes/IPA, '5' chirurgiens-dentistes). Pour cibler une seule profession, préférer `specialite_codes`. Si omis, tous types.",
          items: { type: "string" },
        },
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-500, défaut 100). Appliqué AVANT déduplication.",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
        dedupe_by_ps: {
          type: "boolean",
          description:
            "Regrouper les entrées par praticien (nom + prénom + code spécialité) et lister chaque adresse d'exercice dans `sites[]`. Défaut false (comportement V0.4 historique : un PS multi-sites = N entrées).",
          default: false,
        },
      },
      required: ["lon", "lat"],
    },
    handler: async (args) => {
      const lon = coerceNumber(args.lon, "lon");
      const lat = coerceNumber(args.lat, "lat");
      if (lon === undefined || lat === undefined) {
        throw new Error("lon et lat (number) requis");
      }
      const radiusKm = coerceNumber(args.radius_km, "radius_km") ?? 5;
      // Bornes radius validées au DB layer (cf. ameli-db.ts) — source unique.
      const specialiteCodes = parseStringArray(args.specialite_codes, "specialite_codes");
      const typePsCodes = parseStringArray(args.type_ps_codes, "type_ps_codes");
      const limit = coerceNumber(args.limit, "limit");
      const dedupe = coerceBoolean(args.dedupe_by_ps, "dedupe_by_ps") === true;
      const input: Parameters<typeof getAmeliInRadius>[0] = {
        center: { lon, lat },
        radiusKm,
      };
      if (specialiteCodes) input.specialiteCodes = specialiteCodes;
      if (typePsCodes) input.typePsCodes = typePsCodes;
      if (limit !== undefined) input.limit = limit;
      const result = await getAmeliInRadius(input);
      return dedupe ? dedupeAmeliByPs(result) : result;
    },
  },
  {
    name: "professionnels_par_specialite_dept",
    description: `Liste des professionnels de santé libéraux conventionnés d'un département, avec filtres optionnels par spécialité ou type de PS. Pour énumération administrative — pas de rayon. ${AMELI_TYPE_PS_HELP} Pour cibler une profession précise (ex: IDE seuls), passer par \`specialite_code\` plutôt que \`type_ps_code\` qui ratisse plus large. Liste exhaustive des codes spécialité disponibles via le tool \`lister_specialites_ameli\`. Pagination : utiliser \`offset\` pour récupérer les pages suivantes quand \`truncated=true\`. Multi-sites : utiliser \`dedupe_by_ps=true\` pour regrouper par praticien. ${AMELI_SCOPE_WARNING} ${AMELI_CGU}`,
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
          description:
            "Code spécialité Ameli (ex: '01' MG, '24' IDE, '26' kiné, '03' cardio). Optionnel. Liste complète via `lister_specialites_ameli`.",
        },
        type_ps_code: {
          type: "string",
          description:
            "Code type PS Ameli ('1' médecins, '2' auxiliaires médicaux, '5' chirurgiens-dentistes). Optionnel — préférer `specialite_code` pour un ciblage précis. Liste complète via `lister_types_ps_ameli`.",
        },
        limit: {
          type: "number",
          description: "Nombre max de résultats (1-500, défaut 100). Appliqué AVANT déduplication.",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
        offset: {
          type: "number",
          description:
            "Décalage de pagination (≥ 0, défaut 0). Combiner avec `limit` pour énumérer un département à fort effectif. Re-paginer tant que `truncated=true`.",
          minimum: 0,
          default: 0,
        },
        dedupe_by_ps: {
          type: "boolean",
          description:
            "Regrouper les entrées par praticien (nom + prénom + code spécialité) et lister chaque adresse d'exercice dans `sites[]`. Défaut false.",
          default: false,
        },
      },
      required: ["departement"],
    },
    handler: async (args) => {
      const departement = asString(args.departement);
      if (!departement) throw new Error("departement (string) requis");
      const specialiteCode = asString(args.specialite_code);
      const typePsCode = asString(args.type_ps_code);
      const limit = coerceNumber(args.limit, "limit");
      const offset = coerceNumber(args.offset, "offset");
      const dedupe = coerceBoolean(args.dedupe_by_ps, "dedupe_by_ps") === true;
      const input: Parameters<typeof getAmeliBySpecialiteDept>[0] = { departement };
      if (specialiteCode) input.specialiteCode = specialiteCode;
      if (typePsCode) input.typePsCode = typePsCode;
      if (limit !== undefined) input.limit = limit;
      if (offset !== undefined) input.offset = offset;
      const result = await getAmeliBySpecialiteDept(input);
      return dedupe ? dedupeAmeliByPs(result) : result;
    },
  },
  {
    name: "lister_specialites_ameli",
    description: `Liste les codes spécialité Ameli effectivement présents en base, avec leur libellé natif, leur \`type_ps_code\` de rattachement et leur count. Triés par fréquence décroissante. Utile pour découvrir la nomenclature avant de filtrer un \`professionnels_in_radius\` ou \`professionnels_par_specialite_dept\`. Le champ \`libelle_clarifie\` désambigüise les libellés partagés par plusieurs codes (ex: "Médecin généraliste" regroupe les codes 01/22/23, "Chirurgien-dentiste" 19/53/54, "Psychiatre" 33/75, "Gynécologue / Obstétricien" 07/70/77/79). Format quand partagé : \`'{libelle} (code {code}, {count_compact})'\` (ex: "Médecin généraliste (code 01, 55K)"). Sinon identique à \`libelle\`. \`is_libelle_partage: true\` quand au moins 2 codes utilisent le même libellé — utiliser ce flag côté caller pour décider d'afficher le code à l'utilisateur. ${AMELI_SCOPE_WARNING} ${AMELI_CGU}`,
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      const specialites = await listAmeliSpecialites();
      return { count: specialites.length, results: specialites };
    },
  },
  {
    name: "lister_types_ps_ameli",
    description: `Liste les codes \`type_ps\` Ameli présents en base, avec leur libellé natif (\`libelle_source\`), un libellé clarifié (\`libelle_clarifie\`) résolvant l'ambiguïté du code "2" fourre-tout, leur count total, et \`specialites_presentes\` (la liste effective des spécialités regroupées sous chaque type_ps avec leurs counts). Pas de dictionnaire inventé : la clarification est dérivée de la donnée live à chaque appel. ${AMELI_SCOPE_WARNING} ${AMELI_CGU}`,
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      const typesPs = await listAmeliTypesPs();
      return { count: typesPs.length, results: typesPs };
    },
  },
];

export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((t) => t.name === name);
}
