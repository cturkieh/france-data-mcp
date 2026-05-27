import { describe, expect, it } from "vitest";
import { readAllMigrationsSql } from "./migration-sql.js";

// Garde-fou structurel SANS DB — anti-régression silencieuse du fix
// cold-start 57014 (migration `20260528T130000_extend_statement_timeout_lookups.sql`).
//
// Classe de bug visée :
//   Le fix V0.20+ ajoute `SET statement_timeout = '15s'` via `ALTER FUNCTION`
//   sur 8 RPCs lookup. `ALTER FUNCTION ... SET` n'écrit que le `proconfig`
//   au catalogue — IL N'EST PAS PORTÉ par les défs canoniques `CREATE OR
//   REPLACE FUNCTION` dans les migrations source. Conséquence : si une
//   future migration recrée une de ces 8 RPCs (ex ajout d'une colonne au
//   SELECT, fix d'un cast) en copiant la def canonique SANS re-déclarer
//   le `SET statement_timeout` dans son header, **Postgres écrase
//   silencieusement le proconfig à NULL** et la RPC retombe sur l'hérité
//   `authenticator` 8s → réapparition des 57014 cold-start (baseline 21
//   events / 14j) sans alerte avant les events Sentry.
//
//   Même classe de panne SILENCIEUSE que les gotchas CLAUDE.md « matview
//   OID rebuild post-swap » et « GiST partiel découplé au swap » : un fix
//   en clause-only (config / ALTER) est invisible aux refactors body-only,
//   donc une régression certaine à terme sans garde-fou structurel.
//
// Invariant garanti :
//   Pour chacune des 8 RPCs, la DERNIÈRE déclaration dans les migrations
//   (CREATE OR REPLACE FUNCTION OU ALTER FUNCTION, ordre = tri nom de
//   fichier = ordre d'application Supabase) porte un `SET statement_timeout`
//   de valeur dans [15s, 55s]. Borne basse = la marge prouvée prod
//   nécessaire pour absorber le cold-start P99 ; borne haute = sous le cap
//   passerelle PostgREST ~60s (gotcha CLAUDE.md, garantit un 57014 propre
//   plutôt qu'un timeout passerelle opaque).
//
// 3 RPCs NON listées ici, intentionnellement (tunées court pour fail-fast,
// gardées par le keep-warm cron `.github/workflows/keep-warm.yml`) :
//   - count_rpps             (2s)
//   - count_rpps_by_commune  (5s)
//   - rpps_search_by_name    (10s)
// Si on les ajoute un jour au garde-fou, ajuster la borne basse minimum
// à `min(2, 15)` ou splitter le test.

const LOOKUP_RPCS = [
  "finess_by_num_finess",
  "finess_by_categorie",
  "ameli_by_specialite_dept",
  "ameli_in_radius",
  "ameli_lister_specialites",
  "centres_sante_by_finess",
  "lister_savoir_faire_rpps",
  "rpps_in_radius",
] as const;

const MIN_TIMEOUT_SECONDS = 15;
const MAX_TIMEOUT_SECONDS = 55;

/**
 * Échappe les métacaractères regex pour interpoler un nom de fonction
 * littéral. Dupliqué de `migration-sql.ts` (non exporté là-bas par design
 * "surface minimale") plutôt que d'élargir l'API du module partagé pour
 * un seul nouveau consommateur.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Bloc de la DERNIÈRE déclaration de `fnName` dans les migrations concat.
 * Couvre les deux formes possibles qui peuvent porter un `SET statement_timeout` :
 *
 *   1. `CREATE OR REPLACE FUNCTION fn(...) ... SET statement_timeout = 'NNs' ... AS $$ ... $$`
 *      → header inclus jusqu'à la fin du `$$ ... $$` (corps).
 *   2. `ALTER FUNCTION fn(...) SET statement_timeout = 'NNs';`
 *      → statement complet jusqu'au `;` terminal.
 *
 * On garde le match dont la POSITION DE DÉBUT est la plus tardive dans le
 * fichier concaténé (≡ migration la plus récente touchant cette fonction).
 * Si la dernière déclaration est un `CREATE OR REPLACE` sans `SET`, l'extracteur
 * de timeout ci-dessous retournera null → test rouge bruyant (= comportement
 * attendu, c'est exactement la régression silencieuse à attraper).
 *
 * LIMITES ASSUMÉES :
 *   - Cherche `(?:public\.)?fn` : namespace `public.fn` ou nu. Une future
 *     migration utilisant un schéma différent (ex `app.fn`) sortirait du
 *     scope du garde-fou. Aucune RPC du projet n'est aujourd'hui hors public.
 *   - Le délimiteur dollar-quote utilise une back-reference `\1` pour
 *     tolérer les tags nommés (`$$` mais aussi `$body$`, `$func$`, etc.) —
 *     pattern aligné sur `latestFunctionBody` strict dans migration-sql.ts.
 *     Sans cette tolérance, une future migration anti-collision (corps
 *     contenant `$$` en littéral) deviendrait invisible au garde-fou =
 *     faux vert sur la régression que ce test prétend attraper.
 *   - Le `create\s+(?:or\s+replace\s+)?function` accepte AUSSI le pattern
 *     `DROP FUNCTION ... ; CREATE FUNCTION ...` (sans OR REPLACE) que le
 *     projet utilise pour les changements de signature (ex
 *     `20260514T040000_matview_rpps_savoir_faire.sql`). Sans le `?`, un
 *     changement de signature recréerait la fonction avec proconfig=NULL
 *     sans alerte du garde-fou.
 */
function latestDeclarationBlock(fnName: string): string {
  const allSql = readAllMigrationsSql().toLowerCase();
  const esc = escapeRegExp(fnName);
  // CREATE [OR REPLACE] FUNCTION fn ... AS $tag$ ... $tag$ — back-ref \1 sur le tag
  // pour tolérer $$ et $body$/$func$/etc. sans confondre un `$$` interne d'un format().
  const create = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?${esc}\\b[\\s\\S]*?\\bas\\s+(\\$[a-z_]*\\$)[\\s\\S]*?\\1`,
    "g",
  );
  const alter = new RegExp(`alter\\s+function\\s+(?:public\\.)?${esc}\\b[^;]*;`, "g");

  let lastPos = -1;
  let lastBlock = "";
  for (const re of [create, alter]) {
    for (const m of allSql.matchAll(re)) {
      if (m.index !== undefined && m.index > lastPos) {
        lastPos = m.index;
        lastBlock = m[0];
      }
    }
  }
  return lastBlock;
}

/**
 * Durée d'un `SET statement_timeout = '...'` NORMALISÉE en secondes. Postgres
 * accepte `'<n>s'` / `'<n>min'` / `'<n>h'` / `'<n>ms'` / entier nu (ms défaut).
 * Retourne `null` si la clause est absente ou illisible. Aligné avec le helper
 * du test `enrichment-statement-timeout.test.ts` pour cohérence projet.
 */
function timeoutSeconds(block: string): number | null {
  const m = block.match(/set\s+statement_timeout\s*(?:to|=)\s*'?\s*(\d+)\s*(ms|s|min|h)?\s*'?/i);
  if (!m) return null;
  const n = Number(m[1]);
  switch ((m[2] ?? "").toLowerCase()) {
    case "h":
      return n * 3600;
    case "min":
      return n * 60;
    case "s":
      return n;
    default:
      return n / 1000; // 'ms' ou entier nu = millisecondes (défaut Postgres)
  }
}

describe("lookup RPCs — statement_timeout fonction ≥ 15s (anti-régression cold-start 57014)", () => {
  for (const fn of LOOKUP_RPCS) {
    describe(fn, () => {
      it("a une déclaration récente avec SET statement_timeout", () => {
        const block = latestDeclarationBlock(fn);
        expect(
          block.length,
          `Aucune déclaration trouvée pour ${fn} (ni CREATE OR REPLACE ni ALTER FUNCTION) dans les migrations. Soit la fonction n'existe pas, soit son nom a changé sans MAJ du garde-fou.`,
        ).toBeGreaterThan(0);
        expect(
          block,
          `Dernière déclaration de ${fn} n'a PAS de SET statement_timeout → ré-hérite du budget authenticator 8s → 57014 cold-start ressurgit (baseline 21 events/14j pré-fix). Si la dernière migration touchant ${fn} est un CREATE OR REPLACE FUNCTION, RAJOUTER \`SET statement_timeout = '15s'\` dans son header (entre LANGUAGE et AS \$\$), ou suivre avec un ALTER FUNCTION ... SET. Migration patron : 20260528T130000_extend_statement_timeout_lookups.sql.`,
        ).toMatch(/set\s+statement_timeout/i);
      });

      it("statement_timeout dans [15s, 55s]", () => {
        const block = latestDeclarationBlock(fn);
        const secs = timeoutSeconds(block);
        expect(
          secs,
          `SET statement_timeout illisible dans la dernière déclaration de ${fn} (attendu '<n>s' | '<n>min' | …). Vérifier la syntaxe : SET statement_timeout = '15s'.`,
        ).not.toBeNull();
        expect(
          secs as number,
          `${fn} statement_timeout=${secs}s : doit être ≥ ${MIN_TIMEOUT_SECONDS}s (marge prouvée prod nécessaire pour absorber le cold-start P99 ~5s). Sous cette borne, les 57014 reviennent.`,
        ).toBeGreaterThanOrEqual(MIN_TIMEOUT_SECONDS);
        expect(
          secs as number,
          `${fn} statement_timeout=${secs}s : doit être ≤ ${MAX_TIMEOUT_SECONDS}s (sous le cap passerelle PostgREST ~60s). Au-dessus, on récolte un timeout passerelle opaque avant un 57014 propre/diagnosticable.`,
        ).toBeLessThanOrEqual(MAX_TIMEOUT_SECONDS);
      });
    });
  }
});
