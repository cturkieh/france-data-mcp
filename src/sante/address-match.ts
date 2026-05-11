/**
 * Primitives de comparaison textuelle FINESS ↔ SIRENE / DINUM / RPPS.
 *
 * Pourquoi un module dédié : la normalisation et le scoring d'adresse / raison
 * sociale sont consommés par `cross-source.ts` ET `siret-resolver.ts`. Sans ce
 * module partagé, les deux fichiers ont chacun leur propre `normalizeFor…`
 * légèrement divergent → bug latent où FINESS↔SIRENE et FINESS↔DINUM ne
 * scoreraient pas le même couple identiquement. Centraliser ici règle la
 * divergence et évite l'import cycle entre les deux modules consommateurs.
 */

import type { FinessResult } from "./finess-db.js";

/**
 * Normalisation agressive pour comparaison Dice :
 * - NFD + suppression des diacritiques (équivalence "é"≈"e")
 * - lowercase (FINESS DREES écrit souvent en UPPER CASE)
 * - ponctuation classique → espace (',', '.', apostrophes, tirets)
 * - collapse whitespace
 *
 * Robuste aux variantes typographiques FINESS vs SIRENE (apostrophes
 * typographiques `’` vs droites `'`, "ST" vs "SAINT", abréviations DREES…).
 */
export function normalizeForCompare(value: string): string {
  // Escape unicode explicite `̀-ͯ` (vs le range composé `[̀-ͯ]`)
  // pour portabilité éditeur — certaines toolchains affichent le range comme
  // un caractère unique et le mangent au save. Combine accents + ponctuation
  // + whitespace en une seule passe regex pour réduire le nb d'allocations.
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,'’\-\s]+/g, " ")
    .trim();
}

/**
 * Concatène voie + CP + ville côté FINESS pour comparer à une adresse libellée
 * SIRENE / DINUM. Champs `null`/vides ignorés (DREES omet régulièrement la
 * voie sur les structures émergentes).
 */
export function buildFinessAdresseLibelle(f: FinessResult): string {
  return [f.adresse.voie, f.adresse.code_postal, f.adresse.ville]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join(" ");
}

/**
 * Coefficient de Sørensen-Dice sur les bigrammes — robuste aux typos / ordre
 * des mots / accents pour des libellés courts (raisons sociales, adresses).
 * Plus approprié qu'une similarity trigram côté SQL : on n'a pas besoin d'index,
 * juste d'un nombre 0..1 par paire. Implémentation 20 lignes, dépendance
 * externe non justifiée.
 *
 * Pour chaînes < 2 chars : égalité stricte (Dice classique = 0 pour les
 * unigrammes seuls, ce qui sous-évalue les match exacts courts type "CH").
 */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigramsA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) ?? 0) + 1);
  }
  let intersection = 0;
  let totalB = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    totalB++;
    const inA = bigramsA.get(bg);
    if (inA !== undefined && inA > 0) {
      intersection++;
      bigramsA.set(bg, inA - 1);
    }
  }
  const totalA = a.length - 1;
  if (totalA + totalB === 0) return 0;
  return (2 * intersection) / (totalA + totalB);
}
