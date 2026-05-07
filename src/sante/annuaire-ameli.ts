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
import { pickDefined } from "../core/object-utils.js";

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
  /**
   * Chemin local d'un CSV déjà téléchargé (court-circuite le download).
   *
   * @security Cette option ouvre un `createReadStream` direct sur le chemin
   * fourni. Ne JAMAIS la forwarder depuis une entrée non-trustée (requête
   * HTTP, args MCP) : c'est une lecture fichier local non restreinte qui peut
   * exposer des fichiers sensibles. Strictement réservé à un usage Node.js
   * trusted (CLI, script, code applicatif).
   */
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
 * const out: string[] = [];
 * for await (const ps of streamProfessionnels({ codePostalPrefix: "08", specialite: "généraliste" })) {
 *   out.push(`${ps.nom} ${ps.prenom} - ${ps.commune}`);
 * }
 * ```
 */
export async function* streamProfessionnels(
  options: StreamAnnuaireOptions & FilterAnnuaireOptions = {},
): AsyncGenerator<ProfessionnelSante> {
  const csvPath = await ensureAnnuaireAmeli(options);

  const fileStream = createReadStream(csvPath, { encoding: "utf-8" });

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
  let parsed = 0;
  let skipped = 0;

  try {
    const stringStream = nodeReadableToAsyncIterable(fileStream);
    for await (const row of streamCsvLines(stringStream, { delimiter: ";" })) {
      parsed++;
      const ps = toProfessionnelSante(row);
      if (!ps) {
        skipped++;
        continue;
      }

      if (codePostal && ps.codePostal !== codePostal) continue;
      if (codePostalPrefix && (!ps.codePostal || !ps.codePostal.startsWith(codePostalPrefix)))
        continue;
      if (communeLower && (!ps.commune || !ps.commune.toLowerCase().includes(communeLower)))
        continue;
      if (
        specialiteLower &&
        (!ps.specialiteLibelle || !ps.specialiteLibelle.toLowerCase().includes(specialiteLower))
      )
        continue;
      if (specialiteCode && ps.specialiteCode !== specialiteCode) continue;
      if (
        typePsLower &&
        (!ps.typePsLibelle || !ps.typePsLibelle.toLowerCase().includes(typePsLower))
      )
        continue;
      if (secteurConventionnel && ps.secteurConventionnel !== secteurConventionnel) continue;

      yield ps;
      yielded++;
      if (limit !== undefined && yielded >= limit) return;
    }
  } finally {
    // Détruit explicitement le stream pour libérer le file descriptor même si
    // le caller fait `break` ou `return` au milieu (cas typique avec `limit`).
    fileStream.destroy();
    // Si plus de 10% des lignes parsées sont invalides, c'est probablement un
    // changement de schéma upstream (Ameli renomme une colonne, format CSV
    // qui évolue). Le skip silencieux serait dangereux : un caller pourrait
    // recevoir 0 résultat alors que le fichier en contient des milliers.
    if (parsed > 100 && skipped > parsed * 0.1) {
      console.warn(
        `[france-data-mcp] annuaire-ameli: ${skipped}/${parsed} lignes invalides (${((skipped / parsed) * 100).toFixed(1)}%). Schéma CSV peut-être changé. Colonnes attendues: ps_activite_nom, ps_activite_prenom, specialite_libelle, coordonnees_code_postal, coordonnees_ville. Vérifier https://www.data.gouv.fr/datasets/annuaire-sante-ameli/`,
      );
    }
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
  try {
    for await (const chunk of readable) {
      yield typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    }
  } finally {
    if ("destroy" in readable && typeof readable.destroy === "function") {
      readable.destroy();
    }
  }
}

function toProfessionnelSante(row: Record<string, string>): ProfessionnelSante | null {
  const nom = row.ps_activite_nom ?? "";
  const prenom = row.ps_activite_prenom ?? "";
  if (!nom && !prenom) return null;

  return {
    nom,
    prenom,
    ...pickDefined({
      civilite: row.ps_activite_civilite,
      raisonSociale: row.ps_activite_raison_sociale,
      specialiteCode: row.specialite_code,
      specialiteLibelle: row.specialite_libelle,
      typePsCode: row.type_ps_code,
      typePsLibelle: row.type_ps_libelle,
      adresse: row.coordonnees_voie,
      complementAdresse: row.coordonnees_complement || row.coordonnees_lieu_dit,
      codePostal: row.coordonnees_code_postal,
      commune: row.coordonnees_ville,
      telephone: row.coordonnees_num_tel,
      secteurConventionnel: row.secteur_conventionnel_code,
      secteurConventionnelLibelle: row.secteur_conventionnel_libelle,
      natureExercice: row.nature_exercice_libelle || row.nature_exercice_code,
    }),
  };
}
