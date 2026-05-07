/**
 * Définition des outils MCP exposés par le serveur france-data-mcp.
 *
 * Stratégie V0 : on n'expose que les outils utilisables sans dump local
 * (territoire + DINUM live). FINESS et Annuaire Santé Ameli demandent un cache
 * local volumineux (~35 Mo et ~146 Mo) → ils sont disponibles dans la lib npm
 * mais pas exposés dans le serveur MCP V0 sur Vercel serverless.
 */

import { getEntrepriseBySiren, searchEntreprises } from "../src/sante/index.js";
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
      if (typeof args.nom === "string") opts.nom = args.nom;
      if (typeof args.codePostal === "string") opts.codePostal = args.codePostal;
      if (typeof args.code === "string") opts.code = args.code;
      if (typeof args.limit === "number") opts.limit = args.limit;
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
      if (typeof args.adresse !== "string") throw new Error("adresse (string) requise");
      const opts: Parameters<typeof geocode>[1] = {};
      if (typeof args.codePostal === "string") opts.codePostal = args.codePostal;
      if (typeof args.codeCommune === "string") opts.codeCommune = args.codeCommune;
      return geocode(args.adresse, opts);
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
      "Recherche d'entreprises françaises dans un rayon géographique, avec filtres NAF, code postal et département. Couvre tous secteurs (santé via NAF 8690B, 4773Z, 8710A, 8621Z, etc.). Source : DINUM Recherche Entreprises (SIRENE + RNE). Renvoie CA, dirigeants, tranches d'effectif et dates de création.",
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
      const opts: Parameters<typeof searchEntreprises>[0] = {};
      if (typeof args.naf === "string") opts.naf = args.naf;
      if (typeof args.q === "string") opts.q = args.q;
      if (typeof args.codePostal === "string") opts.codePostal = args.codePostal;
      if (typeof args.departement === "string") opts.departement = args.departement;
      if (typeof args.perPage === "number") opts.perPage = args.perPage;
      if (typeof args.page === "number") opts.page = args.page;
      const lon = typeof args.lon === "number" ? args.lon : Number.NaN;
      const lat = typeof args.lat === "number" ? args.lat : Number.NaN;
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        opts.center = { lon, lat };
        if (typeof args.radiusKm === "number") opts.radiusKm = args.radiusKm;
      }
      return searchEntreprises(opts);
    },
  },
  {
    name: "entreprise_by_siren",
    description:
      "Récupère le détail d'une entreprise française par son SIREN (9 chiffres) : raison sociale, NAF, finances historiques, dirigeants, établissements. Source : DINUM Recherche Entreprises.",
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
];

export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((t) => t.name === name);
}
