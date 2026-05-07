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
import { fetchJson } from "../core/http.js";
import { clamp } from "../core/numbers.js";
import { pickDefined } from "../core/object-utils.js";
import type { Coordinates } from "../core/types.js";

const BASE_URL = "https://recherche-entreprises.api.gouv.fr/search";

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
};

export type Dirigeant = {
  nom?: string;
  prenoms?: string;
  fonction?: string;
  qualite?: string;
};

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
   * le département du siège (couvre la majorité des cas pour les multi-sites).
   * Voir `nombreEtablissements` / `nombreEtablissementsOuverts` pour le total
   * réel côté SIRENE.
   */
  etablissements: Etablissement[];
  /** Nombre total d'établissements (actifs + fermés), source SIRENE */
  nombreEtablissements?: number;
  /** Nombre d'établissements actuellement ouverts, source SIRENE */
  nombreEtablissementsOuverts?: number;
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
  latitude?: string | number;
  longitude?: string | number;
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
    throw new Error(
      "searchEntreprises: au moins un critère est requis (q, naf, codePostal, departement, codeCommune ou center+radiusKm)",
    );
  }

  if (center && (radiusKm === undefined || radiusKm <= 0)) {
    throw new Error("searchEntreprises: radiusKm > 0 requis quand center est fourni");
  }

  // L'API DINUM exige que `lat/long/radius` soient accompagnés d'un `q` (recherche
  // textuelle). On ne peut pas combiner `activite_principale` + lat/long/radius
  // directement. Si le caller fournit center+radiusKm sans q, on en injecte un
  // par défaut via le NAF si présent, sinon on signale l'incompatibilité.
  if (center && !q) {
    if (naf) {
      throw new Error(
        "searchEntreprises: l'API DINUM n'accepte pas `naf` + `center+radiusKm` directement. " +
          "Options : (1) `q='<terme>'` + center+radiusKm (recherche textuelle géolocalisée), " +
          "(2) `naf` + `codePostal`/`departement`/`codeCommune` (filtrage administratif), " +
          "(3) faire un reverseGeocode du center pour obtenir codeCommune puis filtrer.",
      );
    }
    throw new Error(
      "searchEntreprises: `center+radiusKm` requiert un paramètre `q` (recherche textuelle). " +
        "L'API DINUM ne supporte pas la recherche géographique pure.",
    );
  }

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (naf) params.set("activite_principale", normalizeNafCode(naf));
  if (codePostal) params.set("code_postal", codePostal);
  if (departement) params.set("departement", departement);
  if (codeCommune) params.set("code_commune", codeCommune);
  if (center && radiusKm !== undefined) {
    params.set("lat", String(center.lat));
    params.set("long", String(center.lon));
    params.set("radius", String(Math.min(radiusKm, 50)));
  }
  if (onlyActive) params.set("etat_administratif", "A");
  params.set("page", String(Math.max(1, page)));
  params.set("per_page", String(clamp(perPage, 1, 25)));

  const url = `${BASE_URL}?${params.toString()}`;
  const data = await fetchJson<ApiResponse>(url, { signal });

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
 */
export async function getEntrepriseBySiren(
  siren: string,
  signal?: AbortSignal,
): Promise<Entreprise | null> {
  if (!/^\d{9}$/.test(siren)) {
    throw new Error(`getEntrepriseBySiren: SIREN invalide "${siren}" (attendu 9 chiffres)`);
  }
  const result = await searchEntreprises({ q: siren, perPage: 5, onlyActive: false, signal });
  const match = result.entreprises.find((e) => e.siren === siren);
  if (!match && result.entreprises.length > 0) {
    console.warn(
      `[france-data-mcp] getEntrepriseBySiren(${siren}): l'API a renvoyé ${result.entreprises.length} résultat(s) sans match exact du SIREN.`,
    );
  }
  if (!match) return null;

  // Second appel pour récupérer les établissements supplémentaires : l'API
  // DINUM ne les expose dans `matching_etablissements` que quand on filtre par
  // NAF + département. On filtre ensuite par SIREN côté client.
  const naf = match.naf;
  const siegePostalCode = match.etablissements[0]?.codePostal;
  const departement = siegePostalCode?.slice(0, 2);
  if (naf && departement && (match.nombreEtablissements ?? 0) > 1) {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[france-data-mcp] getEntrepriseBySiren(${siren}): échec enrichissement établissements (${msg}). Résultat limité au siège.`,
      );
    }
  }

  return match;
}

/**
 * Normalise un code NAF vers le format attendu par l'API DINUM (`XX.XXY`).
 *
 * L'API DINUM rejette les codes en format INSEE compact (`8690B`) avec un
 * HTTP 400 et la liste des valeurs valides. La nomenclature officielle utilise
 * des points (`86.90B`), donc on accepte les deux entrées et on convertit.
 *
 * On exige la lettre finale (`[A-Z]`) parce que les codes NAF sans lettre
 * (ex: `"8690"`) ne correspondent à aucune sous-classe valide — laisser passer
 * un tel code en le réécrivant `"86.90"` produirait toujours un 400, sans gain.
 */
function normalizeNafCode(naf: string): string {
  // Déjà au format pointé : "86.90B"
  if (/^\d{2}\.\d{2}[A-Z]$/.test(naf)) return naf;
  // Format compact : "8690B" → "86.90B"
  if (/^\d{4}[A-Z]$/.test(naf)) return `${naf.slice(0, 2)}.${naf.slice(2)}`;
  // Format inconnu : on laisse passer, l'API renverra une erreur claire
  return naf;
}

function toEntreprise(api: ApiEntreprise): Entreprise {
  const finances: Finance[] = [];
  if (api.finances) {
    for (const [year, fin] of Object.entries(api.finances)) {
      const annee = Number.parseInt(year, 10);
      if (Number.isFinite(annee)) {
        const f: Finance = { annee };
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
