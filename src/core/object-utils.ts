/**
 * Helpers internes pour la construction d'objets de retour à partir de payloads
 * d'API (DINUM, FINESS, Ameli, geo.api.gouv.fr, IGN). Pas exporté publiquement.
 *
 * Pourquoi un helper ? Les mappers `toEtablissement`, `toProfessionnelSante`,
 * etc. répétaient ~45 fois le pattern `if (api.X) e.Y = api.X` pour omettre
 * les champs absents/vides du payload. La version déclarative (mapping colonne
 * → champ métier) est plus lisible et plus facile à amender quand l'API
 * upstream renomme une colonne.
 */

/**
 * Filtre les entrées dont la valeur est `undefined` ou la chaîne vide.
 * Préserve les autres valeurs telles quelles. Renvoie un `Partial<T>` qui
 * peut être spread dans un littéral d'objet.
 *
 * @example
 * ```ts
 * const ps: ProfessionnelSante = {
 *   nom, prenom,
 *   ...pickDefined({
 *     civilite: row.ps_activite_civilite,
 *     codePostal: row.coordonnees_code_postal,
 *   }),
 * };
 * ```
 */
export function pickDefined<T extends Record<string, string | undefined>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key in obj) {
    const value = obj[key];
    if (value !== undefined && value !== "") {
      out[key] = value;
    }
  }
  return out;
}
