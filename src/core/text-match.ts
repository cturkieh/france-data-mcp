/**
 * Primitives de comparaison textuelle GÉNÉRIQUES (sans dépendance domaine).
 *
 * Vivent dans `core/` parce qu'elles sont consommées des DEUX côtés de la
 * frontière de couches : `sante/` (cross-source, siret-resolver, coverage,
 * compare_adresse) ET `territoire/` (geocode : Dice libellé demandé vs label
 * IGN). Les laisser sous `sante/address-match.ts` forçait `territoire/` à
 * importer `sante/` — inversion de couche + risque de cycle (sante importe
 * déjà territoire). `address-match.ts` les ré-exporte pour ne pas casser ses
 * consommateurs historiques (source unique préservée).
 */

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
  return (
    value
      .normalize("NFD")
      // Strip toutes les marks Unicode (combining diacritics post-NFD :
      // U+0300-U+036F + spacing/enclosing marks). `\p{M}` avec flag `u` au lieu
      // d'un range littéral de combining chars (invisibles à l'œil + flag
      // `lint/suspicious/noMisleadingCharacterClass` Biome).
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[.,'’\-\s]+/g, " ")
      .trim()
  );
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
