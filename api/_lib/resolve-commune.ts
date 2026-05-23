/**
 * Resolver `nom_commune` → `code_insee` via `geo.api.gouv.fr` (DINUM/Etalab).
 *
 * Cadrage : `docs/plans/nom-commune-resolver-v019.md` §3.
 *
 * Ne throw jamais — retourne toujours un `ResolveCommuneResult` discriminé.
 * Le caller boundary (`applyCommuneResolver`) traduit en `RangeError({cause})`
 * pour propagation JSON-RPC `error.data` (patch `api/mcp.ts:384-393`).
 *
 * Stratégie de matching : exact case-insensitive + accents normalisés (NFD).
 * Élimine le bruit fuzzy de l'API (qui matche `Mont-Saint-Martin` sur
 * `Saint-Martin`). L'API gère nativement casse + accents pour la recherche ;
 * le filtre post-API garantit le déterminisme du contrat MCP.
 */

import { type Commune, searchCommunes } from "../../src/territoire/communes.js";

export type ResolveCandidate = {
  code: string;
  nom: string;
  codeDepartement: string;
  population: number | null;
};

export type ResolveCommuneError =
  | {
      kind: "unknown_commune";
      input: { nom_commune: string; departement?: string };
      hint: string;
    }
  | {
      kind: "ambiguous_commune";
      input: { nom_commune: string; departement?: string };
      candidates: ResolveCandidate[];
      total_matches: number;
      truncated: boolean;
    }
  | {
      kind: "commune_not_in_department";
      input: { nom_commune: string; departement: string };
      matches_in_other_dept: ResolveCandidate[];
    };

export type ResolveCommuneResult =
  | { resolved: true; commune: Commune }
  | { resolved: false; error: ResolveCommuneError };

const CAP_CANDIDATES = 10;
const SEARCH_LIMIT = 30;
const UNKNOWN_HINT =
  "Utiliser le nom officiel complet (ex. 'Saint-Martin' et non 'St-Martin'). Les abréviations 'St'/'Ste' ne sont pas reconnues. Si le nom contient un tiret, le conserver.";

/**
 * Normalize for case-insensitive + accent-insensitive comparison (NFD + strip
 * combining marks). Utilise `\p{M}` (Mark) — aligné avec les 2 autres sites
 * du codebase qui font la même normalisation : `src/core/text-match.ts`
 * (`normalizeForCompare`) et `src/territoire/commune-index.ts`
 * (`normalizeCityName`). Source unique du choix `\p{M}` vs `\p{Diacritic}` :
 * `\p{M}` inclut les combining marks Unicode, suffisant pour les noms de
 * commune français + DOM ; `\p{Diacritic}` capture aussi quelques modifier
 * letters non pertinents ici.
 */
function normalizeName(s: string): string {
  return s.trim().normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function toCandidate(c: Commune): ResolveCandidate {
  return {
    code: c.code,
    nom: c.nom,
    codeDepartement: c.codeDepartement ?? "",
    population: c.population ?? null,
  };
}

function buildInput(input: {
  nom: string;
  departement?: string;
}): { nom_commune: string; departement?: string } {
  return {
    nom_commune: input.nom,
    ...(input.departement ? { departement: input.departement } : {}),
  };
}

export async function resolveNomCommune(input: {
  nom: string;
  departement?: string;
  signal?: AbortSignal;
}): Promise<ResolveCommuneResult> {
  const wantedKey = normalizeName(input.nom);

  // Garde défensive — caller boundary devrait avoir validé non-vide.
  if (!wantedKey) {
    return {
      resolved: false,
      error: {
        kind: "unknown_commune",
        input: buildInput(input),
        hint: "Le paramètre `nom_commune` doit être un nom de commune non vide.",
      },
    };
  }

  const all = await searchCommunes({
    nom: input.nom,
    limit: SEARCH_LIMIT,
    boostPopulation: true,
    ...(input.departement ? { codeDepartement: input.departement } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const exact = all.filter((c) => normalizeName(c.nom) === wantedKey);

  if (exact.length === 1) {
    // biome-ignore lint/style/noNonNullAssertion: garde explicite ligne ci-dessus (`exact.length === 1`) garantit que `exact[0]` est défini ; refactor déstructuration ajouterait du bruit sans gain.
    return { resolved: true, commune: exact[0]! };
  }

  if (exact.length > 1) {
    return {
      resolved: false,
      error: {
        kind: "ambiguous_commune",
        input: buildInput(input),
        candidates: exact.slice(0, CAP_CANDIDATES).map(toCandidate),
        total_matches: exact.length,
        truncated: exact.length > CAP_CANDIDATES,
      },
    };
  }

  // exact.length === 0 → distinguer "not_in_dept" vs "unknown" si dept était filtre.
  // 2ème round-trip API uniquement sur ce cas rare (UX > coût) pour donner au caller
  // une erreur structurée actionnable au lieu d'un "unknown" trompeur.
  if (input.departement) {
    const fallback = await searchCommunes({
      nom: input.nom,
      limit: SEARCH_LIMIT,
      boostPopulation: true,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const exactGlobal = fallback.filter((c) => normalizeName(c.nom) === wantedKey);
    if (exactGlobal.length > 0) {
      return {
        resolved: false,
        error: {
          kind: "commune_not_in_department",
          input: { nom_commune: input.nom, departement: input.departement },
          matches_in_other_dept: exactGlobal.slice(0, CAP_CANDIDATES).map(toCandidate),
        },
      };
    }
  }

  return {
    resolved: false,
    error: {
      kind: "unknown_commune",
      input: buildInput(input),
      hint: UNKNOWN_HINT,
    },
  };
}
