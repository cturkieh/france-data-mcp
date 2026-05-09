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

type ApiInseeUniteLegale = {
  siren?: string;
  periodesUniteLegale?: ApiInseePeriode[];
};

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
    console.warn(
      `[france-data-mcp] INSEE SIRENE response missing uniteLegale for siren=${siren}`,
    );
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
