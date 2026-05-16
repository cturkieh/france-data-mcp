/**
 * Helpers d'adresse FINESS-spécifiques + ré-export des primitives génériques.
 *
 * Les primitives `normalizeForCompare` / `diceCoefficient` vivent désormais
 * dans `core/text-match.ts` (consommées aussi par `territoire/geocode.ts`,
 * voir le rationale là-bas). Ré-exportées ici pour ne pas casser les imports
 * historiques de `cross-source.ts` / `siret-resolver.ts` / `coverage.ts` —
 * source unique inchangée, juste relocalisée.
 */

import { diceCoefficient, normalizeForCompare } from "../core/text-match.js";
import type { FinessResult } from "./finess-db.js";

export { diceCoefficient, normalizeForCompare };

/**
 * Concatène voie + CP + ville en un libellé comparable. Champs `null`/vides
 * ignorés (DREES/CNAM omettent régulièrement la voie). Source unique du
 * format pour que les deux côtés d'une comparaison (FINESS vs SIRENE/CNAM)
 * soient normalisés strictement à l'identique — sinon `diceCoefficient`
 * serait faussé par un format divergent.
 */
export function buildAdresseLibelle(parts: {
  voie: string | null;
  code_postal: string | null;
  ville: string | null;
}): string {
  return [parts.voie, parts.code_postal, parts.ville]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join(" ");
}

/** Variante FINESS de {@link buildAdresseLibelle}. */
export function buildFinessAdresseLibelle(f: FinessResult): string {
  return buildAdresseLibelle(f.adresse);
}
