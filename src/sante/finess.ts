/**
 * FINESS — Fichier National des Établissements Sanitaires et Médico-Sociaux.
 *
 * Source : data.gouv.fr → dump CSV bimestriel ~35 Mo (`finess-extraction-du-fichier-des-etablissements`).
 * Variante géolocalisée : Atlasanté `referentiel-finess-t-finess` (~232 Mo).
 *
 * ⚠️ Migration ANS été 2026 : tous les datasets data.gouv portent l'avertissement
 * que la génération du flux actuel s'arrêtera. Surveiller le repo
 * github.com/ansforge/finess pour le nouveau format (probablement FHIR-compatible).
 *
 * Cette fonction télécharge le CSV avec cache 7j puis charge en mémoire (~35 Mo
 * → ~70 Mo de RAM résidente Node). Adapté à un usage CLI ou serveur node long.
 * Pour un usage serverless (Vercel Edge), ne pas charger l'intégralité —
 * préférer une DB externe (PostGIS, DuckDB).
 */

import { readFile } from "node:fs/promises";
import { type CacheOptions, downloadWithCache } from "../core/cache.js";
import { parseCoordinates } from "../core/coords.js";
import { parseCsv } from "../core/csv.js";
import { pickDefined } from "../core/object-utils.js";
import type { Coordinates } from "../core/types.js";
import { libelleCategorieFiness } from "./finess-categories.js";

const FINESS_CSV_URL =
  "https://www.data.gouv.fr/api/1/datasets/r/3dc9b1d5-0157-440d-a7b5-c894fcfdfd45";
const FINESS_CACHE_FILE = "finess-etablissements.csv";

export type EtablissementFiness = {
  /** Numéro FINESS de l'entité géographique (ET) sur 9 chiffres */
  finessEt: string;
  /** Numéro FINESS de l'entité juridique (EJ) à laquelle l'ET est rattaché */
  finessEj?: string;
  /** Raison sociale (longue, plus complète que le nom court) */
  raisonSociale: string;
  /** Code de catégorie d'établissement (ex: "500" pour EHPAD) */
  categorieCode?: string;
  /** Libellé de la catégorie (mappé depuis FINESS_CATEGORIES si reconnu) */
  categorieLibelle?: string;
  /** Adresse ligne complète */
  adresse?: string;
  /** Code postal */
  codePostal?: string;
  /** Commune */
  commune?: string;
  /** Code INSEE de la commune (5 caractères) */
  codeCommune?: string;
  /** Code département (2 ou 3 caractères) */
  departement?: string;
  /** Coordonnées GPS (présentes dans le dump géolocalisé Atlasanté) */
  point?: Coordinates;
  /** Téléphone */
  telephone?: string;
  /** SIREN si renseigné */
  siren?: string;
};

export type LoadFinessOptions = CacheOptions & {
  /**
   * Chemin local d'un CSV déjà téléchargé (court-circuite le download).
   *
   * @security Cette option fait un `readFile` direct du chemin fourni. Ne
   * JAMAIS la forwarder depuis une entrée non-trustée (requête HTTP, args MCP) :
   * c'est un read fichier local non restreint. Strictement réservé à un usage
   * Node.js trusted.
   */
  csvPath?: string;
};

export type SearchFinessOptions = {
  /** Filtre par codes de catégorie (ex: ["500"] pour EHPAD seuls) */
  categories?: string[];
  /** Filtre par code postal exact */
  codePostal?: string;
  /** Filtre par code département */
  departement?: string;
  /** Filtre par code commune INSEE */
  codeCommune?: string;
  /** Recherche géographique : centre + rayon en km (nécessite dump géolocalisé) */
  center?: Coordinates;
  /** Rayon en km */
  radiusKm?: number;
  /** Limite de résultats (défaut tous) */
  limit?: number;
};

/**
 * Charge l'index FINESS en mémoire. Télécharge le CSV si pas en cache.
 * Le résultat est utilisable plusieurs fois sans re-charger.
 */
export async function loadFiness(options: LoadFinessOptions = {}): Promise<EtablissementFiness[]> {
  const csvPath =
    options.csvPath ?? (await downloadWithCache(FINESS_CSV_URL, FINESS_CACHE_FILE, options));

  const content = await readFile(csvPath, "utf-8");
  const rows = parseCsv(content, { delimiter: ";" });

  // Une seule passe pour mapper + filtrer les lignes invalides : évite
  // d'allouer un tableau intermédiaire de ~120k éléments pour FINESS.
  const ets: EtablissementFiness[] = [];
  for (const row of rows) {
    const e = toEtablissementFiness(row);
    if (e !== null) ets.push(e);
  }

  // Si plus de 5% des lignes sont droppées (champ FINESS_ET manquant), c'est
  // probablement une migration de schéma upstream (annoncée par l'ANS pour
  // l'été 2026). Le silence serait dangereux : `searchEtablissementsFiness`
  // renverrait `[]` sans alerte alors que l'index est cassé.
  const total = rows.length;
  if (total > 100) {
    const dropRate = (total - ets.length) / total;
    if (dropRate > 0.05) {
      console.error(
        `[france-data-mcp] FINESS: ${total - ets.length}/${total} lignes invalides (${(dropRate * 100).toFixed(1)}%). Schéma CSV probablement changé. Colonnes attendues: nofinesset, rs, categetab, cpostal, commune. Migration ANS prévue été 2026 — vérifier github.com/ansforge/finess et https://www.data.gouv.fr/datasets/finess-extraction-du-fichier-des-etablissements-sanitaires-et-sociaux/`,
      );
    }
  }

  return ets;
}

/**
 * Recherche des établissements dans un index FINESS pré-chargé.
 * Pour avoir l'index : `const index = await loadFiness();`
 */
export function searchEtablissementsFiness(
  index: EtablissementFiness[],
  options: SearchFinessOptions,
): EtablissementFiness[] {
  const { categories, codePostal, departement, codeCommune, center, radiusKm, limit } = options;

  if (center && (radiusKm === undefined || radiusKm <= 0)) {
    throw new RangeError("searchEtablissementsFiness: radiusKm > 0 requis quand center est fourni");
  }

  const radiusMeters = center && radiusKm !== undefined ? radiusKm * 1000 : null;
  const categoriesSet = categories ? new Set(categories) : null;

  const matches: EtablissementFiness[] = [];
  for (const e of index) {
    if (categoriesSet && (!e.categorieCode || !categoriesSet.has(e.categorieCode))) continue;
    if (codePostal && e.codePostal !== codePostal) continue;
    if (departement && e.departement !== departement) continue;
    if (codeCommune && e.codeCommune !== codeCommune) continue;
    if (center && radiusMeters !== null) {
      if (!e.point) continue;
      if (haversineDistance(center, e.point) > radiusMeters) continue;
    }
    matches.push(e);
    if (limit !== undefined && matches.length >= limit) break;
  }

  return matches;
}

/**
 * Distance Haversine entre deux points GPS, en mètres.
 * Formule sphérique standard (suffisante pour les rayons < 100 km).
 */
export function haversineDistance(a: Coordinates, b: Coordinates): number {
  const R = 6_371_000;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const deltaLat = toRad(b.lat - a.lat);
  const deltaLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Mapping des colonnes du CSV FINESS vers le type interne.
 * Le CSV data.gouv.fr utilise les en-têtes suivants (varie légèrement selon
 * l'export, on est défensif sur les noms alternatifs).
 */
function toEtablissementFiness(row: Record<string, string>): EtablissementFiness | null {
  const finessEt = row.nofinesset ?? row["FINESS ET"] ?? row.finesset;
  if (!finessEt) return null;

  const categorieCode = row.categetab ?? row.categagretab ?? row.libcategetab;
  const categorieLibelle = categorieCode
    ? (libelleCategorieFiness(categorieCode) ?? row.libcategetab)
    : undefined;

  const adresseParts = [row.numvoie, row.typvoie, row.voie, row.compvoie].filter(Boolean);
  const adresse = adresseParts.length > 0 ? adresseParts.join(" ").trim() : row.adresse;

  const point = parseCoordinates(row.coordxet ?? row.longitude, row.coordyet ?? row.latitude);

  return {
    finessEt,
    raisonSociale: row.rs ?? row.raisonsociale ?? row["Raison sociale"] ?? row.rslongue ?? "",
    ...pickDefined({
      finessEj: row.nofinessej ?? row["FINESS EJ"] ?? row.finessej,
      categorieCode,
      categorieLibelle,
      adresse,
      codePostal: row.cpostal ?? row.codepostal,
      commune: row.commune ?? row.libcommune,
      codeCommune: row.codecommune ?? row.codinsee,
      departement: row.departement ?? row.codedepartement,
      telephone: row.telephone ?? row.tel,
      siren: row.siren,
    }),
    ...(point ? { point } : {}),
  };
}
