import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allMigrationsSql,
  ingestDir,
  latestFunctionBody as latestFunctionBodyStrict,
} from "./migration-sql.js";

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

// `allMigrationsSql` + `ingestDir` importés du module union `migration-sql.ts`
// (lecteur disque UNIQUE partagé). `latestFunctionBody` ci-dessous reste
// VOLONTAIREMENT local et à regex lâche : fonctions d'ingestion anciennes
// (`ingest_create_annuaire_ameli_staging`, `ingest_refresh_matview`) en `$$`
// sans tag — la forme stricte ancrée du module (`latestFunctionBody`) ne les
// matcherait pas (≡ `latestFunctionBodyLoose` du module, gardé séparé ici par
// prudence : ce guard est le filet anti-perte d'index au swap, ne pas le
// coupler naïvement — cf. CLAUDE.md gotchas).

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
  for (const m of allMigrationsSql().matchAll(re)) body = m[1] ?? "";
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

/**
 * Listes de colonnes des index prod RÉELLEMENT VIVANTS sur `<table>` après
 * application de toutes les migrations : `CREATE INDEX` capturé PAR NOM, puis
 * retiré du set si une migration ultérieure `DROP INDEX <nom>` le supprime.
 *
 * Sans ça (post-mortem dette #3, 2026-05-16), `indexColumnLists` retient un
 * index créé PUIS droppé (ex. `rpps_insee_idx (code_insee)` retiré car
 * redondant avec `(code_insee, id)`, ou `rpps_profession_savoir_faire_partial_idx`
 * remplacé par une matview) : il l'exigerait à tort dans la staging-create →
 * faux NÉGATIF inverse (le garde-fou réclame un index qu'on a sciemment
 * supprimé, bloquant un DROP légitime). On rejoue create/drop dans l'ordre
 * d'application (= ordre de concaténation des fichiers triés).
 *
 * `DROP INDEX` n'est pas table-scopé en Postgres (nom global) : on ne
 * supprime que les noms qu'on suit pour cette table, les autres sont no-op.
 * Une recréation par le swap mensuel (staging-create) n'est PAS visible ici
 * (c'est un RENAME runtime, pas un `CREATE INDEX ON <table>`) — correct : ce
 * que ce set modélise, ce sont les index déclarés en dur sur la prod par
 * migration, qui DOIVENT être mirrorés dans staging-create pour survivre.
 *
 * `dropRe` est ANCRÉ sur le `;` terminal (+ `cascade`/`restrict` optionnel) :
 * `allMigrationsSql()` concatène les commentaires `--` et littéraux
 * `COMMENT ON` (lowercased). Sans cette ancre, une PROSE de header WHY type
 * « we drop index rpps_geog_gist someday » dé-trackerait silencieusement un
 * index VIVANT perf-critique → faux négatif (le garde-fou cesse de l'exiger
 * en staging) = exactement la classe de bug que ce fichier combat. `createRe`
 * est auto-protégé (exige `on <table> (cols)`), pas `dropRe` → ancre requise.
 * LIMITE ASSUMÉE : forme multi-noms `DROP INDEX a, b;` non gérée (seul `a`
 * est capturé, `b` resterait tracké) — aucune migration ne l'utilise ; si un
 * jour oui, ce commentaire signale qu'il faut étendre le parsing.
 */
function liveIndexColumnLists(sql: string, table: string): Set<string> {
  const createRe = `create\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?([a-z_][a-z0-9_]*)\\s+on\\s+(?:public\\.)?${table}\\b[^(;]*?\\(((?:[^()]|\\([^()]*\\))*)\\)`;
  const dropRe =
    "drop\\s+index\\s+(?:concurrently\\s+)?(?:if\\s+exists\\s+)?([a-z_][a-z0-9_]*)\\s*(?:cascade|restrict)?\\s*;";
  const re = new RegExp(`(?:${createRe})|(?:${dropRe})`, "g");
  // name → liste de colonnes normalisée (dernier CREATE gagne ; DROP retire).
  const live = new Map<string, string>();
  for (const m of sql.matchAll(re)) {
    const createName = m[1];
    const createCols = m[2];
    const dropName = m[3];
    if (createName !== undefined && createCols !== undefined) {
      live.set(createName, createCols.replace(/\s+/g, " ").trim());
    } else if (dropName !== undefined) {
      live.delete(dropName);
    }
  }
  return new Set(live.values());
}

describe("staging-create est un superset des index prod (annuaire_ameli)", () => {
  it("chaque liste de colonnes d'index prod existe à l'identique dans la staging-create", () => {
    const stagingBody = latestFunctionBody("ingest_create_annuaire_ameli_staging");
    expect(stagingBody.length).toBeGreaterThan(0);

    const prodCols = liveIndexColumnLists(allMigrationsSql(), "annuaire_ameli");
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
    // annuaire_ameli normaliserait à la même clé que sa version sans clause
    // → collision silencieuse (prod ≠ staging mais test vert). Plutôt que
    // bloquer TOUT WHERE/INCLUDE, on whitelist les index connus dont la
    // clause est gardée par une assertion DÉDIÉE plus bas (forme positive).
    // Tout NOUVEL index `(... WHERE ...)` ou `(... INCLUDE ...)` non
    // whitelisté échoue ici pour forcer l'auteur à ajouter sa garde dédiée
    // AVANT de merger.
    const sql = allMigrationsSql();
    const richIndexRe =
      /create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)[^;]*?\bon\s+(?:public\.)?annuaire_ameli\b[^;]*?\b(where|include)\b[^;]*;/gi;
    /**
     * Index rich (WHERE/INCLUDE) connus + audités. CHACUN exige une assertion
     * dédiée plus bas qui compare la clause prod ↔ staging-create. Ajouter à
     * cette liste = engagement à écrire la garde correspondante.
     */
    const KNOWN_RICH_AMELI_INDEXES = new Set([
      "annuaire_ameli_geog_precise_gist", // Chantier C — prédicat ban_address (garde-fou dédié ci-dessous)
    ]);
    const unknownRich = [...sql.matchAll(richIndexRe)]
      .map((m) => m[1])
      .filter((name) => !KNOWN_RICH_AMELI_INDEXES.has(name));
    expect(
      unknownRich,
      `Index annuaire_ameli avec WHERE/INCLUDE non whitelistés : ${unknownRich.join(", ")} — indexColumnLists ne compare que la clé → ajouter à KNOWN_RICH_AMELI_INDEXES + écrire la garde dédiée comparant la clause prod ↔ staging-create AVANT de merger.`,
    ).toEqual([]);
  });

  it("tout GiST annuaire_ameli_staging(geog) PARTIEL porte le prédicat `geom_source = 'ban_address'`", () => {
    // Chantier C 2026-05-21 — symétrique du garde-fou RPPS (ci-dessous) :
    // un GiST partiel `annuaire_ameli_geog_precise_gist` posé sur la prod
    // doit avoir son JUMEAU staging-create avec un prédicat byte-identique.
    // Sinon le RENAME du swap reverte le partiel staging en index "anonyme"
    // sans clause → la branche `precise` future des tools radius perdrait
    // son index → 57014 zone dense (cluster co-localisé au centroïde
    // commune, même classe de bug que RPPS 2026-05-19).
    //
    // ≠ assertion RPPS : Ameli a 2 GiST geog en staging (le global hérité
    // V0.4 phase 1 + le partiel Chantier C). On asserte la présence du
    // partiel ET son prédicat, on ne demande PAS que TOUT GiST geog soit
    // partiel (le global reste légitime tant que le backfill BAN n'a pas
    // peuplé majoritairement le partiel).
    //
    // Lecteur STRICT du module + `stripComments: true` (silent-failure
    // hunter M-3 Passe 1) : ferme le faux vert « prédicat en commentaire
    // `-- CREATE INDEX ... WHERE geom_source = 'ban_address';` » qu'un
    // mainteneur pourrait introduire en croyant doc inoffensive — le
    // lecteur lâche local le matcherait comme une vraie ligne.
    const stagingBody = latestFunctionBodyStrict(
      allMigrationsSql(),
      "ingest_create_annuaire_ameli_staging",
      { stripComments: true },
    );
    expect(
      stagingBody.length,
      "def ingest_create_annuaire_ameli_staging introuvable via le lecteur STRICT — garde-fou inerte, investiguer AVANT de merger.",
    ).toBeGreaterThan(0);

    const partialPredicate = /where\s+geom_source\s+=\s+'ban_address'/i;
    const geogGistOnStaging =
      /create\s+index\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s+on\s+(?:public\.)?annuaire_ameli_staging\s+using\s+gist\s*\(\s*geog\s*\)([^;]*);/gi;
    const matches = [...stagingBody.matchAll(geogGistOnStaging)];

    const precise = matches.filter((m) => m[1] === "annuaire_ameli_staging_geog_precise_gist");
    expect(
      precise.length,
      "ingest_create_annuaire_ameli_staging ne crée PAS l'index `annuaire_ameli_staging_geog_precise_gist` → la branche precise des tools radius perdra son index au prochain swap.",
    ).toBe(1);
    expect(
      partialPredicate.test(precise[0][2]),
      `annuaire_ameli_staging_geog_precise_gist SANS le prédicat partiel \`WHERE geom_source = 'ban_address'\` → swap le transforme en GiST global → la branche precise ramène le cluster commune_centroid → 57014 zone dense. Trouvé : ${precise[0][0].replace(/\s+/g, " ").trim()}`,
    ).toBe(true);

    // Parité consommateur croisée : la migration prod (20260521T100000) et la
    // staging-create doivent porter le MÊME prédicat. Capture le prédicat sur
    // chaque côté puis compare normalisé.
    const prodSql = allMigrationsSql();
    const prodGistRe =
      /create\s+index\s+(?:if\s+not\s+exists\s+)?annuaire_ameli_geog_precise_gist\s+on\s+(?:public\.)?annuaire_ameli\s+using\s+gist\s*\(\s*geog\s*\)([^;]*);/i;
    const prodMatch = prodSql.match(prodGistRe);
    expect(
      prodMatch,
      "Migration prod `annuaire_ameli_geog_precise_gist` introuvable → la branche precise des tools radius n'a aucun index spatial → 57014 zone dense.",
    ).not.toBeNull();

    const normalize = (s: string) => s.replace(/\s+/g, " ").toLowerCase().trim();
    expect(
      normalize(prodMatch?.[1] ?? ""),
      "Prédicat de `annuaire_ameli_geog_precise_gist` divergent entre prod et staging-create → swap perdra le prédicat → re-régression 57014.",
    ).toBe(normalize(precise[0][2]));
  });
});

describe("staging-create est un superset des index prod (rpps)", () => {
  it("chaque liste de colonnes d'index prod rpps existe à l'identique dans ingest_create_rpps_staging()", () => {
    // Généralisation V0.10.2 du garde-fou à la table RPPS (2,23 M lignes).
    // Même classe de bug que annuaire_ameli : un index perf-critique ajouté
    // sur `rpps` mais non répliqué dans `ingest_create_rpps_staging()` est
    // PERDU au swap mensuel → ex. perte de `rpps_insee_id_idx (code_insee, id)`
    // = re-régression P0 `rpps_in_radius` (le LATERAL early-stop V0.10.2 en
    // dépend) ou de `rpps_geog_gist` = timeout sur les autres RPC géo. Le
    // garde-fou compare le set prod VIVANT (DROP honoré) — un index
    // sciemment supprimé (ex. `rpps_insee_idx` mono-colonne, dette #3) n'est
    // donc plus exigé dans la staging-create.
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

    const prodCols = liveIndexColumnLists(allMigrationsSql(), "rpps");
    const stagingCols = indexColumnLists(stagingBody, "rpps_staging");

    // Sanity : geog gist + rpps_id + dept + profession + mode + num_finess
    // + savoir_faire + insee + composites => largement > 8 distincts.
    expect(prodCols.size).toBeGreaterThanOrEqual(8);
    expect(stagingCols.size).toBeGreaterThanOrEqual(prodCols.size);

    const missing = [...prodCols].filter((c) => !stagingCols.has(c));
    expect(
      missing,
      `Index prod sur rpps absents (par liste de colonnes clé) de ingest_create_rpps_staging() — seront PERDUS au prochain swap mensuel → re-régression timeout 57014 (rpps_in_radius dépend de rpps_insee_id_idx) : ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  it("tout GiST rpps_staging(geog) de staging-create porte le prédicat partiel precise", () => {
    // Post-mortem 2026-05-19 (prouvé prod, RÉFUTE la « limite assumée » du
    // bloc « superset rpps » ci-dessus : une divergence WHERE sur CE GiST
    // EST catastrophique, pas seulement perf). La prod vivante a
    // `rpps_geog_precise_gist` (partiel, `WHERE geom_source IN
    // ('finess_join','ban_address')`) : la migration `20260516T050000` DROP
    // le global `rpps_geog_gist` et CREATE le partiel. La branche `precise`
    // de `rpps_in_radius` (hybride) DOIT passer par ce partiel — sinon le
    // GiST GLOBAL ramène le cluster co-localisé `commune_centroid` (76 940
    // lignes au centroïde Paris, prouvé : 77 381 lignes dans le bbox 1 km
    // dont 76 940 jetées en Filter) → 57014.
    //
    // Le guard `indexColumnLists` ci-dessus est AVEUGLE à cette divergence
    // (global `(geog)` et partiel `(geog) WHERE …` normalisent à la même
    // liste de colonnes `geog`, la clause WHERE étant hors du 1er groupe de
    // parenthèses) — assertion dédiée requise, comme le bloc annuaire_ameli
    // l'exige via `richIndex` pour sa propre classe de collision silencieuse.
    //
    // Forme POSITIVE (capturer TOUT GiST `(geog)` et exiger le prédicat sur
    // CHACUN), et non « chercher la forme négative exacte du global » : une
    // regex négative ratait `IF NOT EXISTS` / `public.` / `WITH (...)` /
    // coexistence partiel+global → test vert alors que le global est
    // réintroduit = exactement la classe de faux négatif silencieux qui a
    // causé la régression d'origine (revue silent-failure-hunter P1/P4).
    //
    // Lecteur = `latestFunctionBody` STRICT du module (PAS le local lâche) :
    //  - `stripComments:true` retire les `-- …` AVANT match → ferme le faux
    //    VERT « prédicat en commentaire inline avant le `;` » (sfh Passe 2 R1) ;
    //  - délimiteur tag-aware (back-ref `\1`, `$$` OU `$body$`) → ferme le
    //    faux VERT « def future en dollar-quote taggé → corps mort capturé »
    //    pour staging-create ET rpps_in_radius (sfh Passe 2 R2/R3). Rend la
    //    rustine regex `taggedStagingDef` inutile (supprimée). Le local lâche
    //    reste pour les `it()` legacy (fonctions anciennes non taggées).
    const stagingBody = latestFunctionBodyStrict(allMigrationsSql(), "ingest_create_rpps_staging", {
      stripComments: true,
    });
    expect(
      stagingBody.length,
      "def ingest_create_rpps_staging introuvable/vide via le lecteur STRICT — garde-fou anti-régression-57014 muet : investiguer AVANT de merger.",
    ).toBeGreaterThan(0);

    const partialPredicate =
      /where\s+geom_source\s+in\s*\(\s*'finess_join'\s*,\s*'ban_address'\s*\)/;
    // `[^;]*` borne le tail au `;` du statement : tolère `if not exists`,
    // `public.`, un nom quelconque, et une clause `with (...)` éventuelle.
    const geogGistOnStaging =
      /create\s+index\s+(?:if\s+not\s+exists\s+)?\w+\s+on\s+(?:public\.)?rpps_staging\s+using\s+gist\s*\(\s*geog\s*\)([^;]*);/g;
    const geogGists = [...stagingBody.matchAll(geogGistOnStaging)];

    expect(
      geogGists.length,
      "ingest_create_rpps_staging() ne crée AUCUN GiST sur rpps_staging(geog) → la branche `precise` de rpps_in_radius n'a aucun index spatial → seq scan / 57014 en commune dense.",
    ).toBeGreaterThanOrEqual(1);

    for (const m of geogGists) {
      expect(
        partialPredicate.test(m[1]),
        `Un GiST sur rpps_staging(geog) SANS le prédicat partiel \`WHERE geom_source IN ('finess_join','ban_address')\` → au swap il devient un GiST GLOBAL \`rpps_geog_gist\` → re-régression 57014 de rpps_in_radius en commune dense (cluster co-localisé non élagué) : ${m[0].replace(/\s+/g, " ").trim()}`,
      ).toBe(true);
    }

    // Parité CONSOMMATEUR (revue silent-failure-hunter P2) : le prédicat du
    // GiST partiel n'est utile au planner que s'il matche EXACTEMENT le WHERE
    // de la CTE `precise` de `rpps_in_radius`. Sans cette assertion croisée,
    // la « byte-identité » revendiquée n'est qu'une affirmation en commentaire
    // (tautologie verte) : si le prédicat de rpps_in_radius dérive, staging
    // et guard restent cohérents entre eux mais divergent silencieusement de
    // la fonction qui consomme l'index → planner ignore le partiel → 57014.
    const rppsInRadiusBody = latestFunctionBodyStrict(allMigrationsSql(), "rpps_in_radius", {
      stripComments: true,
    });
    expect(
      rppsInRadiusBody.length,
      "def rpps_in_radius introuvable/vide via le lecteur STRICT — parité prédicat NON vérifiable, garde-fou muet : investiguer AVANT de merger.",
    ).toBeGreaterThan(0);
    expect(
      /geom_source\s+in\s*\(\s*'finess_join'\s*,\s*'ban_address'\s*\)/.test(rppsInRadiusBody),
      "La CTE `precise` de rpps_in_radius n'utilise plus exactement `geom_source IN ('finess_join','ban_address')` : le prédicat du GiST partiel staging-create ne le matche plus → planner juge le partiel inutilisable → 57014. Re-synchroniser staging-create + index 20260516T050000 + rpps_in_radius ENSEMBLE.",
    ).toBe(true);
  });
});

describe("liveIndexColumnLists honore DROP INDEX (dette #3)", () => {
  it("rpps_insee_idx (code_insee) droppé → 'code_insee' seul SORT du set prod vivant", () => {
    const sql = allMigrationsSql();
    const live = liveIndexColumnLists(sql, "rpps");
    // L'index mono-colonne a bien été créé puis droppé : il ne doit plus
    // être réclamé par le garde-fou (sinon il bloque un DROP légitime).
    expect(sql).toContain("drop index if exists rpps_insee_idx");
    expect(live.has("code_insee")).toBe(false);
    // Le composite qui le remplace, lui, reste vivant (jamais droppé).
    expect(live.has("code_insee, id")).toBe(true);
  });

  it("naive (sans DROP) verrait encore 'code_insee' — preuve que la correction est nécessaire", () => {
    const naive = indexColumnLists(allMigrationsSql(), "rpps");
    expect(naive.has("code_insee")).toBe(true);
  });

  it("un index créé puis recréé garde sa DERNIÈRE liste de colonnes", () => {
    const sql = [
      "CREATE INDEX foo_idx ON rpps (a);",
      "DROP INDEX IF EXISTS foo_idx;",
      "CREATE INDEX foo_idx ON rpps (a, b);",
    ]
      .join("\n")
      .toLowerCase();
    const live = liveIndexColumnLists(sql, "rpps");
    expect(live.has("a, b")).toBe(true);
    expect(live.has("a")).toBe(false);
  });

  it("une PROSE de commentaire 'drop index X someday' ne dé-tracke PAS un index vivant", () => {
    const sql = [
      "CREATE INDEX rpps_geog_gist ON rpps USING gist (geog);",
      "-- on pourrait drop index rpps_geog_gist someday mais pas maintenant",
      "-- le DROP de rpps_geog_gist serait catastrophique",
    ]
      .join("\n")
      .toLowerCase();
    const live = liveIndexColumnLists(sql, "rpps");
    expect(live.has("geog")).toBe(true);
  });

  it("DROP INDEX réel (avec ;) dé-tracke même suivi de CASCADE", () => {
    const sql = ["CREATE INDEX bar_idx ON rpps (z);", "DROP INDEX IF EXISTS bar_idx CASCADE;"]
      .join("\n")
      .toLowerCase();
    expect(liveIndexColumnLists(sql, "rpps").has("z")).toBe(false);
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

    // PLUS AUCUNE ancre refresh-only : les 2 dettes « bombe OID » sont closes.
    // RPPS (2026-05-18, ingest_rebuild_rpps_matviews) PUIS Ameli (2026-05-19,
    // ingest_rebuild_ameli_matviews) sont passées de REFRESH-only à
    // RECONSTRUCTION post-swap (une matview FROM table swappée suit l'OID →
    // désync 1er cron + destruction CASCADE 2e cron). Ces invariants rebuild
    // sont gardés par `rpps-matview-rebuild.test.ts` +
    // `ameli-matview-rebuild.test.ts` (chacun asserte que son script
    // n'utilise plus `ingest_refresh_matview`). `referenced` est donc
    // LÉGITIMEMENT vide aujourd'hui : ce test conserve la protection
    // whitelist GÉNÉRIQUE — si une FUTURE matview refresh-only (non FROM
    // table swappée, donc sans bombe OID) est wirée dans un script ingest,
    // elle DEVRA être dans le tuple `not in (...)` de `ingest_refresh_matview`
    // (sinon 22023 à chaque ingest). `notWhitelisted` reste l'assertion
    // load-bearing ; vide ⊆ whitelist = vert tant qu'aucun refresh-only.
    const notWhitelisted = [...referenced].filter((mv) => !whitelist.has(mv));
    expect(
      notWhitelisted,
      `Matviews refresh par un script ingest mais absentes de la whitelist ingest_refresh_matview (→ 22023 à chaque ingest) : ${JSON.stringify(notWhitelisted)}`,
    ).toEqual([]);
  });
});

describe("staging-create est un superset des index prod (iris)", () => {
  it("chaque liste de colonnes d'index prod iris existe à l'identique dans ingest_create_iris_staging()", () => {
    // Phase B étape 1 : les 3 index prod (geog GiST, centroid_geog GiST,
    // code_commune btree) DOIVENT voyager dans `iris` via le RENAME du swap
    // annuel. Aujourd'hui prod-table + staging-create cohabitent dans la même
    // migration (parité triviale), mais ce garde-fou capte la DÉRIVE future :
    // un index ajouté sur `iris` par une migration ultérieure non mirroré dans
    // staging-create serait perdu au prochain swap (régression silencieuse —
    // exactement la classe close pour rpps/ameli).
    const stagingBody = latestFunctionBody("ingest_create_iris_staging");
    expect(stagingBody.length).toBeGreaterThan(0);

    const prodCols = liveIndexColumnLists(allMigrationsSql(), "iris");
    const stagingCols = indexColumnLists(stagingBody, "iris_staging");

    // geog + centroid_geog + code_commune => 3 listes distinctes au minimum.
    expect(prodCols.size).toBeGreaterThanOrEqual(3);
    expect(stagingCols.size).toBeGreaterThanOrEqual(prodCols.size);

    const missing = [...prodCols].filter((c) => !stagingCols.has(c));
    expect(
      missing,
      `Index prod sur iris absents (par liste de colonnes) de ingest_create_iris_staging() — seront PERDUS au prochain swap annuel : ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });
});
