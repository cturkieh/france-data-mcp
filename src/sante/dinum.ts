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

import { fetchJson } from "../core/http.js";
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
  /** Établissements actifs et inactifs */
  etablissements: Etablissement[];
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
  /** Recherche géographique : centre + rayon (km, max 50). Combine avec `q` ou `naf`. */
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

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (naf) params.set("activite_principale", naf);
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
  params.set("per_page", String(Math.min(Math.max(perPage, 1), 25)));

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
 * Renvoie null si introuvable.
 */
export async function getEntrepriseBySiren(
  siren: string,
  signal?: AbortSignal,
): Promise<Entreprise | null> {
  if (!/^\d{9}$/.test(siren)) {
    throw new Error(`getEntrepriseBySiren: SIREN invalide "${siren}" (attendu 9 chiffres)`);
  }
  const result = await searchEntreprises({
    q: `siren:${siren}`,
    perPage: 1,
    onlyActive: false,
    signal,
  });
  return result.entreprises[0] ?? null;
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
    dirigeants: (api.dirigeants ?? []).map((d) => {
      const out: Dirigeant = {};
      if (d.nom) out.nom = d.nom;
      if (d.prenoms) out.prenoms = d.prenoms;
      if (d.fonction) out.fonction = d.fonction;
      if (d.qualite) out.qualite = d.qualite;
      return out;
    }),
    etablissements,
    actif: (api.etat_administratif ?? "A") === "A",
  };

  if (api.siege?.siret) entreprise.siretSiege = api.siege.siret;
  if (api.activite_principale) entreprise.naf = api.activite_principale;
  if (api.libelle_activite_principale) entreprise.nafLibelle = api.libelle_activite_principale;
  if (api.tranche_effectif_salarie) entreprise.trancheEffectif = api.tranche_effectif_salarie;
  if (api.nature_juridique) entreprise.natureJuridique = api.nature_juridique;

  return entreprise;
}

function toEtablissement(api: ApiSiege): Etablissement {
  const e: Etablissement = {
    siret: api.siret ?? "",
    adresse: api.adresse ?? "",
    actif: (api.etat_administratif ?? "A") === "A",
  };
  if (api.code_postal) e.codePostal = api.code_postal;
  if (api.libelle_commune) e.commune = api.libelle_commune;
  if (api.activite_principale) e.naf = api.activite_principale;
  if (api.tranche_effectif_salarie) e.trancheEffectif = api.tranche_effectif_salarie;
  if (api.date_creation) e.dateCreation = api.date_creation;
  if (api.latitude !== undefined && api.longitude !== undefined) {
    const lat = typeof api.latitude === "string" ? Number.parseFloat(api.latitude) : api.latitude;
    const lon =
      typeof api.longitude === "string" ? Number.parseFloat(api.longitude) : api.longitude;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      e.point = { lon, lat };
    }
  }
  return e;
}
