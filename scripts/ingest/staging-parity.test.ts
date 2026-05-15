import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Garde-fou structurel V0.10.1 — sans DB, lit les migrations SQL.
//
// Classe de bug visée (post-mortem 2026-05-15) : un index perf-critique
// ajouté sur la table prod `annuaire_ameli` mais NON répliqué dans la
// fonction `ingest_create_annuaire_ameli_staging()` est silencieusement
// PERDU au swap atomique hebdomadaire (la nouvelle prod = ex-staging). Le
// timeout 57014 réapparaît alors "tout seul" le lundi suivant. Déjà arrivé
// 2× historiquement (composites V0.4.1, covering V0.9.4), réparé après coup.
//
// + Classe de bug Fix B/C : une matview refresh par un script d'ingest mais
// absente de la whitelist `ingest_refresh_matview` → 22023 à chaque ingest
// (refresh silencieusement cassé, nomenclature figée).
//
// Méthode : on compare des ENSEMBLES de listes de colonnes normalisées
// (jamais un substring `.includes()` — un index mono-colonne `(code_dept)`
// est sous-chaîne de tout composite le contenant, ce qui ferait passer le
// garde-fou alors que l'index est réellement perdu : faux négatif silencieux,
// exactement le mode d'échec que ce test doit empêcher).

const migrationsDir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
const ingestDir = fileURLToPath(new URL(".", import.meta.url));

/** Toutes les migrations SQL concaténées dans l'ordre d'application (tri nom), lowercased. */
function allMigrationsSql(): string {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((n) => readFileSync(`${migrationsDir}/${n}`, "utf8"))
    .join("\n")
    .toLowerCase();
}

/**
 * Corps `$$...$$` de la DERNIÈRE définition d'une fonction (ordre = tri nom de
 * fichier = ordre d'application Supabase). Suffisant pour les 2 fonctions
 * ciblées ici (`ingest_create_annuaire_ameli_staging`, `ingest_refresh_matview`)
 * qui utilisent `$$` sans tag imbriqué.
 */
function latestFunctionBody(fnName: string): string {
  const re = new RegExp(
    `create (?:or replace )?function\\s+${fnName}\\b[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
    "g",
  );
  let body = "";
  for (const m of allMigrationsSql().matchAll(re)) body = m[1];
  return body;
}

/**
 * Ensemble des listes de colonnes (normalisées : lowercase + espaces
 * compactés) de chaque `CREATE INDEX ... ON <table> (...)` dans `sql`.
 *
 * - `[^(;]*?` (et non `[\s\S]*?`) borne l'écart au 1er `(` ou `;` : empêche
 *   de sauter par-dessus une autre instruction ou de capturer un
 *   `CREATE INDEX ... ON annuaire_ameli` cité en prose dans un en-tête WHY.
 * - Le groupe `((?:[^()]|\([^()]*\))*)` accepte UN niveau de parenthèses
 *   imbriquées : un index fonctionnel `(lower(nom), code_dept)` n'est pas
 *   tronqué à la 1re `)` (sinon faux négatif). >1 niveau n'existe pas ici.
 * - `\b` après le nom de table : `ON annuaire_ameli` ne matche PAS
 *   `ON annuaire_ameli_staging` (`_` est un word-char → pas de frontière).
 */
function indexColumnLists(sql: string, table: string): Set<string> {
  const re = new RegExp(
    `create\\s+(?:unique\\s+)?index\\b[^(;]*?\\bon\\s+(?:public\\.)?${table}\\b[^(;]*?\\(((?:[^()]|\\([^()]*\\))*)\\)`,
    "g",
  );
  const out = new Set<string>();
  for (const m of sql.matchAll(re)) out.add(m[1].replace(/\s+/g, " ").trim());
  return out;
}

describe("staging-create est un superset des index prod (annuaire_ameli)", () => {
  it("chaque liste de colonnes d'index prod existe à l'identique dans la staging-create", () => {
    const stagingBody = latestFunctionBody("ingest_create_annuaire_ameli_staging");
    expect(stagingBody.length).toBeGreaterThan(0);

    const prodCols = indexColumnLists(allMigrationsSql(), "annuaire_ameli");
    const stagingCols = indexColumnLists(stagingBody, "annuaire_ameli_staging");

    // Sanity : geog + 5 base + 2 composites + covering => au moins 6 distincts.
    expect(prodCols.size).toBeGreaterThanOrEqual(6);
    expect(stagingCols.size).toBeGreaterThanOrEqual(prodCols.size);

    const missing = [...prodCols].filter((c) => !stagingCols.has(c));
    expect(
      missing,
      `Index prod sur annuaire_ameli absents (par liste de colonnes normalisée) de ingest_create_annuaire_ameli_staging() — seront PERDUS au prochain swap hebdo → retour timeout 57014 : ${JSON.stringify(missing)}`,
    ).toEqual([]);

    // Defense "fail loud" : ce garde-fou ne compare QUE la liste de colonnes
    // clé. Un index partiel (`WHERE ...`) ou couvrant (`INCLUDE (...)`) sur
    // annuaire_ameli normaliserait à la même clé que sa version sans
    // clause → collision silencieuse (prod ≠ staging mais test vert). Aucun
    // index actuel n'utilise WHERE/INCLUDE ; si un futur en introduit un, ce
    // test échoue ICI pour forcer l'upgrade du garde-fou AVANT le merge.
    const sql = allMigrationsSql();
    const richIndex =
      /create\s+(?:unique\s+)?index\b[^;]*?\bon\s+(?:public\.)?annuaire_ameli\b[^;]*?\b(where|include)\b/i;
    expect(
      richIndex.test(sql),
      "Un index annuaire_ameli utilise WHERE/INCLUDE : indexColumnLists ne compare que la clé → upgrade staging-parity (capturer la clause) avant de merger ce nouvel index.",
    ).toBe(false);
  });
});

describe("staging-create est un superset des index prod (rpps)", () => {
  it("chaque liste de colonnes d'index prod rpps existe à l'identique dans ingest_create_rpps_staging()", () => {
    // Généralisation V0.10.2 du garde-fou à la table RPPS (2,23 M lignes).
    // Même classe de bug que annuaire_ameli : un index perf-critique ajouté
    // sur `rpps` mais non répliqué dans `ingest_create_rpps_staging()` est
    // PERDU au swap mensuel → ex. perte de `rpps_insee_idx` =
    // re-régression P0 `rpps_in_radius` (le LATERAL early-stop V0.10.2 en
    // dépend) ou de `rpps_geog_gist` = timeout sur les autres RPC géo.
    //
    // Limite connue & ACCEPTÉE (différente du bloc annuaire_ameli) : `rpps`
    // a des index couvrants (INCLUDE) et partiels (WHERE) légitimes
    // (covering V0.5.4, pending_enrichment). `indexColumnLists` ne compare
    // que la liste de colonnes CLÉ (la clause INCLUDE/WHERE est hors du 1er
    // groupe de parenthèses, ignorée). Une divergence INCLUDE/WHERE seule
    // dégrade les perfs sans casser (≠ classe 57014 catastrophique d'une
    // clé perdue). On n'assert donc PAS l'absence de WHERE/INCLUDE ici.
    const stagingBody = latestFunctionBody("ingest_create_rpps_staging");
    expect(stagingBody.length).toBeGreaterThan(0);

    const prodCols = indexColumnLists(allMigrationsSql(), "rpps");
    const stagingCols = indexColumnLists(stagingBody, "rpps_staging");

    // Sanity : geog gist + rpps_id + dept + profession + mode + num_finess
    // + savoir_faire + insee + composites => largement > 8 distincts.
    expect(prodCols.size).toBeGreaterThanOrEqual(8);
    expect(stagingCols.size).toBeGreaterThanOrEqual(prodCols.size);

    const missing = [...prodCols].filter((c) => !stagingCols.has(c));
    expect(
      missing,
      `Index prod sur rpps absents (par liste de colonnes clé) de ingest_create_rpps_staging() — seront PERDUS au prochain swap mensuel → re-régression timeout 57014 (rpps_in_radius dépend de rpps_insee_idx) : ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });
});

describe("matviews refresh par les scripts d'ingest sont whitelistées", () => {
  it("toute matview connue refresh post-swap est dans le tuple NOT IN (...) de ingest_refresh_matview", () => {
    const body = latestFunctionBody("ingest_refresh_matview");
    expect(body.length).toBeGreaterThan(0);

    // Extrait UNIQUEMENT le tuple de la whitelist `not in ( ... )` — pas un
    // scan substring du corps entier (le COMMENT et le message RAISE
    // énumèrent aussi les noms → un nom retiré du IN mais resté dans le
    // commentaire passerait à tort).
    const m = body.match(/not\s+in\s*\(([^)]*)\)/);
    expect(m, "tuple `not in (...)` introuvable dans ingest_refresh_matview").not.toBeNull();
    const whitelist = new Set(
      (m as RegExpMatchArray)[1].split(",").map((s) => s.replace(/['"\s]/g, "")),
    );

    const referenced = new Set<string>();
    for (const f of readdirSync(ingestDir).filter(
      (n) => n.endsWith(".ts") && !n.endsWith(".test.ts"),
    )) {
      const src = readFileSync(`${ingestDir}/${f}`, "utf8");
      if (!src.includes("ingest_refresh_matview")) continue;
      // Suffixe `_stats` (agrégats RPPS/Ameli) OU `_centroids` (V0.10.2
      // rpps_commune_centroids). Élargir ce groupe à chaque nouvelle famille
      // de matview refresh par un ingest, sinon faux négatif silencieux.
      for (const mm of src.matchAll(/["'`]([a-z_]+_(?:stats|centroids))["'`]/g))
        referenced.add(mm[1]);
    }

    // Ancres explicites : si un refactor renommait/interpolait un nom de
    // matview en échappant à la regex de découverte, `referenced` se
    // viderait et le filtre n'assurerait plus rien (faux négatif). On
    // épingle les 3 matviews du contrat (Ameli V0.10.1 + RPPS V0.8/V0.9).
    for (const anchor of [
      "ameli_nomenclature_stats",
      "rpps_savoir_faire_stats",
      "rpps_count_stats",
      "rpps_commune_centroids",
    ]) {
      expect(referenced.has(anchor), `matview ${anchor} non détectée dans les scripts ingest`).toBe(
        true,
      );
    }

    const notWhitelisted = [...referenced].filter((mv) => !whitelist.has(mv));
    expect(
      notWhitelisted,
      `Matviews refresh par un script ingest mais absentes de la whitelist ingest_refresh_matview (→ 22023 à chaque ingest) : ${JSON.stringify(notWhitelisted)}`,
    ).toEqual([]);
  });
});
