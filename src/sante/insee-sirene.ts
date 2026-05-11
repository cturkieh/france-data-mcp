/**
 * INSEE SIRENE V3.11 — fallback authentifié pour les SIREN absents de DINUM.
 *
 * Pourquoi : `recherche-entreprises.api.gouv.fr` (DINUM) exclut les entreprises
 * en diffusion partielle INSEE (`statut_diffusion ∈ {P,N}`). Cas connu : SIREN
 * 787120435 (BIO ARD'AISNE) présent dans SIRENE mais absent de DINUM. Pour ces
 * SIREN, on fallback sur l'API SIRENE INSEE directement (clé requise).
 *
 * Auth (vérifié 2026-05-09 sur portail-api.insee.fr V3.11) :
 * - Header **`X-INSEE-Api-Key-Integration: <api-key>`** (UUID issu du portail).
 *   Bearer / apikey / X-Gravitee-Api-Key tous renvoient 401 — c'est le custom
 *   header Gravitee configuré côté gateway INSEE qui prime.
 * - Endpoint : `GET https://api.insee.fr/api-sirene/3.11/siren/{siren}`
 * - Rate limit : 30 req/min (header `x-rate-limit-limit: 30`).
 *
 * Payload V3.11 : les champs métier (denomination, nom, prénom, NAF, état
 * administratif, catégorie juridique) sont dans
 * `uniteLegale.periodesUniteLegale[0]` (la période la plus récente, ordre
 * antéchronologique), PAS sur `uniteLegale` directement.
 *
 * No-op gracieux : si `INSEE_SIRENE_API_KEY` n'est pas configurée,
 * `lookupSirenViaInsee` retourne null sans throw — la lib reste utilisable
 * sans clé INSEE.
 */

import { HttpError, fetchJson } from "../core/http.js";
import { type LookupResult, lookupFound, lookupNotFound } from "../core/lookup-result.js";
import type { Entreprise } from "./dinum.js";

const SIRENE_BASE_URL = "https://api.insee.fr/api-sirene/3.11";
/** Nom exact du header attendu par l'API gateway Gravitee côté INSEE V3.11. */
const INSEE_AUTH_HEADER = "X-INSEE-Api-Key-Integration";
/**
 * Timeout côté caller. Doit couvrir TOUS les retries `fetchJson` (jusqu'à 4
 * tentatives avec backoff exponentiel ~0.5+1+2+4s = 7.5s + temps de requête).
 * 60s laisse une marge confortable même sous lenteur INSEE 5xx.
 */
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Lit `INSEE_SIRENE_API_KEY` depuis l'env. Retourne `null` si absente ou vide
 * (no-op gracieux : la lib reste utilisable sans clé INSEE).
 *
 * Strippe aussi les guillemets entourants — certains parsers `.env` (ou un
 * copier-coller Vercel UI) les conservent, et l'API INSEE rejette alors
 * silencieusement la clé en 401, ce qui ressemble à une clé révoquée.
 */
export function getInseeApiKey(): string | null {
  const raw = process.env.INSEE_SIRENE_API_KEY;
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^["']|["']$/g, "");
  return cleaned === "" ? null : cleaned;
}

/**
 * Shape minimale de la réponse INSEE SIRENE V3 — on lit uniquement les champs
 * nécessaires au mapping `Entreprise`. Les valeurs métier vivent dans
 * `periodesUniteLegale[0]` (la période courante).
 *
 * Exporté pour permettre aux tests de typer leurs fixtures (`Partial<ApiInseePeriode>`)
 * et bénéficier de l'autocomplete + détection de typos sur les noms de champs.
 */
export type ApiInseePeriode = {
  dateFin?: string | null;
  dateDebut?: string | null;
  denominationUniteLegale?: string | null;
  nomUniteLegale?: string | null;
  prenomUsuelUniteLegale?: string | null;
  prenom1UniteLegale?: string | null;
  activitePrincipaleUniteLegale?: string | null;
  etatAdministratifUniteLegale?: string | null;
  categorieJuridiqueUniteLegale?: string | null;
};

/**
 * Shape `uniteLegale` SIRENE V3.11. Volontairement permissive sur les deux
 * formats que l'API expose :
 *
 * - Endpoint **`/siren/{siren}`** → `uniteLegale.periodesUniteLegale[]` (historisé
 *   chronologiquement, période courante = `dateFin: null`).
 * - Endpoint **`/siret/{siret}`** → `uniteLegale` **à plat** : `denominationUniteLegale`,
 *   `nomUniteLegale`, `etatAdministratifUniteLegale`, etc. exposés directement
 *   comme champs de l'objet `uniteLegale`, SANS `periodesUniteLegale`.
 *
 * On laisse les deux shapes coexister via `ApiInseePeriode & { periodesUniteLegale? }`
 * pour que `pickUniteLegaleFields` puisse extraire les champs courants quelle
 * que soit la source. Avant V0.6.3, le mapper lisait uniquement
 * `periodesUniteLegale[]` → la réponse `/siret/` (champs à plat) tombait sur
 * un tableau vide, et `deriveNomComplet` retournait le SIREN brut comme
 * raison sociale (cas reproduit sur 50781594200333 / BIOGROUP NORD →
 * "507815942", 30116075000966 / CLINEA → "301160750").
 */
type ApiInseeUniteLegale = ApiInseePeriode & {
  siren?: string;
  periodesUniteLegale?: ApiInseePeriode[];
};

/**
 * Extrait les champs métier courants (denomination, nom, prénom, état admin,
 * NAF, catégorie juridique) d'un `uniteLegale` SIRENE quelle que soit la shape :
 *
 * - Si `periodesUniteLegale` est présent ET non vide → période courante
 *   (`dateFin: null`) ou fallback `[0]`.
 * - Sinon → l'objet `uniteLegale` lui-même (cas `/siret/` champs à plat).
 *
 * Retourne `undefined` si aucune source de champs n'est disponible (payload
 * dégradé). Le caller (`deriveNomComplet`) tombe alors sur le SIREN brut.
 */
function pickUniteLegaleFields(
  ul: ApiInseeUniteLegale | undefined,
): ApiInseePeriode | undefined {
  if (!ul) return undefined;
  const periodes = ul.periodesUniteLegale;
  if (periodes && periodes.length > 0) {
    return periodes.find((p) => p.dateFin === null || p.dateFin === undefined) ?? periodes[0];
  }
  // Destructure explicite pour ne renvoyer que les champs `ApiInseePeriode` :
  // évite que `siren` / `periodesUniteLegale` (extras du type union) ne
  // fuitent en aval et fasse croire au caller qu'il a un objet plus riche.
  const { siren: _siren, periodesUniteLegale: _periodes, ...periodeFields } = ul;
  return periodeFields;
}

type ApiInseeResponse = {
  uniteLegale?: ApiInseeUniteLegale;
};

/**
 * Récupère une entreprise par SIREN via l'API SIRENE INSEE V3.11.
 *
 * Comportement :
 * - Pas de clé configurée → `null` (no-op gracieux, pas de throw)
 * - HTTP 404 → `null` (vraiment pas dans SIRENE)
 * - HTTP 401/403 → `null` + `console.error` (clé invalide ou révoquée)
 * - HTTP 5xx / timeout / erreur réseau → `null` + `console.error`
 * - HTTP 200 → `Entreprise` mappée minimale (siren, nomComplet, naf, actif)
 *
 * ⚠️ Rate limit INSEE : 30 req/min. `fetchJson` retry sur 429 en respectant
 * `retry-after`, mais en burst soutenu (>30 lookups/min) les retries se
 * sérialisent et la latence p99 explose. Conçu comme fallback ponctuel sur
 * SIREN diffusion partielle (cas rare ~1% des SIREN), pas comme source primaire.
 */
export async function lookupSirenViaInsee(siren: string): Promise<Entreprise | null> {
  const apiKey = getInseeApiKey();
  if (!apiKey) return null;

  // fetchJson gère retry exponentiel sur 5xx + retry-after sur 429 — important
  // sur INSEE qui rate-limit à 30 req/min. Les 4xx (404/401/403) throwent en
  // HttpError immédiat, qu'on attrape pour transformer en `null` (le contrat
  // de cette fonction est un fallback gracieux, pas une propagation d'erreur).
  const url = `${SIRENE_BASE_URL}/siren/${encodeURIComponent(siren)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let data: ApiInseeResponse;
  try {
    data = await fetchJson<ApiInseeResponse>(url, {
      headers: { [INSEE_AUTH_HEADER]: apiKey },
      signal: controller.signal,
    });
  } catch (err) {
    // Log unique en début de catch (discipline error-handling : zéro silence,
    // un seul point de trace par catch). 404 = outcome attendu (`warn`, pour
    // ne pas polluer les dashboards d'erreurs Sentry/Vercel) ; 401/403/5xx/
    // network = vrais incidents (`error`).
    const httpStatus = err instanceof HttpError ? err.status : null;
    const errMsg = err instanceof Error ? err.message : String(err);
    const logFn = httpStatus === 404 ? console.warn : console.error;
    logFn(
      `[france-data-mcp] INSEE SIRENE lookup terminated for siren=${siren} — ${httpStatus !== null ? `HTTP ${httpStatus}` : `network/parse error: ${errMsg}`}`,
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }

  const ul = data.uniteLegale;
  if (!ul) {
    console.warn(`[france-data-mcp] INSEE SIRENE response missing uniteLegale for siren=${siren}`);
    return null;
  }

  // Période courante = celle dont `dateFin` est null (= période ouverte). On
  // ne se fie pas à l'ordre du tableau (l'API V3.11 le présente
  // antéchronologiquement aujourd'hui mais ce n'est pas un contrat documenté ;
  // un futur INSEE V3.12 pourrait l'inverser sans préavis). Fallback sur [0]
  // si aucune période ouverte (cas dégénéré : entreprise cessée, données
  // historiques uniquement) — on log alors un warn pour signaler la dépendance.
  const periodes = ul.periodesUniteLegale ?? [];
  let periode = periodes.find((p) => p.dateFin === null || p.dateFin === undefined);
  if (!periode && periodes.length > 0) {
    periode = periodes[0];
    console.warn(
      `[france-data-mcp] INSEE SIRENE siren=${siren} : aucune période ouverte (dateFin=null), fallback sur periodesUniteLegale[0] (potentiellement obsolète)`,
    );
  }

  return {
    siren,
    nomComplet: deriveNomComplet(periode, siren),
    finances: [],
    dirigeants: [],
    actif: periode?.etatAdministratifUniteLegale === "A",
    etablissements: [],
    enrichmentStatus: "not_attempted",
    siren_source: "insee_v3",
    ...(periode?.activitePrincipaleUniteLegale
      ? { naf: periode.activitePrincipaleUniteLegale }
      : {}),
    ...(periode?.categorieJuridiqueUniteLegale
      ? { natureJuridique: periode.categorieJuridiqueUniteLegale }
      : {}),
  };
}

/**
 * Reconstruit `nomComplet` depuis la période courante :
 * - `denominationUniteLegale` (raison sociale) prime quand présente (personnes morales)
 * - sinon `prenom + nom` (entrepreneur individuel) — `prenomUsuelUniteLegale` est
 *   le champ canonique, `prenom1UniteLegale` est un fallback historique
 * - sinon `siren` brut (signal explicite que la donnée nominative manque)
 */
function deriveNomComplet(periode: ApiInseePeriode | undefined, siren: string): string {
  if (!periode) return siren;
  const denomination = periode.denominationUniteLegale?.trim();
  if (denomination) return denomination;
  const prenom = (periode.prenomUsuelUniteLegale ?? periode.prenom1UniteLegale)?.trim();
  const nom = periode.nomUniteLegale?.trim();
  if (prenom && nom) return `${prenom} ${nom}`;
  if (nom) return nom;
  return siren;
}

// === Établissement (SIRET) lookup ============================================

/**
 * Détail d'un établissement SIRENE retourné par `lookupSiretViaInsee`. Distinct
 * de `Etablissement` (dinum.ts) qui ne contient qu'une vue partielle obtenue
 * dans un résultat de recherche par SIREN. Ce type expose en plus :
 *
 * - `enseigne` et `denominationUsuelle` (commerciales — souvent l'enseigne
 *   visible publiquement vs la raison sociale légale de l'unité légale)
 * - `dateFermeture` (présent quand `actif === false`)
 * - `raisonSocialeUniteLegale` (parent SIREN)
 *
 * Pas de `coords` : l'endpoint INSEE `/siret/<siret>` ne renvoie pas les coords
 * WGS84. Pour la géoloc, croiser avec `entreprises_in_radius` ou géocoder
 * l'adresse côté caller via `geocode_adresse`.
 */
export interface EtablissementSireneDetail {
  siret: string;
  siren: string;
  /** Raison sociale légale de l'unité légale parente. */
  raisonSocialeUniteLegale: string;
  /** Enseigne commerciale 1 (souvent affichée en façade). */
  enseigne: string | null;
  /** Dénomination usuelle (alias enseigne, parfois distinct). */
  denominationUsuelle: string | null;
  /** Code NAF de l'établissement (peut différer du NAF de l'unité légale). */
  naf: string | null;
  /** `true` si la période courante est `etatAdministratifEtablissement = 'A'`. */
  actif: boolean;
  /** Date de création (première `dateDebut` chronologique). */
  dateCreation: string | null;
  /**
   * Date de fermeture (dernière `dateDebut` quand `etatAdministratifEtablissement
   * = 'F'`). `null` si l'établissement est actif. C'est cette info qui débloque
   * la détection d'un SIRET fermé encore listé comme actif côté FINESS (DREES
   * a 1-2 mois de retard sur la cessation effective).
   */
  dateFermeture: string | null;
  /**
   * `true` si ce SIRET est le siège de l'unité légale. L'endpoint INSEE
   * `/siret/<siret>` n'expose PAS le SIRET du siège quand on consulte un
   * établissement secondaire — pour récupérer le siège, appeler
   * `entreprise_by_siren(siren)` qui retourne `siretSiege` côté unité légale.
   */
  estSiege: boolean;
  /** Tranche d'effectif salarié (codes INSEE 00..53). */
  trancheEffectif: string | null;
  adresse: {
    /** Adresse complète assemblée (numéro + voie + CP + ville). */
    libelle: string;
    numeroVoie: string | null;
    typeVoie: string | null;
    libelleVoie: string | null;
    codePostal: string | null;
    libelleCommune: string | null;
    codeCommune: string | null;
  };
}

type ApiInseePeriodeEtablissement = {
  dateDebut?: string | null;
  dateFin?: string | null;
  etatAdministratifEtablissement?: string | null;
  enseigne1Etablissement?: string | null;
  denominationUsuelleEtablissement?: string | null;
  activitePrincipaleEtablissement?: string | null;
};

type ApiInseeAdresseEtablissement = {
  numeroVoieEtablissement?: string | null;
  typeVoieEtablissement?: string | null;
  libelleVoieEtablissement?: string | null;
  codePostalEtablissement?: string | null;
  libelleCommuneEtablissement?: string | null;
  codeCommuneEtablissement?: string | null;
};

type ApiInseeEtablissement = {
  siren?: string;
  siret?: string;
  etablissementSiege?: boolean;
  trancheEffectifsEtablissement?: string | null;
  uniteLegale?: ApiInseeUniteLegale;
  adresseEtablissement?: ApiInseeAdresseEtablissement;
  periodesEtablissement?: ApiInseePeriodeEtablissement[];
};

type ApiInseeSiretResponse = {
  etablissement?: ApiInseeEtablissement;
};

/**
 * Récupère un établissement par son SIRET via l'API SIRENE INSEE V3.11.
 *
 * Comportement contractuel (aligné sur `getEntrepriseBySiren` côté wrapper) :
 * - Pas de clé `INSEE_SIRENE_API_KEY` configurée → `LookupResult` not_found
 *   avec message orientant le caller vers la config. Pas de throw : le tool
 *   MCP doit rester appelable même sans clé INSEE (pour ne pas casser les
 *   tools qui ne dépendent pas d'INSEE).
 * - HTTP 404 → `LookupResult` not_found (SIRET vraiment absent SIRENE)
 * - HTTP 401/403/5xx/timeout → throw (le caller décide quoi faire)
 * - HTTP 200 mais payload incohérent → throw
 *
 * @param siret 14 chiffres. Validation côté caller via le tool MCP.
 */
export async function lookupSiretViaInsee(
  siret: string,
): Promise<LookupResult<EtablissementSireneDetail>> {
  const raw = await fetchSiretRawFromInsee(siret);
  if (raw.kind !== "ok") return raw.lookup;
  return lookupFound(toEtablissementSireneDetail(raw.etablissement));
}

/**
 * Récupère l'historique complet (toutes les périodes) d'un établissement SIRET
 * via SIRENE INSEE V3.11. Permet de reconstruire la timeline ouvert/fermé
 * d'un site et de détecter une fermeture encore listée active côté FINESS.
 *
 * Contractuellement aligné sur `lookupSiretViaInsee` : retourne `LookupResult`,
 * pas de clé INSEE → not_found avec message, etc.
 */
export async function lookupSiretHistoriqueViaInsee(
  siret: string,
): Promise<LookupResult<EtablissementSireneHistorique>> {
  const raw = await fetchSiretRawFromInsee(siret);
  if (raw.kind !== "ok") return raw.lookup;
  const detail = toEtablissementSireneDetail(raw.etablissement);
  const periodes = (raw.etablissement.periodesEtablissement ?? [])
    .map(toPeriodeHistorique)
    // Ordre chronologique croissant (la plus ancienne en premier). Plus
    // lisible pour un caller LLM qui lit la timeline en séquence.
    .sort((a, b) => (a.dateDebut ?? "").localeCompare(b.dateDebut ?? ""));
  return lookupFound({ ...detail, periodes });
}

/**
 * Période historique mappée. Volontairement compacte : on garde uniquement
 * les champs qui changent au fil des changements administratifs (état, NAF,
 * enseigne). Le caller LLM peut ainsi lire la timeline sans noise.
 */
export interface PeriodeHistorique {
  dateDebut: string | null;
  dateFin: string | null;
  actif: boolean;
  naf: string | null;
  enseigne: string | null;
  denominationUsuelle: string | null;
}

export interface EtablissementSireneHistorique extends EtablissementSireneDetail {
  periodes: PeriodeHistorique[];
}

function toPeriodeHistorique(p: ApiInseePeriodeEtablissement): PeriodeHistorique {
  return {
    dateDebut: p.dateDebut ?? null,
    dateFin: p.dateFin ?? null,
    actif: p.etatAdministratifEtablissement === "A",
    naf: p.activitePrincipaleEtablissement ?? null,
    enseigne: p.enseigne1Etablissement?.trim() || null,
    denominationUsuelle: p.denominationUsuelleEtablissement?.trim() || null,
  };
}

/**
 * Discriminated union : soit la requête INSEE a réussi (`ok` + payload), soit
 * elle est terminée par un `LookupResult` not_found (clé absente, 404,
 * payload incohérent). Les vrais incidents (401/5xx/timeout) sont propagés
 * via throw et n'arrivent pas ici.
 */
type FetchSiretRawResult =
  | { kind: "ok"; etablissement: ApiInseeEtablissement }
  | { kind: "lookup"; lookup: LookupResult<never> };

async function fetchSiretRawFromInsee(siret: string): Promise<FetchSiretRawResult> {
  const apiKey = getInseeApiKey();
  if (!apiKey) {
    return {
      kind: "lookup",
      lookup: lookupNotFound(
        siret,
        "INSEE_SIRENE_API_KEY non configurée — ce tool requiert une clé INSEE pour interroger l'endpoint /siret/<siret> de l'API SIRENE V3.11. Inscription gratuite : https://api.insee.fr/catalogue/. Une fois la clé obtenue, définir la variable d'env INSEE_SIRENE_API_KEY sur le déploiement.",
      ),
    };
  }

  const url = `${SIRENE_BASE_URL}/siret/${encodeURIComponent(siret)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let data: ApiInseeSiretResponse;
  try {
    data = await fetchJson<ApiInseeSiretResponse>(url, {
      headers: { [INSEE_AUTH_HEADER]: apiKey },
      signal: controller.signal,
    });
  } catch (err) {
    const httpStatus = err instanceof HttpError ? err.status : null;
    if (httpStatus === 404) {
      console.warn(`[france-data-mcp] INSEE SIRENE SIRET ${siret} — HTTP 404 (introuvable)`);
      return {
        kind: "lookup",
        lookup: lookupNotFound(
          siret,
          `SIRET "${siret}" introuvable dans SIRENE INSEE. Causes possibles : SIRET inexistant, erreur de saisie, ou statut de diffusion partielle INSEE (rare). Pour vérifier la diffusion, croiser avec entreprise_by_siren.`,
        ),
      };
    }
    // Vrais incidents : 401/403/5xx/timeout/réseau. On les propage pour que
    // le caller puisse retry ou alerter, plutôt que masquer en `not_found`.
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[france-data-mcp] INSEE SIRENE SIRET ${siret} — ${httpStatus !== null ? `HTTP ${httpStatus}` : `network/parse error: ${errMsg}`}`,
    );
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const et = data.etablissement;
  if (!et || !et.siret || !et.siren) {
    console.warn(
      `[france-data-mcp] INSEE SIRENE SIRET ${siret} — payload incohérent (etablissement, siret ou siren absent)`,
    );
    return {
      kind: "lookup",
      lookup: lookupNotFound(
        siret,
        `Réponse INSEE incohérente pour SIRET "${siret}" (etablissement absent ou champs critiques manquants). Réessayer plus tard ou signaler.`,
      ),
    };
  }

  return { kind: "ok", etablissement: et };
}

function toEtablissementSireneDetail(api: ApiInseeEtablissement): EtablissementSireneDetail {
  const periodes = api.periodesEtablissement ?? [];
  // Période courante = `dateFin === null`. L'API présente antéchronologiquement
  // mais on ne s'y fie pas (cf. note dans `lookupSirenViaInsee`).
  const periodeCourante = periodes.find((p) => p.dateFin === null || p.dateFin === undefined);
  // `actif` ne se déduit PAS de l'existence d'une période courante : un
  // établissement fermé garde une période courante avec `etatAdministratif = 'F'`.
  const actif = periodeCourante?.etatAdministratifEtablissement === "A";

  // dateCreation : la `dateDebut` la plus ancienne (la première période, en
  // ordre chronologique). dateFermeture : la `dateDebut` de la période
  // courante quand elle est 'F' (= date du basculement actif → fermé).
  const periodesChrono = [...periodes].sort((a, b) =>
    (a.dateDebut ?? "").localeCompare(b.dateDebut ?? ""),
  );
  const dateCreation = periodesChrono[0]?.dateDebut ?? null;
  const dateFermeture = !actif ? (periodeCourante?.dateDebut ?? null) : null;

  // Raison sociale de l'unité légale parente : SIRENE V3.11 expose les champs
  // de l'uniteLegale À PLAT sur l'endpoint `/siret/` (pas dans
  // `periodesUniteLegale[]`, contrairement à `/siren/`). `pickUniteLegaleFields`
  // gère les deux shapes pour rester robuste si V3.12 réintroduit l'historisation.
  const raisonSocialeUniteLegale = deriveNomComplet(
    pickUniteLegaleFields(api.uniteLegale),
    api.siren ?? "",
  );

  const a = api.adresseEtablissement ?? {};
  const adresseLibelle = [
    a.numeroVoieEtablissement,
    a.typeVoieEtablissement,
    a.libelleVoieEtablissement,
    a.codePostalEtablissement,
    a.libelleCommuneEtablissement,
  ]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join(" ")
    .trim();

  return {
    siret: api.siret ?? "",
    siren: api.siren ?? "",
    raisonSocialeUniteLegale,
    enseigne: periodeCourante?.enseigne1Etablissement?.trim() || null,
    denominationUsuelle: periodeCourante?.denominationUsuelleEtablissement?.trim() || null,
    naf: periodeCourante?.activitePrincipaleEtablissement ?? null,
    actif,
    dateCreation,
    dateFermeture,
    estSiege: api.etablissementSiege === true,
    trancheEffectif: api.trancheEffectifsEtablissement ?? null,
    adresse: {
      libelle: adresseLibelle,
      numeroVoie: a.numeroVoieEtablissement ?? null,
      typeVoie: a.typeVoieEtablissement ?? null,
      libelleVoie: a.libelleVoieEtablissement ?? null,
      codePostal: a.codePostalEtablissement ?? null,
      libelleCommune: a.libelleCommuneEtablissement ?? null,
      codeCommune: a.codeCommuneEtablissement ?? null,
    },
  };
}
