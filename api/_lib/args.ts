/**
 * Helpers de normalisation des arguments tool MCP (V0.9 UX).
 *
 * Constat partagé en testant le MCP depuis ChatGPT et Claude : les LLMs
 * devinent souvent `q`/`query`/`dept`/`code_insee` alors que l'API attend
 * `nom`/`code`/`code_dept`. 2-3 essais ratés avant de trouver le bon nom.
 *
 * Trois primitives complémentaires :
 *   - `normalizeAliases(args, aliasMap)` : remap les clés alternatives vers
 *     le nom canonique attendu par le handler.
 *   - `suggestParamError(args, expected, example)` : produit un message
 *     d'erreur enrichi avec suggestion ("Reçu 'q'. Attendu 'nom'.").
 *   - `requireOneOf(args, keys, example)` : valide qu'au moins une des clés
 *     attendues est présente, sinon throw avec suggestion.
 *
 * Pourquoi pre-Zod (et pas un schéma Zod alternatif) :
 *   - Le `inputSchema` MCP exposé aux LLMs reste canonique (un seul nom par
 *     param → docs et hints lisibles).
 *   - Les alias sont une concession DX, pas une partie du contrat. Si un
 *     alias est retiré demain, ça reste rétro-compatible.
 *   - Coût négligeable (un objet spread + lookup par clé).
 */

import { NUM_FINESS_PATTERN, RPPS_ID_PATTERN, SIRET_PATTERN } from "../../src/sante/db-helpers.js";

/** RangeError mapping JSON-RPC -32602 côté boundary MCP (Invalid params). */
function paramError(message: string): RangeError {
  return new RangeError(message);
}

/**
 * Remap les clés présentes dans `args` selon `aliasMap`. La clé canonique
 * (valeur du map) gagne toujours si elle est déjà présente — le caller a
 * fourni la forme correcte, on ne l'écrase pas avec un alias.
 *
 * Exemple :
 *   normalizeAliases({ q: "Lyon" }, { q: "nom", query: "nom" })
 *   → { nom: "Lyon" }
 *
 * Pas de mutation de l'input : nouveau objet retourné.
 */
export function normalizeAliases(
  args: Record<string, unknown>,
  aliasMap: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Première passe : copie tout le canonique d'origine (préserve la priorité).
  for (const [key, value] of Object.entries(args)) {
    if (!(key in aliasMap)) {
      out[key] = value;
    }
  }
  // Seconde passe : applique les alias seulement si la clé canonique n'est
  // pas déjà présente, pour éviter d'écraser un input explicite. Si une
  // collision est détectée (canonique présente ET alias présent avec valeur
  // différente), on warn pour rendre l'incident traçable Sentry — le LLM qui
  // pense avoir passé "Lyon" via `q` mais a aussi un `nom: "Paris"` doit
  // savoir pourquoi sa recherche tape Paris.
  for (const [aliasKey, canonicalKey] of Object.entries(aliasMap)) {
    if (!(aliasKey in args)) continue;
    if (canonicalKey in out) {
      if (out[canonicalKey] !== args[aliasKey]) {
        console.warn(
          `[france-data-mcp] normalizeAliases: collision sur "${canonicalKey}" — alias "${aliasKey}"=${JSON.stringify(args[aliasKey])} ignoré, canonique=${JSON.stringify(out[canonicalKey])} retenu`,
        );
      }
      continue;
    }
    out[canonicalKey] = args[aliasKey];
  }
  return out;
}

/**
 * Construit un message d'erreur explicite quand un paramètre est manquant
 * ou nommé incorrectement. Détecte les clés présentes qui ressemblent à un
 * alias non-mappé et le signale au caller.
 *
 * Exemple :
 *   suggestParamError({ q: "Lyon" }, ["nom"], { nom: "Lyon" })
 *   → 'Paramètre manquant. Reçu: ["q"]. Attendu: "nom". Exemple: {"nom":"Lyon"}'
 */
export function suggestParamError(
  args: Record<string, unknown>,
  expectedKeys: readonly string[],
  exampleArg: Record<string, unknown>,
): RangeError {
  const presentKeys = Object.keys(args);
  const expectedFmt = expectedKeys.map((k) => `"${k}"`).join(" ou ");
  const receivedFmt =
    presentKeys.length > 0 ? `Reçu: [${presentKeys.map((k) => `"${k}"`).join(", ")}]. ` : "";
  return paramError(
    `Paramètre manquant. ${receivedFmt}Attendu: ${expectedFmt}. Exemple: ${JSON.stringify(exampleArg)}`,
  );
}

/**
 * Valide qu'au moins une des clés attendues est présente dans `args` (après
 * normalizeAliases). Throw avec message suggestif sinon.
 *
 * Usage typique en haut de handler :
 *   const args = normalizeAliases(rawArgs, { q: "nom", query: "nom" });
 *   requireOneOf(args, ["nom", "codePostal", "code"], { nom: "Lyon" });
 *
 * Note : une string non-vide (incl. whitespace-only "   ") est considérée
 * présente. Pour exiger un contenu non-whitespace, le caller doit trim avant.
 */
export function requireOneOf(
  args: Record<string, unknown>,
  expectedKeys: readonly string[],
  exampleArg: Record<string, unknown>,
): void {
  for (const key of expectedKeys) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return;
    if (typeof v === "number") return;
  }
  throw suggestParamError(args, expectedKeys, exampleArg);
}

/**
 * Valide qu'une clé string non-vide est présente dans `args`. Retourne la
 * valeur. Pattern raccourci pour les tools mono-param (population_par_commune,
 * get_commune_by_code, panorama_sante_territoire, etc.).
 *
 * Usage typique :
 *   const args = normalizeAliases(rawArgs, { code_insee: "code" });
 *   const code = requireString(args, "code", { code: "75056" });
 *   return getPopulationByCommune(code);
 */
export function requireString(
  args: Record<string, unknown>,
  key: string,
  exampleArg: Record<string, unknown>,
): string {
  const v = args[key];
  if (typeof v === "string" && v.length > 0) return v;
  // Distinguer "clé absente" de "clé présente mais mauvais type" — sinon
  // le LLM voit "Paramètre manquant" alors qu'il a fourni la clé avec un
  // number (boucle infinie en retentant la même valeur).
  if (key in args) {
    throw paramError(
      `Paramètre "${key}" doit être une string non vide. Reçu: type=${typeof v}, valeur=${JSON.stringify(v)}. Exemple: ${JSON.stringify(exampleArg)}`,
    );
  }
  throw suggestParamError(args, [key], exampleArg);
}

/**
 * Valide un numéro FINESS (9 chiffres exactement, colonne SQL `CHAR(9)`).
 * Retourne la valeur trimée. Message d'erreur explicite quand un LLM passe
 * 8 chiffres (oubli zéro de tête) ou un SIRET 14 chiffres confondu avec FINESS.
 *
 * Trois branches d'erreur distinctes (cohérence avec `requireString`) :
 *  1. Clé absente → `suggestParamError` (Paramètre manquant + exemple)
 *  2. Clé présente mais type ≠ string → message explicite type + valeur reçue
 *  3. Clé string mais format invalide → message regex 9 chiffres + exemple
 *
 * Pourquoi le tool layer plutôt que le wrapper DB :
 *  - Le LLM appelle le tool, pas la lib — l'erreur doit revenir avec un
 *    message qui parle des paramètres MCP, pas du contrat SQL.
 *  - Defense-in-depth : la RPC Postgres throw aussi sur `CHAR(9)` overflow,
 *    mais le message renvoyé est moins lisible (`value too long for type`).
 *  - Centralisé pour qu'un caller (`compare_…`, `verifier_site_actif`,
 *    `historique_etablissement`, `reconcilier_finess_sirene`, `etablissement_by_finess`,
 *    `rpps_dans_etablissement`) ne réinvente pas la regex chacun de son côté.
 *
 * Source de vérité regex : `NUM_FINESS_PATTERN` (`src/sante/db-helpers.ts`),
 * partagée avec `assertValidNumFiness` (defense-in-depth lib + tool boundary).
 */
/**
 * Cœur partagé des validators `requireFinessId` / `requireSiretId` /
 * `requireRppsId`. Trois branches d'erreur cohérentes (clé absente, type
 * wrong, format wrong) pour donner au LLM caller un signal stable. Toute
 * évolution du contrat d'erreur se propage automatiquement aux 3 façades
 * publiques + tout futur `requireSiren` / `requireAdeli`.
 */
function requireIdPattern(
  args: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  formatHuman: string,
  example: Record<string, string>,
): string {
  if (!(key in args)) {
    throw suggestParamError(args, [key], example);
  }
  const raw = args[key];
  if (typeof raw !== "string") {
    throw paramError(
      `Paramètre "${key}" doit être une string (${formatHuman}). Reçu: type=${typeof raw}, valeur=${JSON.stringify(raw)}. Exemple: ${JSON.stringify(example)}`,
    );
  }
  const trimmed = raw.trim();
  if (!pattern.test(trimmed)) {
    throw paramError(
      `Paramètre "${key}" invalide : ${formatHuman}. Reçu: ${JSON.stringify(raw)}. Exemple: ${JSON.stringify(example)}`,
    );
  }
  return trimmed;
}

export function requireFinessId(args: Record<string, unknown>, key = "num_finess"): string {
  return requireIdPattern(
    args,
    key,
    NUM_FINESS_PATTERN,
    "attendu exactement 9 chiffres (FINESS DREES)",
    { [key]: "690780150" },
  );
}

/**
 * Valide un SIRET (14 chiffres exactement). Miroir de `requireFinessId` au
 * tool boundary, partage `SIRET_PATTERN` avec la lib.
 */
export function requireSiretId(args: Record<string, unknown>, key = "siret"): string {
  return requireIdPattern(
    args,
    key,
    SIRET_PATTERN,
    "attendu exactement 14 chiffres (SIRET, siège ou établissement secondaire)",
    { [key]: "39839170300012" },
  );
}

/**
 * Valide un RPPS ID / IDNPS national ANS (11 ou 12 chiffres exactement,
 * préfixe "81" optionnel pour les IDs émis depuis 2020). Miroir de
 * `requireFinessId`, partage `RPPS_ID_PATTERN` avec `getRppsById` côté lib.
 */
export function requireRppsId(args: Record<string, unknown>, key = "rpps_id"): string {
  return requireIdPattern(
    args,
    key,
    RPPS_ID_PATTERN,
    'attendu 11 ou 12 chiffres (IDNPS national ANS — préfixe "81" optionnel pour IDs émis depuis 2020)',
    { [key]: "810002066537" },
  );
}
