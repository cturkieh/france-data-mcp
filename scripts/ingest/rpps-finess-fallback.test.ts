import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ingestDir, latestFunctionDef, migrationsDir } from "./migration-sql.js";

// Step 5c-bis du cron RPPS — repli FINESS sur les lignes restées
// `commune_centroid` après ban_join (post-mortem + décisions : en-tête de la
// migration 20260905T140000). Garde-fous du CONTRAT SQL et du câblage
// (`rpps.ts`), lus en texte comme les autres gardes structurels du repo.
// Le `SET statement_timeout ≤ 55 s` est gardé dans
// `enrichment-statement-timeout.test.ts` (source unique de cet invariant).

const RPC = "ingest_apply_rpps_finess_centroid_fallback_batch";
const RPPS_SRC = readFileSync(`${ingestDir}/rpps.ts`, "utf8");
const DEF = latestFunctionDef(RPC);
const MIGRATION_SQL = readFileSync(
  `${migrationsDir}/20260905T140000_rpps_finess_centroid_fallback.sql`,
  "utf8",
);

/** Bloc 5c-bis de main() : du marqueur `// 5c-bis.` au marqueur `// 5d.`. */
function step5cBis(): string {
  const a = RPPS_SRC.indexOf("// 5c-bis.");
  const b = RPPS_SRC.indexOf("// 5d.", a);
  expect(a, "marqueur 5c-bis introuvable dans rpps.ts").toBeGreaterThan(0);
  expect(b, "marqueur 5d introuvable après 5c-bis").toBeGreaterThan(a);
  return RPPS_SRC.slice(a, b);
}

describe(`${RPC} — contrat SQL (migration 20260905T140000)`, () => {
  it("existe et est KEYSET (p_after + p_limit → TABLE(last_id, applied)), jamais sentinelle", () => {
    expect(DEF.length, `def ${RPC} introuvable dans supabase/migrations`).toBeGreaterThan(0);
    expect(DEF).toMatch(/p_after\s+bigint/i);
    expect(DEF).toMatch(/p_limit\s+int(eger)?/i);
    expect(DEF).toMatch(/returns\s+table\s*\(\s*last_id\s+bigint\s*,\s*applied\s+int(eger)?\s*\)/i);
    expect(DEF).toMatch(/where\s+id\s*>\s*p_after/i);
    expect(DEF).toMatch(/order\s+by\s+id\s+limit\s+p_limit/i);
    expect(DEF).toMatch(/max\(b\.id\)::bigint/i);
  });

  it("ne cible QUE les centroïdes à num_finess de 9 caractères, sur rpps_staging", () => {
    expect(DEF).toMatch(/geom_source\s*=\s*'commune_centroid'/i);
    expect(DEF).toMatch(/num_finess\s+is\s+not\s+null/i);
    // `::CHAR(9)` TRONQUE en silence : une dérive amont vers 10 caractères
    // matcherait un établissement RÉEL mais FAUX → filtre de longueur.
    expect(DEF).toMatch(/length\(num_finess\)\s*=\s*9/i);
    expect(DEF).toMatch(/from\s+rpps_staging/i);
    expect(DEF).toMatch(/update\s+rpps_staging/i);
    // Jamais la table servie `rpps` nue (le swap est atomique : on ne modifie
    // JAMAIS la table en ligne hors bascule).
    expect(DEF).not.toMatch(/\b(from|update)\s+rpps\b/i);
  });

  it("joint finess par cast EXPLICITE ::CHAR(9) côté texte, MÊME commune, geom FINESS présent", () => {
    // Gotcha CLAUDE.md : `col_char = p_text` caste la COLONNE indexée en text.
    expect(DEF).toMatch(/join\s+finess\s+f/i);
    expect(DEF).toMatch(/f\.num_finess\s*=\s*b\.num_finess::char\(9\)/i);
    // Revue 2026-09-05 (mesuré prod) : 3 857 FINESS dans une AUTRE commune que
    // celle déclarée → exclus, sinon « Dr X, ville B » pointé en A.
    expect(DEF).toMatch(/f\.code_insee\s*=\s*b\.code_insee/i);
    expect(DEF).toMatch(/f\.geom\s+is\s+not\s+null/i);
  });

  it("pose EXACTEMENT geom + geom_source='finess_join' (commune déclarée inchangée)", () => {
    // Liste SET verrouillée : ≠ 5b, ici la ligne a déjà sa commune (référence
    // des comptages par commune) ; seul le point change.
    expect(DEF).toMatch(/set\s+geom\s*=\s*f\.geom\s*,\s*geom_source\s*=\s*'finess_join'\s+from/i);
    expect(DEF).toMatch(/returning\s+1/i);
  });

  it("est SECURITY DEFINER, exécutable par service_role seulement", () => {
    expect(DEF).toMatch(/security\s+definer/i);
    expect(MIGRATION_SQL).toMatch(
      new RegExp(
        `revoke\\s+execute\\s+on\\s+function\\s+(?:public\\.)?${RPC}[^;]*from\\s+public`,
        "i",
      ),
    );
    expect(MIGRATION_SQL).toMatch(
      new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+(?:public\\.)?${RPC}[^;]*to\\s+service_role`,
        "i",
      ),
    );
  });
});

describe("rpps.ts — câblage 5c-bis (best-effort, keyset, sans count PostgREST)", () => {
  it("appelle la RPC via runKeysetRpc avec p_limit entier, borne LARGE stats.inserted et timeout par lot", () => {
    const block = step5cBis();
    expect(block).toContain(`"${RPC}"`);
    expect(block).toMatch(/runKeysetRpc\(/);
    expect(block).toMatch(/p_limit:\s*ENRICH_BATCH_SIZE/);
    // Revue 2026-09-05 (mesuré prod) : un COUNT PostgREST nu hérite du budget
    // 8 s et prend 4,4 s sur table PROPRE → 57014 sur la staging ballonnée →
    // run tué avant le swap. Borne large à la place, garde de non-progression.
    expect(block).not.toMatch(/\.from\("rpps_staging"\)/);
    expect(block).toMatch(/stats\.inserted,\s*\n\s*RPC_BATCH_TIMEOUT_MS/);
  });

  it("est BEST-EFFORT : toute erreur → warn LOUD + partial + trace audit, jamais de throw", () => {
    const block = step5cBis();
    expect(block).toMatch(/try \{[\s\S]*runKeysetRpc\([\s\S]*\} catch \(err\) \{/);
    const catchPart = block.slice(block.indexOf("} catch (err) {"));
    expect(catchPart).toMatch(/console\.warn\(/);
    expect(catchPart).toMatch(/log\.status = "partial"/);
    expect(catchPart).toMatch(/appendLogMessage\(log,/);
    expect(catchPart).toMatch(/missingRpcHint\(/);
    expect(block).not.toMatch(/throw new IngestError/);
  });

  it("la sentinelle passe par evaluateFinessFallbackOutcome (pure, testée dans rpps.test.ts)", () => {
    const block = step5cBis();
    expect(block).toMatch(
      /evaluateFinessFallbackOutcome\(\{[\s\S]*applied: fallbackApplied[\s\S]*iterations: fallbackIterations/,
    );
    expect(block).toMatch(/if \(outcome\.partial\) log\.status = "partial"/);
    expect(block).toMatch(
      /if \(outcome\.logMessage\) appendLogMessage\(log, outcome\.logMessage\)/,
    );
  });
});
