/**
 * Annuaire Santé ANS — fallback FHIR live (libre accès, depuis avril 2025).
 *
 * Pourquoi : la table `rpps` est ingérée mensuellement depuis le CSV
 * data.gouv. Pour les SP qui ne sont pas encore dans le snapshot DB (récente
 * inscription, mutation de structure non répercutée), on offre un fallback
 * live via l'API FHIR ANS qui est rafraîchie quotidiennement côté ANS.
 *
 * Auth (vérifié 2026-05-09 sur portail.openfhir.annuaire.sante.fr) :
 * - Header **`ESANTE-API-KEY: <api-key>`** (UUID issu d'une souscription
 *   Gravitee gratuite sur portal.api.esante.gouv.fr).
 * - Endpoint : `GET https://gateway.api.esante.gouv.fr/fhir/v2/Practitioner?identifier=...`
 * - Pas de quota documenté pendant la bêta (publique depuis avril 2025) ;
 *   limits annoncées « après fin 2025 ».
 *
 * Identifiants : l'API expose `Practitioner.identifier` typé `IDNPS`
 * (système OID `urn:oid:1.2.250.1.71.4.2.1`). Le CSV legacy expose le
 * même champ sous "Identification nationale PP" (11 chars). On cherche par
 * IDNPS qui matche le `rpps_id` que l'on stocke en DB.
 *
 * No-op gracieux : pas de clé → null sans throw — la lib reste utilisable
 * sans clé ANS (la couverture DB suffit à la majorité des cas).
 */

import { HttpError, fetchJson } from "../core/http.js";

const ANS_FHIR_DEFAULT_BASE = "https://gateway.api.esante.gouv.fr/fhir/v2";
const ANS_AUTH_HEADER = "ESANTE-API-KEY";
const IDNPS_SYSTEM = "urn:oid:1.2.250.1.71.4.2.1";
/**
 * Couvre les retries cumulés `fetchJson` (4 tentatives, backoff exponentiel
 * ~7.5s) avec marge confortable même sous lenteur ANS 5xx. Aligné sur le
 * timeout INSEE (V0.4.5) pour un comportement homogène.
 */
const FETCH_TIMEOUT_MS = 60_000;

export function getAnsFhirApiKey(): string | null {
  const raw = process.env.ANS_FHIR_API_KEY;
  if (!raw) return null;
  // Strippe quotes entourants (parsers .env qui les conservent → 401 silencieux),
  // pattern identique à `getInseeApiKey` (cf. insee-sirene.ts V0.4.5).
  const cleaned = raw.trim().replace(/^["']|["']$/g, "");
  return cleaned === "" ? null : cleaned;
}

/** Override optionnel (env de staging, mock test). Sinon endpoint officiel. */
export function getAnsFhirBaseUrl(): string {
  const raw = process.env.ANS_FHIR_BASE_URL?.trim();
  return raw && raw !== "" ? raw.replace(/\/+$/, "") : ANS_FHIR_DEFAULT_BASE;
}

/**
 * Shape minimale d'une ressource FHIR Practitioner. On ne lit que ce dont on
 * a besoin pour mapper vers `AnsFhirPractitioner` côté caller. Les autres
 * champs FHIR (qualification, telecom, address, language…) sont ignorés au
 * boundary pour ne pas exploser la surface de typage.
 */
interface FhirIdentifier {
  use?: string;
  system?: string;
  value?: string;
  type?: { coding?: Array<{ system?: string; code?: string }> };
}

interface FhirHumanName {
  use?: string;
  family?: string;
  given?: string[];
  prefix?: string[];
}

interface FhirPractitionerResource {
  resourceType: "Practitioner";
  id?: string;
  identifier?: FhirIdentifier[];
  name?: FhirHumanName[];
  active?: boolean;
}

interface FhirBundle {
  resourceType: "Bundle";
  type?: string;
  total?: number;
  entry?: Array<{ resource?: FhirPractitionerResource }>;
}

/**
 * Résultat aplati d'un lookup ANS — surface minimaliste pour ne pas dupliquer
 * la richesse FHIR. Le caller MCP (tool `professionnel_by_rpps`) injecte
 * cette shape quand la DB ne trouve pas le PS.
 */
export interface AnsFhirPractitioner {
  /** ID interne ANS (format `003-NNNN-NNNN`). Distinct de l'IDNPS. */
  ans_internal_id: string;
  /** IDNPS / RPPS national (11 chars). Identique à `rpps_id` côté DB. */
  rpps_id: string;
  civilite: string | null;
  nom: string;
  prenom: string;
  active: boolean | null;
  source: "ans_fhir";
}

/**
 * Lookup FHIR ANS par IDNPS / rpps_id. Retourne `null` si :
 * - pas de clé configurée (no-op gracieux)
 * - PS non trouvé (Bundle vide ou 404)
 * - erreur réseau / 5xx / 401 / 403 (loggée, pas propagée)
 *
 * Utilisé en fallback du lookup DB. Latence p99 ~1-2s. Pas de cache local
 * (ANS est rafraîchi quotidiennement, le cache deviendrait vite obsolète).
 */
export async function lookupPractitionerByRpps(
  rppsId: string,
): Promise<AnsFhirPractitioner | null> {
  const apiKey = getAnsFhirApiKey();
  if (!apiKey) return null;

  const trimmed = rppsId.trim();
  if (trimmed === "") return null;

  const baseUrl = getAnsFhirBaseUrl();
  // FHIR search syntax : `identifier=<system>|<value>` cible le `Practitioner`
  // dont l'identifier (use=official) matche IDNPS=trimmed. Plus précis qu'une
  // recherche libre par nom — l'IDNPS est par contrat unique côté ANS.
  const url = `${baseUrl}/Practitioner?identifier=${encodeURIComponent(IDNPS_SYSTEM)}|${encodeURIComponent(trimmed)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let bundle: FhirBundle;
  try {
    bundle = await fetchJson<FhirBundle>(url, {
      headers: {
        [ANS_AUTH_HEADER]: apiKey,
        Accept: "application/fhir+json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    // Pattern identique à insee-sirene.ts : un seul console.error en début
    // de catch, log différencié 404 (warn, outcome attendu) vs reste (error).
    const httpStatus = err instanceof HttpError ? err.status : null;
    const errMsg = err instanceof Error ? err.message : String(err);
    const logFn = httpStatus === 404 ? console.warn : console.error;
    logFn(
      `[france-data-mcp] ANS FHIR lookup terminated for rpps=${trimmed} — ${httpStatus !== null ? `HTTP ${httpStatus}` : `network/parse error: ${errMsg}`}`,
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }

  // Bundle vide = identifier inconnu côté ANS. Outcome légitime (PS pas
  // encore inscrit, identifier corrompu côté caller). Pas un incident.
  const entries = bundle.entry ?? [];
  if (entries.length === 0) return null;

  // FHIR garantit l'unicité par identifier=IDNPS, donc on prend le premier.
  // Les éventuels doublons côté ANS seraient une anomalie qu'on n'essaie pas
  // de résoudre côté client (signaler à ans-annuaire@esante.gouv.fr).
  const resource = entries[0]?.resource;
  if (!resource || resource.resourceType !== "Practitioner") return null;

  return mapPractitioner(resource, trimmed);
}

function mapPractitioner(
  resource: FhirPractitionerResource,
  expectedRpps: string,
): AnsFhirPractitioner {
  const ansInternalId = resource.id ?? "";

  // Recherche du IDNPS dans les identifiers — on a filtré côté URL mais on
  // re-vérifie pour ne pas mapper un Practitioner qui aurait un autre
  // identifier en premier (FHIR n'ordonne pas les identifiers).
  const idnps = resource.identifier?.find(
    (id) => id.system === IDNPS_SYSTEM || id.type?.coding?.some((c) => c.code === "IDNPS"),
  );
  const idnpsValue = idnps?.value?.trim();
  // Log si on doit fallback : signe d'une régression côté ANS (Practitioner
  // sans IDNPS alors que la requête a matché par identifier). Permet de
  // détecter une dégradation systémique en grep des logs Vercel/CI.
  if (!idnpsValue) {
    console.warn(
      `[france-data-mcp] ANS FHIR Practitioner (id=${resource.id ?? "?"}) sans IDNPS exploitable — fallback sur la valeur URL "${expectedRpps}"`,
    );
  }
  const rpps_id = idnpsValue || expectedRpps;

  // FHIR HumanName : on prend le `name[use=official]` quand disponible, sinon
  // le premier name présent. La civilité est dans `prefix[0]` (Dr, M., Mme).
  const officialName = resource.name?.find((n) => n.use === "official") ?? resource.name?.[0];
  const family = officialName?.family?.trim() ?? "";
  const given = officialName?.given?.[0]?.trim() ?? "";
  const civilite = officialName?.prefix?.[0]?.trim() ?? null;

  return {
    ans_internal_id: ansInternalId,
    rpps_id,
    civilite,
    nom: family,
    prenom: given,
    active: typeof resource.active === "boolean" ? resource.active : null,
    source: "ans_fhir",
  };
}
