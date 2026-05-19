import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  functionBodyInFile,
  ingestDir,
  latestFunctionBodyLoose as latestFunctionBody,
  latestFunctionDef,
} from "./migration-sql.js";

// Garde-fou structurel SANS DB — fix C du désamorçage cron RPPS.
//
// Classe de bug visée (PROUVÉE prod 2026-05-18, run #26046475566 + lecture
// seule) : `ingest_apply_rpps_finess_enrichment_batch` (UPDATE par batch
// LEFT JOIN finess, appelée par le cron via supabase-js clé SERVICE_ROLE →
// PostgREST → rôle `service_role`). Faits prod :
//   - `pg_roles` : `service_role` rolconfig=NULL → hérite de `authenticator`
//     `statement_timeout=8s` (doc Supabase officielle) ;
//   - la fonction (def `20260509T210000`) n'a AUCUN `SET statement_timeout`
//     fonction — SEULE RPC longue du projet sans (toutes les autres en ont
//     un : `ingest_rebuild_rpps_matviews` '10min', matviews '10min', etc.) ;
//   - aucun `ANALYZE rpps_staging` entre le bulk COPY (~2,24M lignes) et le
//     1er batch d'enrichment → planner aveugle → plan dégradé → batch ≫ 8s
//     → SQLSTATE 57014 en phase `validate`, AVANT le swap (déterministe).
//   Retrait des index BAN (fix A) PROUVÉ insuffisant (G6 même échec).
//
// Invariants garantis ici (C, conjoint avec A+B déjà en prod) :
//  C1 — la DERNIÈRE def de `ingest_apply_rpps_finess_enrichment_batch` a un
//       `SET statement_timeout` fonction, valeur ≤ 55s (sous le cap
//       passerelle PostgREST ~60s : un 57014 propre/diagnosticable plutôt
//       qu'un timeout passerelle opaque — gotcha CLAUDE.md connu) ;
//  C1b— corps verbatim de `20260509T210000` (seul le header change ;
//       anti-drift : un changement de logique d'enrichment sans MAJ de la
//       migration canonique = test rouge avant merge) ;
//  C2 — RPC `ingest_analyze_rpps_staging` qui `ANALYZE rpps_staging`,
//       appelée par `rpps.ts` AVANT l'enrichment (defense-in-depth :
//       statistiques fraîches post-COPY → bon plan dès le 1er batch).

const migrationsDir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

const ENRICH = "ingest_apply_rpps_finess_enrichment_batch";
const CANONICAL_MIGRATION = "20260509T210000_rpps_v051_relax_constraints.sql";

/**
 * `SET statement_timeout` d'une déf de fonction, NORMALISÉ en secondes.
 * L'invariant testé est « durée effective ≤ 55s » (pas la chaîne `'55s'`) :
 * Postgres accepte `'<n>s'` / `'<n>min'` / `'<n>ms'` / entier nu (= ms).
 * `null` = clause absente/illisible. Évite un faux rouge trompeur si un
 * mainteneur exprime la même durée dans une autre unité.
 */
function timeoutSeconds(def: string): number | null {
  const m = def.match(/set\s+statement_timeout\s*(?:to|=)\s*'?\s*(\d+)\s*(ms|s|min|h)?\s*'?/i);
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

describe("fix C : enrichment FINESS — statement_timeout fonction + ANALYZE staging", () => {
  it("C1 — ingest_apply_rpps_finess_enrichment_batch a un SET statement_timeout fonction", () => {
    const def = latestFunctionDef(ENRICH);
    expect(def.length, `def ${ENRICH} introuvable dans les migrations`).toBeGreaterThan(0);
    expect(
      def,
      `${ENRICH} n'a pas de SET statement_timeout fonction → hérite du budget service_role→authenticator 8s → 57014 déterministe en validate (cron RPPS cassé)`,
    ).toMatch(/set\s+statement_timeout/i);
  });

  it("C1 — la valeur de statement_timeout est ≤ 55s (sous le cap PostgREST ~60s)", () => {
    const secs = timeoutSeconds(latestFunctionDef(ENRICH));
    expect(
      secs,
      `SET statement_timeout absent/illisible dans ${ENRICH} (attendu '<n>s' | '<n>min' | …)`,
    ).not.toBeNull();
    expect(
      secs as number,
      `statement_timeout=${secs}s : doit être >0 et ≤55s (>60s = coupé par la passerelle PostgREST en timeout opaque avant le 57014 propre)`,
    ).toBeGreaterThan(0);
    expect(secs as number).toBeLessThanOrEqual(55);
  });

  it("C2b — ingest_analyze_rpps_staging a aussi un SET statement_timeout ≤ 55s (pas de ré-héritage du 8s racine)", () => {
    const def = latestFunctionDef("ingest_analyze_rpps_staging");
    expect(def.length, "déf ingest_analyze_rpps_staging introuvable").toBeGreaterThan(0);
    const secs = timeoutSeconds(def);
    expect(
      secs,
      "ingest_analyze_rpps_staging SANS SET statement_timeout → ré-hérite du budget racine 8s service_role→authenticator ; un ANALYZE lent à froid re-casse le cron une étape plus tôt",
    ).not.toBeNull();
    expect(secs as number).toBeGreaterThan(0);
    expect(secs as number).toBeLessThanOrEqual(55);
  });

  it("C1b — corps de l'enrichment verbatim vs la migration canonique 20260509T210000 (anti-drift)", () => {
    const cMigration = readdirSync(migrationsDir).find(
      (f) => f.startsWith("20260518T160000") && f.endsWith(".sql"),
    );
    expect(
      cMigration,
      "migration C 20260518T160000*.sql absente (CREATE OR REPLACE ingest_apply_rpps_finess_enrichment_batch + SET statement_timeout)",
    ).toBeDefined();

    const canonicalBody = functionBodyInFile(CANONICAL_MIGRATION, ENRICH);
    const cBody = functionBodyInFile(cMigration as string, ENRICH);
    expect(canonicalBody.length, "corps canonique 20260509T210000 introuvable").toBeGreaterThan(0);
    expect(
      cBody.length,
      "corps de l'enrichment introuvable dans la migration C (regex/délimiteur $$ cassé) — comparaison verbatim non significative",
    ).toBeGreaterThan(0);
    expect(
      cBody,
      "corps de l'enrichment dans la migration C diverge du canonique 20260509T210000 (drift de logique d'enrichment = données fausses). Seul le header doit changer (SET statement_timeout).",
    ).toBe(canonicalBody);
  });

  it("C2 — ingest_analyze_rpps_staging existe et fait ANALYZE rpps_staging", () => {
    const body = latestFunctionBody("ingest_analyze_rpps_staging");
    expect(
      body.length,
      "fonction ingest_analyze_rpps_staging absente — pas d'ANALYZE post-COPY → planner aveugle → plan dégradé 1er batch",
    ).toBeGreaterThan(0);
    expect(body, "ingest_analyze_rpps_staging ne fait pas ANALYZE rpps_staging").toMatch(
      /analyze\s+rpps_staging/i,
    );
  });

  it("C2 — rpps.ts appelle ingest_analyze_rpps_staging AVANT l'enrichment", () => {
    const src = readFileSync(`${ingestDir}/rpps.ts`, "utf8");
    // Ancrer sur les LITTÉRAUX d'appel `"<rpc>"` (double quotes) — pas une
    // mention en JSDoc (backticks) qui fausserait l'ordre.
    const iAnalyze = src.indexOf('"ingest_analyze_rpps_staging"');
    const iEnrich = src.indexOf(`"${ENRICH}"`);
    expect(iAnalyze, "rpps.ts n'appelle pas la RPC ingest_analyze_rpps_staging").toBeGreaterThan(
      -1,
    );
    expect(iEnrich, `rpps.ts n'appelle pas la RPC ${ENRICH}`).toBeGreaterThan(-1);
    expect(
      iAnalyze,
      "l'appel ingest_analyze_rpps_staging doit précéder l'appel d'enrichment (stats fraîches post-COPY = bon plan dès le 1er batch)",
    ).toBeLessThan(iEnrich);
  });
});

// Refonte ban_join (2026-05-19, cf. docs/plans/2026-05-19-ban-join-design.md) :
// `ingest_apply_rpps_ban_join_batch` est la RPC d'application cache→staging du
// cron (appelée via supabase-js clé SERVICE_ROLE → PostgREST → rôle
// `service_role` rolconfig=NULL → hérite `authenticator` 8s). MÊME classe de
// bug que l'enrichment FINESS : sans `SET statement_timeout` fonction, un lot
// sur ~1,29M lignes éligibles dépasse 8s → 57014 déterministe en validate
// (cron cassé). Même invariant que C1, étendu à ban_join.
const BANJOIN = "ingest_apply_rpps_ban_join_batch";

describe("ban_join — statement_timeout fonction ≤ 55s (parité invariant fix C)", () => {
  it("ingest_apply_rpps_ban_join_batch a un SET statement_timeout fonction", () => {
    const def = latestFunctionDef(BANJOIN);
    expect(def.length, `def ${BANJOIN} introuvable dans les migrations`).toBeGreaterThan(0);
    expect(
      def,
      `${BANJOIN} n'a pas de SET statement_timeout fonction → hérite du budget service_role→authenticator 8s → 57014 déterministe en validate (cron RPPS cassé)`,
    ).toMatch(/set\s+statement_timeout/i);
  });

  it("la valeur de statement_timeout est ≤ 55s (sous le cap passerelle PostgREST ~60s)", () => {
    const secs = timeoutSeconds(latestFunctionDef(BANJOIN));
    expect(
      secs,
      `SET statement_timeout absent/illisible dans ${BANJOIN} (attendu '<n>s' | '<n>min' | …)`,
    ).not.toBeNull();
    expect(
      secs as number,
      `statement_timeout=${secs}s : doit être >0 et ≤55s (>60s = coupé par la passerelle PostgREST en timeout opaque avant le 57014 propre)`,
    ).toBeGreaterThan(0);
    expect(secs as number).toBeLessThanOrEqual(55);
  });
});

// Phase 1 mesure (2026-05-20) : rpps_measure_ban_to_geocode est appelée par
// le cron via supabase-js → PostgREST → service_role (rolconfig=NULL, hérite
// authenticator 8s). Même profil que ban_join → MÊME garde-fou ≤55s aligné
// sur le pattern projet. Best-effort caller (Phase 1 = observabilité, pas
// gating), mais la garde-anti-drift reste pour éviter qu'un futur refactor
// retire le SET sans qu'une mesure dégradée passe inaperçue.
const MEASURE = "rpps_measure_ban_to_geocode";

describe("rpps_measure_ban_to_geocode — statement_timeout fonction ≤ 55s (parité invariant fix C)", () => {
  it("rpps_measure_ban_to_geocode a un SET statement_timeout fonction", () => {
    const def = latestFunctionDef(MEASURE);
    expect(def.length, `def ${MEASURE} introuvable dans les migrations`).toBeGreaterThan(0);
    expect(
      def,
      `${MEASURE} n'a pas de SET statement_timeout fonction → hérite du budget service_role→authenticator 8s → mesure systématiquement dégradée silencieusement (Phase 2 dimensionnée sur des NULL)`,
    ).toMatch(/set\s+statement_timeout/i);
  });

  it("la valeur de statement_timeout est ≤ 55s (sous le cap passerelle PostgREST ~60s)", () => {
    const secs = timeoutSeconds(latestFunctionDef(MEASURE));
    expect(
      secs,
      `SET statement_timeout absent/illisible dans ${MEASURE} (attendu '<n>s' | '<n>min' | …)`,
    ).not.toBeNull();
    expect(
      secs as number,
      `statement_timeout=${secs}s : doit être >0 et ≤55s (>60s = coupé par la passerelle PostgREST en timeout opaque avant le 57014 propre)`,
    ).toBeGreaterThan(0);
    expect(secs as number).toBeLessThanOrEqual(55);
  });
});
