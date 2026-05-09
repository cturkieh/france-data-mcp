/**
 * INSEE SIRENE V3.11 — fallback authentifié pour les SIREN absents de DINUM.
 *
 * Pourquoi : `recherche-entreprises.api.gouv.fr` (DINUM) exclut les entreprises
 * en diffusion partielle INSEE (`statut_diffusion ∈ {P,N}`). Cas connu : SIREN
 * 787120435 (BIO ARD'AISNE) présent dans SIRENE mais absent de DINUM. Pour ces
 * SIREN, on fallback sur l'API SIRENE INSEE directement (auth requise).
 *
 * Doc API (vérifié 2026-05-09) :
 * - Catalogue : https://portail-api.insee.fr/catalog (nouveau portail depuis 2024)
 * - Endpoint : `GET https://api.insee.fr/api-sirene/3.11/siren/{siren}` (test
 *   curl 2026-05-09 sans auth → HTTP 401, URL confirmée valide)
 * - Auth OAuth2 client_credentials sur
 *   `https://auth.insee.net/auth/realms/apim-gravitee/protocol/openid-connect/token`
 *   (test curl 2026-05-09 avec creds factices → 401 invalid_client, URL OK).
 *   L'ancien endpoint `https://api.insee.fr/token` est décommissionné (HTTP 404
 *   "url deprecated, visit https://portail-api.insee.fr/").
 *
 * Tokens INSEE typiquement valides 7 jours. On cache en mémoire avec refresh
 * à T-5min de l'expiration pour éviter les tokens expirés en cours de requête.
 *
 * No-op gracieux : si les credentials ne sont pas configurés, `lookupSirenViaInsee`
 * retourne null sans throw — la lib reste utilisable sans clé INSEE.
 */

import { HttpError, fetchJson } from "../core/http.js";
import type { Entreprise } from "./dinum.js";

const TOKEN_URL =
  "https://auth.insee.net/auth/realms/apim-gravitee/protocol/openid-connect/token";
const SIRENE_BASE_URL = "https://api.insee.fr/api-sirene/3.11";
/** Refresh à T-5min : marge confortable pour ne pas envoyer un token qui expire mid-flight. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/**
 * Timeout côté caller. Doit couvrir TOUS les retries `fetchJson` (jusqu'à 4
 * tentatives avec backoff exponentiel ~0.5+1+2+4s = 7.5s + temps de requête).
 * 60s laisse une marge confortable même sous lenteur INSEE 5xx — sans timeout
 * généreux, le 1er abort tue le retry et neutralise la robustesse promise.
 */
const FETCH_TIMEOUT_MS = 60_000;
/** TTL de fallback quand l'API auth INSEE n'expose pas `expires_in`. 1h conservateur. */
const FALLBACK_TOKEN_TTL_SEC = 3600;

export type InseeSireneCredentials = {
  clientId: string;
  clientSecret: string;
};

/**
 * Lit `INSEE_SIRENE_CLIENT_ID` et `INSEE_SIRENE_CLIENT_SECRET` depuis l'env.
 * Retourne `null` si l'une des deux manque ou est vide (no-op gracieux).
 */
export function getInseeSirenCredentials(): InseeSireneCredentials | null {
  const clientId = process.env.INSEE_SIRENE_CLIENT_ID;
  const clientSecret = process.env.INSEE_SIRENE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

type CachedToken = {
  accessToken: string;
  /** Date.now() à laquelle le token doit être considéré expiré (avec marge). */
  expiresAtMs: number;
};

let tokenCache: CachedToken | null = null;

/**
 * Reset le cache du token. Utilisé exclusivement par les tests pour isoler
 * les cas où on vérifie le comportement de cache (1er appel = fetch, 2e = hit).
 * Convention `__...ForTesting` aligné sur `__resetClientsForTesting` (storage/supabase).
 */
export function __resetInseeTokenCacheForTesting(): void {
  tokenCache = null;
}

type TokenResponse = {
  access_token: string;
  token_type?: string;
  /** Durée de vie en secondes (typiquement 604800 = 7 jours). */
  expires_in?: number;
};

/**
 * Récupère un bearer token INSEE — depuis le cache si valide, sinon nouveau
 * via OAuth2 client_credentials. Throw uniquement si l'API auth est joignable
 * mais retourne une réponse non-conforme (signal de panne amont). Les erreurs
 * réseau/credentials sont remontées telles quelles au caller.
 */
export async function getInseeBearerToken(creds: InseeSireneCredentials): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAtMs) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch((bodyErr: unknown) => {
      const bodyMsg = bodyErr instanceof Error ? bodyErr.message : String(bodyErr);
      console.warn(
        `[france-data-mcp] INSEE token endpoint: failed to read error body (HTTP ${response.status}): ${bodyMsg}`,
      );
      return "";
    });
    throw new Error(
      `INSEE token endpoint returned HTTP ${response.status} ${response.statusText}: ${text.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as TokenResponse;
  if (!data.access_token) {
    throw new Error("INSEE token endpoint returned no access_token");
  }
  // expires_in absent → assume FALLBACK_TOKEN_TTL_SEC. Toujours appliquer la
  // marge de refresh pour ne jamais retourner un token qui va expirer mid-call.
  const expiresInSec = data.expires_in ?? FALLBACK_TOKEN_TTL_SEC;
  tokenCache = {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + expiresInSec * 1000 - TOKEN_REFRESH_MARGIN_MS,
  };
  return data.access_token;
}

/**
 * Shape minimale de la réponse INSEE SIRENE V3 — on lit uniquement les champs
 * nécessaires au mapping `Entreprise`. La doc INSEE expose bien plus (catégorie
 * juridique, périodes, sigle, ESS, etc.) mais on reste minimal pour respecter
 * le contrat "fallback de dépannage", pas un remplacement complet de DINUM.
 */
type ApiInseeUniteLegale = {
  siren?: string;
  denominationUniteLegale?: string | null;
  nomUniteLegale?: string | null;
  prenomUsuelUniteLegale?: string | null;
  prenom1UniteLegale?: string | null;
  activitePrincipaleUniteLegale?: string | null;
  etatAdministratifUniteLegale?: string | null;
  categorieJuridiqueUniteLegale?: string | null;
};

type ApiInseeResponse = {
  uniteLegale?: ApiInseeUniteLegale;
};

/**
 * Récupère une entreprise par SIREN via l'API SIRENE INSEE V3.11.
 *
 * Comportement :
 * - Pas de credentials configurés → `null` (no-op gracieux, pas de throw)
 * - HTTP 404 → `null` (vraiment pas dans SIRENE)
 * - HTTP 401/403 → `null` + `console.warn` (auth cassée, ne pas throw)
 * - HTTP 5xx / timeout / erreur réseau → `null` + `console.error`
 * - HTTP 200 → `Entreprise` mappée minimale (siren, nomComplet, naf, actif)
 */
export async function lookupSirenViaInsee(siren: string): Promise<Entreprise | null> {
  const creds = getInseeSirenCredentials();
  if (!creds) return null;

  let token: string;
  try {
    token = await getInseeBearerToken(creds);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[france-data-mcp] INSEE SIRENE auth failed for siren=${siren}: ${msg}`);
    return null;
  }

  // fetchJson gère retry exponentiel sur 5xx + retry-after sur 429 — important
  // sur INSEE qui rate-limit agressivement. Les 4xx (404/401/403) throwent en
  // HttpError immédiat, qu'on attrape pour transformer en `null` (le contrat
  // de cette fonction est un fallback gracieux, pas une propagation d'erreur).
  const url = `${SIRENE_BASE_URL}/siren/${encodeURIComponent(siren)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let data: ApiInseeResponse;
  try {
    data = await fetchJson<ApiInseeResponse>(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } catch (err) {
    // Log unique en début de catch (discipline error-handling : zéro silence,
    // un seul point de trace par catch) puis dispatch des side-effects (token
    // invalidation sur 401/403). Le 404 est un outcome attendu mais on le
    // trace pour distinguer en post-mortem "absent partout" de "INSEE pas
    // configuré".
    const httpStatus = err instanceof HttpError ? err.status : null;
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[france-data-mcp] INSEE SIRENE lookup terminated for siren=${siren} — ${httpStatus !== null ? `HTTP ${httpStatus}` : `network/parse error: ${errMsg}`}`,
    );
    if (httpStatus === 401 || httpStatus === 403) {
      // Token revoke server-side (rotation creds, expiration anticipée par
      // INSEE) — sans invalidation, tous les appels suivants pendant la
      // durée du cache (jusqu'à 7j) réutiliseraient le même token cassé et
      // retomberaient en 401 silencieux.
      tokenCache = null;
    }
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

  return {
    siren,
    nomComplet: deriveNomComplet(ul, siren),
    finances: [],
    dirigeants: [],
    actif: ul.etatAdministratifUniteLegale === "A",
    etablissements: [],
    enrichmentStatus: "not_attempted",
    siren_source: "insee_v3",
    ...(ul.activitePrincipaleUniteLegale
      ? { naf: ul.activitePrincipaleUniteLegale }
      : {}),
    ...(ul.categorieJuridiqueUniteLegale
      ? { natureJuridique: ul.categorieJuridiqueUniteLegale }
      : {}),
  };
}

/**
 * Reconstruit `nomComplet` depuis la réponse INSEE :
 * - `denominationUniteLegale` (raison sociale) prime quand présente (personnes morales)
 * - sinon `prenom + nom` (entrepreneur individuel) — `prenomUsuelUniteLegale` est
 *   le champ canonique, `prenom1UniteLegale` est un fallback historique
 * - sinon `siren` brut (signal explicite que la donnée nominative manque)
 */
function deriveNomComplet(ul: ApiInseeUniteLegale, siren: string): string {
  const denomination = ul.denominationUniteLegale?.trim();
  if (denomination) return denomination;
  const prenom = (ul.prenomUsuelUniteLegale ?? ul.prenom1UniteLegale)?.trim();
  const nom = ul.nomUniteLegale?.trim();
  if (prenom && nom) return `${prenom} ${nom}`;
  if (nom) return nom;
  return siren;
}
