/**
 * Annuaire Santé Ameli — répertoire des professionnels de santé libéraux conventionnés.
 *
 * Source : data.gouv.fr `annuaire-sante-ameli` (CSV ~146 Mo, ~1,5M lignes).
 * MAJ hebdomadaire (régénération chaque dimanche/lundi).
 *
 * ⚠️ Article L.1461-2 CSP : ces données contiennent des informations à
 * caractère personnel. Leur réutilisation est soumise au respect de la
 * réglementation relative à la protection de la vie privée. Toute application
 * publique doit afficher la mention "Source : Annuaire santé Ameli, Assurance
 * Maladie" et la date de la dernière sync.
 *
 * Volume : 146 Mo → trop pour charger en mémoire intégralement. Cette lib
 * propose un parser **streaming** : on lit le CSV ligne par ligne et on filtre
 * à la volée. Pour faire de la recherche par rayon géographique, il faut au
 * préalable géocoder les adresses (à faire côté caller, pas géré ici).
 */

import { createReadStream } from "node:fs";
import { type CacheOptions, downloadWithCache } from "../core/cache.js";
import { streamCsvLines } from "../core/csv.js";

const ANNUAIRE_AMELI_CSV_URL =
  "https://www.data.gouv.fr/api/1/datasets/r/3a700a1c-3079-4f7f-9bd7-83611e3f5e35";
const ANNUAIRE_AMELI_CACHE_FILE = "annuaire-sante-ameli-ps.csv";

export type ProfessionnelSante = {
  /** Nom de famille (en exercice) */
  nom: string;
  /** Prénom(s) (en exercice) */
  prenom: string;
  /** Civilité (Dr, Mme, M.…) */
  civilite?: string;
  /** Raison sociale du lieu d'exercice si applicable */
  raisonSociale?: string;
  /** Code spécialité Ameli */
  specialiteCode?: string;
  /** Libellé de la spécialité (ex: "Médecin généraliste", "Cardiologue") */
  specialiteLibelle?: string;
  /** Code type de PS (médecin, IDE, sage-femme, pharmacien…) */
  typePsCode?: string;
  /** Libellé du type de PS */
  typePsLibelle?: string;
  /** Voie + numéro */
  adresse?: string;
  /** Complément d'adresse (étage, bâtiment…) */
  complementAdresse?: string;
  /** Code postal du lieu d'exercice */
  codePostal?: string;
  /** Commune du lieu d'exercice */
  commune?: string;
  /** Téléphone */
  telephone?: string;
  /** Secteur conventionnel (1, 2, 3, NC…) */
  secteurConventionnel?: string;
  /** Libellé du secteur conventionnel */
  secteurConventionnelLibelle?: string;
  /** Mode d'exercice (libéral, salarié, mixte…) */
  natureExercice?: string;
};

export type StreamAnnuaireOptions = CacheOptions & {
  /** Chemin local d'un CSV déjà téléchargé (court-circuite le download) */
  csvPath?: string;
};

export type FilterAnnuaireOptions = {
  /** Filtre exact par code postal */
  codePostal?: string;
  /** Filtre par préfixe de code postal (ex: "08" pour tout le département 08) */
  codePostalPrefix?: string;
  /** Filtre par nom de commune (insensible à la casse) */
  commune?: string;
  /** Filtre par libellé de spécialité (insensible à la casse, contient) */
  specialite?: string;
  /** Filtre par code spécialité exact */
  specialiteCode?: string;
  /** Filtre par type de PS (Médecin, IDE, etc., insensible à la casse) */
  typePs?: string;
  /** Filtre par secteur conventionnel ("1", "2"…) */
  secteurConventionnel?: string;
  /** Limite (arrête le stream une fois atteinte) */
  limit?: number;
};

/**
 * S'assure que le CSV Annuaire Ameli est en cache local et renvoie son chemin.
 * Télécharge si nécessaire (~146 Mo, ~30 secondes en bonne connexion).
 */
export async function ensureAnnuaireAmeli(options: StreamAnnuaireOptions = {}): Promise<string> {
  if (options.csvPath) return options.csvPath;
  return downloadWithCache(ANNUAIRE_AMELI_CSV_URL, ANNUAIRE_AMELI_CACHE_FILE, options);
}

/**
 * Stream les professionnels de santé un par un, avec filtres optionnels.
 * Utilise un parser CSV streaming pour ne pas charger les 146 Mo en mémoire.
 *
 * @example Tous les MG du 08
 * ```ts
 * for await (const ps of streamProfessionnels({ codePostalPrefix: "08", specialite: "généraliste" })) {
 *   console.log(`${ps.nom} ${ps.prenom} - ${ps.commune}`);
 * }
 * ```
 */
export async function* streamProfessionnels(
  options: StreamAnnuaireOptions & FilterAnnuaireOptions = {},
): AsyncGenerator<ProfessionnelSante> {
  const csvPath = await ensureAnnuaireAmeli(options);

  const fileStream = createReadStream(csvPath, { encoding: "utf-8" });
  const stringStream = nodeReadableToAsyncIterable(fileStream);

  const {
    codePostal,
    codePostalPrefix,
    commune,
    specialite,
    specialiteCode,
    typePs,
    secteurConventionnel,
    limit,
  } = options;

  const specialiteLower = specialite?.toLowerCase();
  const communeLower = commune?.toLowerCase();
  const typePsLower = typePs?.toLowerCase();
  let yielded = 0;

  for await (const row of streamCsvLines(stringStream, { delimiter: ";" })) {
    const ps = toProfessionnelSante(row);
    if (!ps) continue;

    if (codePostal && ps.codePostal !== codePostal) continue;
    if (codePostalPrefix && (!ps.codePostal || !ps.codePostal.startsWith(codePostalPrefix)))
      continue;
    if (communeLower && (!ps.commune || !ps.commune.toLowerCase().includes(communeLower))) continue;
    if (
      specialiteLower &&
      (!ps.specialiteLibelle || !ps.specialiteLibelle.toLowerCase().includes(specialiteLower))
    )
      continue;
    if (specialiteCode && ps.specialiteCode !== specialiteCode) continue;
    if (typePsLower && (!ps.typePsLibelle || !ps.typePsLibelle.toLowerCase().includes(typePsLower)))
      continue;
    if (secteurConventionnel && ps.secteurConventionnel !== secteurConventionnel) continue;

    yield ps;
    yielded++;
    if (limit !== undefined && yielded >= limit) return;
  }
}

/**
 * Charge un sous-ensemble filtré en mémoire (pratique pour les zones géographiques
 * étroites — un département entier reste raisonnable).
 */
export async function loadProfessionnels(
  options: StreamAnnuaireOptions & FilterAnnuaireOptions = {},
): Promise<ProfessionnelSante[]> {
  const result: ProfessionnelSante[] = [];
  for await (const ps of streamProfessionnels(options)) {
    result.push(ps);
  }
  return result;
}

async function* nodeReadableToAsyncIterable(
  readable: NodeJS.ReadableStream,
): AsyncGenerator<string> {
  for await (const chunk of readable) {
    yield typeof chunk === "string" ? chunk : chunk.toString("utf-8");
  }
}

function toProfessionnelSante(row: Record<string, string>): ProfessionnelSante | null {
  const nom = row.ps_activite_nom ?? "";
  const prenom = row.ps_activite_prenom ?? "";
  if (!nom && !prenom) return null;

  const ps: ProfessionnelSante = { nom, prenom };

  const civilite = row.ps_activite_civilite;
  if (civilite) ps.civilite = civilite;

  const raisonSociale = row.ps_activite_raison_sociale;
  if (raisonSociale) ps.raisonSociale = raisonSociale;

  const specialiteCode = row.specialite_code;
  if (specialiteCode) ps.specialiteCode = specialiteCode;
  const specialiteLibelle = row.specialite_libelle;
  if (specialiteLibelle) ps.specialiteLibelle = specialiteLibelle;

  const typePsCode = row.type_ps_code;
  if (typePsCode) ps.typePsCode = typePsCode;
  const typePsLibelle = row.type_ps_libelle;
  if (typePsLibelle) ps.typePsLibelle = typePsLibelle;

  const adresseParts = [
    row.coordonnees_num_tel ? "" : row.coordonnees_voie,
    row.coordonnees_voie,
  ].filter(Boolean);
  if (row.coordonnees_voie) ps.adresse = row.coordonnees_voie;
  else if (adresseParts.length > 0) ps.adresse = adresseParts.join(" ");

  const complement = row.coordonnees_complement ?? row.coordonnees_lieu_dit;
  if (complement) ps.complementAdresse = complement;

  const codePostal = row.coordonnees_code_postal;
  if (codePostal) ps.codePostal = codePostal;

  const commune = row.coordonnees_ville;
  if (commune) ps.commune = commune;

  const tel = row.coordonnees_num_tel;
  if (tel) ps.telephone = tel;

  const sectCode = row.secteur_conventionnel_code;
  if (sectCode) ps.secteurConventionnel = sectCode;
  const sectLib = row.secteur_conventionnel_libelle;
  if (sectLib) ps.secteurConventionnelLibelle = sectLib;

  const nature = row.nature_exercice_libelle ?? row.nature_exercice_code;
  if (nature) ps.natureExercice = nature;

  return ps;
}
