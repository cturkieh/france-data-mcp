/**
 * Helper boundary MCP : applique la résolution `nom_commune → code_insee` +
 * valide les XOR au boundary (avant tout appel lib).
 *
 * Source de vérité : `docs/plans/nom-commune-resolver-v019.md` §3.
 *
 * Sémantique du flag `departement` :
 *  - Si `nomCommune` fourni → `departement` est traité comme **hint resolver**
 *    (filtre côté `geo.api.gouv.fr`), JAMAIS comme scope de calcul. Le tool
 *    consommateur reçoit uniquement `{ codeInsee }`.
 *  - Si `nomCommune` absent et `departement` fourni :
 *    - `acceptsDepartementAsScope: true` → pass-through scope dept.
 *    - `acceptsDepartementAsScope: false` → erreur explicite.
 *
 * Les erreurs de résolution voyagent via `RangeError(msg, { cause })`
 * (cf. patch `api/mcp.ts:384-393` qui propage `err.cause` à `error.data`).
 */

import { type ResolveCommuneError, resolveNomCommune } from "./resolve-commune.js";

export type CommuneResolverArgs = {
  nomCommune: string | undefined;
  codeInsee: string | undefined;
  departement: string | undefined;
  /**
   * `true` si le tool sait calculer au niveau département (by_categorie,
   * densite_professionnels). `false` pour panorama (commune uniquement).
   */
  acceptsDepartementAsScope: boolean;
  /**
   * `true` si le tool exige un scope (panorama). `false` pour ceux qui acceptent
   * FR entière (by_categorie) ou ont validation propre côté lib
   * (densite_professionnels via `resolveZone`).
   */
  requireScope: boolean;
};

export type CommuneResolverResult = {
  codeInsee?: string;
  departement?: string;
};

export async function applyCommuneResolver(
  args: CommuneResolverArgs,
): Promise<CommuneResolverResult> {
  const { nomCommune, codeInsee, departement, acceptsDepartementAsScope, requireScope } = args;

  // Branch 1 : nom_commune + code_insee → toujours redondant (XOR strict)
  if (nomCommune && codeInsee) {
    throw new RangeError(
      "Paramètres redondants : passer SOIT `code_insee` SOIT `nom_commune`, pas les deux.",
      {
        cause: {
          kind: "redundant_commune_params",
          input: { nom_commune: nomCommune, code_insee: codeInsee },
        },
      },
    );
  }

  // Branch 2 : code_insee + departement → toujours redondant (V0.19 fix M2/Q3 review).
  // - Pour tools acceptant dept comme scope (by_categorie, densite_professionnels) :
  //   passer les 2 = XOR violation explicite. densite_professionnels a en plus
  //   `resolveZone` côté lib en defense-in-depth.
  // - Pour tools commune-only (panorama) : `departement` est absurde si `code_insee`
  //   fourni (la lib ne le lit jamais). Sans le throw boundary, il était avalé
  //   silencieusement → bug latent. Wording adapté à la sémantique du tool.
  if (codeInsee && departement) {
    const message = acceptsDepartementAsScope
      ? "Paramètres redondants : passer SOIT `code_insee` (scope commune) SOIT `departement` (scope département), pas les deux."
      : "Paramètre `departement` incompatible avec `code_insee` sur ce tool (calcul commune uniquement). Combiner `departement` avec `nom_commune` si besoin de désambiguïsation, sinon passer `code_insee` seul.";
    throw new RangeError(message, {
      cause: {
        kind: "redundant_commune_params",
        input: { code_insee: codeInsee, departement },
      },
    });
  }

  // Branch 3 : nom_commune fourni → resolve (departement = hint, pas scope)
  if (nomCommune) {
    const result = await resolveNomCommune({
      nom: nomCommune,
      ...(departement ? { departement } : {}),
    });
    if (!result.resolved) {
      throw new RangeError(formatResolveError(result.error), { cause: result.error });
    }
    return { codeInsee: result.commune.code };
  }

  // Branch 4 : code_insee seul → pass-through
  if (codeInsee) {
    return { codeInsee };
  }

  // Branch 5 : departement seul → pass-through si tool l'accepte en scope, sinon erreur.
  // Erreurs message-only (pas de `cause` structurée) — aligné avec le pattern existant
  // `requireString`/`requireOneOf` qui throw RangeError nu. `error.data` sera undefined,
  // le message texte est suffisamment actionnable pour le LLM.
  if (departement) {
    if (acceptsDepartementAsScope) {
      return { departement };
    }
    throw new RangeError(
      "Scope département non supporté par ce tool (calcul commune uniquement). Utiliser `code_insee` ou `nom_commune`.",
    );
  }

  // Branch 6 : rien fourni
  if (requireScope) {
    throw new RangeError(
      "Scope requis : passer `code_insee` (5 chiffres) ou `nom_commune` (nom officiel).",
    );
  }
  return {};
}

function formatResolveError(err: ResolveCommuneError): string {
  switch (err.kind) {
    case "ambiguous_commune": {
      // `ambiguous_commune` n'est émis que si `exact.length > 1` (cf.
      // `resolve-commune.ts`), donc `total_matches` est toujours > 1 — pluriel
      // garanti par construction, pas besoin de ternaire (fix Q4 review).
      const deptSuffix = err.input.departement
        ? ` dans le département '${err.input.departement}'`
        : "";
      return `Commune ambiguë : ${err.total_matches} communes correspondent à '${err.input.nom_commune}'${deptSuffix}. Préciser le département via \`departement\`, ou choisir un code INSEE dans \`candidates\`.`;
    }
    case "commune_not_in_department":
      return `Commune '${err.input.nom_commune}' introuvable dans le département '${err.input.departement}'. Trouvée dans d'autres départements (voir \`matches_in_other_dept\`).`;
    case "unknown_commune":
      return `Commune '${err.input.nom_commune}' inconnue. ${err.hint}`;
  }
}
