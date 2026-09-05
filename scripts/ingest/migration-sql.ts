// Helpers de PARSING des migrations SQL — module UNION partagé par DEUX
// familles de garde-fous structurels SANS DB :
//
//  1. Famille BAN (parité octet-à-octet) — `ban-eligibility-index-expr-parity`,
//     `ban-eligibility-predicate-parity`. API STRICTE :
//     `latestFunctionBody(sql, fnName, opts)` (ancre `\bas\s+(\$tag\$)…\1\s*;`,
//     options stripComments/compact), `indexStatement`, `readAllMigrationsSql`
//     (BRUT — le lowercase est laissé à l'appelant), `migrationsDir`.
//     `staging-parity` consomme le lecteur partagé (`allMigrationsSql` +
//     `ingestDir`) mais garde un `latestFunctionBody` LOCAL à regex lâche
//     (≡ `latestFunctionBodyLoose` ci-dessous) — découplé par prudence
//     (filet anti-perte d'index au swap, cf. CLAUDE.md).
//
//  2. Famille ingestion (matview rebuild / enrichment timeout) —
//     `rpps-matview-rebuild.test.ts`, `enrichment-statement-timeout.test.ts`.
//     API LÂCHE : `latestFunctionBodyLoose(fnName)` (regex `$$…$$` tolérante,
//     fonctions d'ingestion anciennes dont la forme `$tag$` n'est pas garantie
//     de matcher l'ancre stricte), `latestFunctionDef`, `functionBodyInFile`,
//     `allMigrationsSql` (lowercased), `ingestDir`.
//
//  3. Famille CI/YAML (garde-fous d'alerting des workflows) —
//     `workflows-alerting.test.ts` : n'emprunte ICI que le chemin `githubDir`
//     (même patron `fileURLToPath(new URL(…))` que `migrationsDir`/`ingestDir`,
//     immunisé au cwd) — aucun parsing SQL.
//
// ⚠️ LES DEUX `latestFunctionBody*` COEXISTENT VOLONTAIREMENT — contrats
// DIFFÉRENTS (stricte ancrée pour les RPC BAN à `$q$` interne ; lâche pour les
// fonctions d'ingestion anciennes). NE PAS « factoriser » naïvement en une
// seule : un seul contrat rendrait un guard muet (faux vert = exactement la
// classe de panne que ces guards combattent). Un seul lecteur disque
// (`readAllMigrationsSql`) sert les deux ; `allMigrationsSql` n'est que sa vue
// lowercased — un durcissement du parseur profite donc aux deux familles.
//
// Ce module n'est PAS un fichier de test (`.ts`, pas `.test.ts`) : vitest ne
// le collecte pas ; il est couvert par tsconfig + biome comme tout `scripts/`.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Répertoire des migrations SQL Supabase (chemin absolu, dérivé du module). */
export const migrationsDir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

/** Dossier `scripts/ingest/` (pour scanner les `*.ts` appelant un RPC). */
export const ingestDir = fileURLToPath(new URL(".", import.meta.url));

/** Dossier `.github/` (workflows + composite actions, lus en texte par les garde-fous CI). */
export const githubDir = fileURLToPath(new URL("../../.github", import.meta.url));

/**
 * Toutes les migrations SQL concaténées dans l'ordre d'application (tri nom de
 * fichier = ordre Supabase), BRUTES. Le lowercasing est laissé à l'appelant
 * (staging-parity lowercase, les guards d'expression non) : centraliser le
 * lowercase ici régresserait silencieusement les appelants qui ont besoin du
 * brut. `allMigrationsSql()` ci-dessous en est la vue lowercased.
 */
export function readAllMigrationsSql(): string {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((n) => readFileSync(`${migrationsDir}/${n}`, "utf8"))
    .join("\n");
}

/** Vue lowercased de `readAllMigrationsSql()` (famille ingestion). */
export function allMigrationsSql(): string {
  return readAllMigrationsSql().toLowerCase();
}

/**
 * Échappe les métacaractères regex. Un nom d'objet SQL injecté dans une
 * `RegExp` DOIT être littéral : un futur nom contenant `.`/`(`/`$`/etc.
 * casserait SILENCIEUSEMENT le guard (faux vert = exactement la classe de
 * panne que ces guards combattent). Non exporté : surface minimale.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * (FAMILLE BAN — STRICTE) Corps `$$...$$` de la DERNIÈRE définition de
 * `fnName` (ordre = tri nom = ordre d'application Supabase). DERNIÈRE déf :
 * sinon on validerait le corps MORT d'une migration antérieure (= faux PASS
 * sur la corrective). Exclut l'en-tête WHY (avant `as $$`) ET le `COMMENT ON
 * FUNCTION ... IS '...'` (après le `$$` fermant) qui citent le prédicat/jumeau
 * en prose. Les fonctions ciblées utilisent `$$` (extérieur) + `$q$` (format
 * interne) sans collision.
 *
 * - `stripComments` : retire les `-- ...` ligne-à-ligne AVANT compactage — le
 *   corps skip-scan contient des commentaires INLINE décrivant la stratégie ;
 *   les confondre avec une clause exécutable ferait un FAUX POSITIF.
 * - `compact` : `\s+`→` ` + trim.
 *
 * Défaut (ni strip ni compact) = corps brut, pour la comparaison de SENS du
 * prédicat (predicate-parity). index-expr-parity passe les deux options.
 *
 * LIMITE ASSUMÉE : `stripComments` retire tout après `--` sur chaque ligne, y
 * compris un `--` à l'intérieur d'un littéral SQL (`'a--b'`). Vrai pour TOUS
 * les corps ciblés actuels (aucun `--` en littéral) ; l'effet d'un futur
 * littéral à `--` serait un sur-strip → FAUX ROUGE (match cassé), jamais un
 * faux vert. À revoir si une RPC ciblée introduit `'…--…'`.
 */
export function latestFunctionBody(
  sql: string,
  fnName: string,
  opts: { stripComments?: boolean; compact?: boolean } = {},
): string {
  // Délimiteur dollar-quote TOLÉRANT au tag nommé (`$$` ou `$func$`…) via
  // back-reference `\1` : une future migration en `AS $body$ … $body$;`
  // (pattern courant anti-collision) ne doit PAS rendre ce helper muet — un
  // `raw=""` silencieux désarmerait les guards d'un coup (faux vert sur le
  // filet anti-panne-totale). Tag externe = groupe 1, corps = groupe 2 ;
  // `[\s\S]*?\1` s'arrête au PREMIER tag externe refermant suivi de `\s*;`
  // (le `$q$` interne d'un format() n'est pas le tag externe → non confondu).
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escapeRegExp(fnName)}\\b[\\s\\S]*?\\bas\\s+(\\$[a-zA-Z_]*\\$)([\\s\\S]*?)\\1\\s*;`,
    "g",
  );
  // CONTRAT (module partagé) : `""` est renvoyé pour DEUX cas distincts —
  // aucune def ne matche, OU corps littéralement vide. Tout consommateur DOIT
  // traiter `""` comme « introuvable » et échouer BRUYAMMENT (jamais
  // `if (body) { …check… }` silencieux qui hériterait d'un skip). m[2] = corps,
  // toujours une chaîne sur un match — `?? ""` satisfait noUncheckedIndexedAccess.
  let raw = "";
  for (const m of sql.matchAll(re)) raw = m[2] ?? "";
  let out = raw;
  if (opts.stripComments) {
    out = out
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
  }
  if (opts.compact) out = out.replace(/\s+/g, " ").trim();
  return out;
}

/**
 * (FAMILLE INGESTION — LÂCHE) Corps `$$...$$` de la DERNIÈRE définition d'une
 * fonction (ordre = tri nom de fichier = ordre d'application Supabase). Limite :
 * fonctions `$$` sans tag `$tag$` imbriqué (vrai pour `ingest_create_*_staging`,
 * `ingest_refresh_matview`, `ingest_rebuild_rpps_matviews`). Lit la vue
 * lowercased. Distinct VOLONTAIREMENT de `latestFunctionBody` strict — voir
 * l'en-tête du module.
 */
export function latestFunctionBodyLoose(fnName: string): string {
  const re = new RegExp(
    `create (?:or replace )?function\\s+${escapeRegExp(fnName)}\\b[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
    "g",
  );
  let body = "";
  for (const m of allMigrationsSql().matchAll(re)) body = m[1] ?? "";
  return body;
}

/**
 * Définition COMPLÈTE (header + corps `$$...$$`) de la DERNIÈRE déclaration
 * d'une fonction. Contrairement à `latestFunctionBodyLoose` (corps seul),
 * inclut le header — donc les clauses `SET search_path` / `SET
 * statement_timeout` qui vivent AVANT le `$$`. Mêmes limites regex.
 */
export function latestFunctionDef(fnName: string): string {
  const re = new RegExp(
    `create (?:or replace )?function\\s+${escapeRegExp(fnName)}\\b[\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$`,
    "g",
  );
  let def = "";
  for (const m of allMigrationsSql().matchAll(re)) def = m[0] ?? "";
  return def;
}

/**
 * Corps `$$...$$` de la 1ère déf d'une fonction dans UN fichier migration
 * précis (vs `latestFunctionBodyLoose` = dernière déf, toutes migrations
 * concaténées), normalisé (whitespace compacté, lowercased, trimmed) pour une
 * comparaison verbatim anti-drift. Mêmes limites regex. `file` = nom de
 * fichier dans `supabase/migrations/`.
 */
export function functionBodyInFile(file: string, fnName: string): string {
  const sql = readFileSync(`${migrationsDir}/${file}`, "utf8").toLowerCase();
  const m = sql.match(
    new RegExp(
      `create (?:or replace )?function\\s+${escapeRegExp(fnName)}\\b[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
      "i",
    ),
  );
  return m ? (m[1] ?? "").replace(/\s+/g, " ").trim() : "";
}

/**
 * (FAMILLE BAN) DERNIER statement `CREATE INDEX [IF NOT EXISTS] <name> ON
 * <table> (...) [WHERE ...];` par nom. Borné par `;` terminal : ne déborde pas
 * sur le statement suivant ni n'enjambe un `COMMENT ON INDEX ... IS '...'`. Le
 * `[\s\S]*?` non gourmand + ancre `;` empêche d'avaler une prose d'en-tête
 * (un commentaire `--` n'a pas de `;` terminant un faux CREATE INDEX réel).
 *
 * `compact` : `\s+`→` ` + trim (index-expr-parity). Défaut = brut
 * (predicate-parity, qui normalise lui-même).
 *
 * LIMITE ASSUMÉE : `[\s\S]*?;` s'arrête au PREMIER `;`. Vrai pour tous les
 * index BAN actuels (clause `WHERE` sans `;` en littéral). Un futur index
 * partiel avec un littéral contenant `;` (`WHERE x = 'a;b'`) serait tronqué
 * → match incomplet → violation poussée en aval (BRUYANT), jamais faux vert.
 * À borner (parenthèses équilibrées) si un tel littéral apparaît.
 */
export function indexStatement(
  sql: string,
  indexName: string,
  opts: { compact?: boolean } = {},
): string {
  const re = new RegExp(
    `create\\s+index\\s+(?:if\\s+not\\s+exists\\s+)?${escapeRegExp(indexName)}\\b[\\s\\S]*?;`,
    "g",
  );
  let last = "";
  for (const m of sql.matchAll(re)) last = m[0];
  return opts.compact ? last.replace(/\s+/g, " ").trim() : last;
}
