import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ingestDir, latestFunctionDef } from "./migration-sql.js";

// Step 5c-bis du cron RPPS — repli FINESS sur les lignes restées
// `commune_centroid` après ban_join et portant un `num_finess` géolocalisé.
//
// Prouvé prod 2026-09-05 (table `rpps` post-swap) : 70 677 lignes au centroïde
// AVEC un num_finess, dont 57 462 dont l'établissement a un `geom` dans
// `finess`. Cause : l'enrichment 5b ne vise que les lignes SANS geom ; les
// adresses d'établissements (nom de structure, CS/BP, cedex) se géocodent mal
// en BAN → la position exacte de l'hôpital était dans notre table et jamais
// utilisée. Ces garde-fous verrouillent le CONTRAT de la RPC (migration
// 20260905T140000) et son câblage (`rpps.ts`), lus en texte comme les autres
// gardes structurels du repo (pas de DB).

const RPC = "ingest_apply_rpps_finess_centroid_fallback_batch";
const RPPS_SRC = readFileSync(`${ingestDir}/rpps.ts`, "utf8");
const DEF = latestFunctionDef(RPC);

describe(`${RPC} — contrat SQL (migration 20260905T140000)`, () => {
  it("existe et porte un SET statement_timeout ≤ 55 s (sinon budget 8 s hérité → 57014)", () => {
    expect(DEF.length, `def ${RPC} introuvable dans supabase/migrations`).toBeGreaterThan(0);
    const m = DEF.match(/set\s+statement_timeout\s+to\s+'(\d+)s'/i);
    expect(m, "SET statement_timeout au niveau fonction manquant").not.toBeNull();
    expect(Number(m?.[1])).toBeLessThanOrEqual(55);
  });

  it("est KEYSET (p_after + p_limit → TABLE(last_id, applied)), jamais sentinelle", () => {
    expect(DEF).toMatch(/p_after\s+bigint/i);
    expect(DEF).toMatch(/p_limit\s+int(eger)?/i);
    expect(DEF).toMatch(/returns\s+table\s*\(\s*last_id\s+bigint\s*,\s*applied\s+int(eger)?\s*\)/i);
    expect(DEF).toMatch(/where\s+id\s*>\s*p_after/i);
    expect(DEF).toMatch(/order\s+by\s+id\s+limit\s+p_limit/i);
    expect(DEF).toMatch(/max\(b\.id\)::bigint/i);
  });

  it("ne cible QUE les centroïdes à num_finess, sur rpps_staging (jamais la table servie)", () => {
    expect(DEF).toMatch(/geom_source\s*=\s*'commune_centroid'/i);
    expect(DEF).toMatch(/num_finess\s+is\s+not\s+null/i);
    expect(DEF).toMatch(/from\s+rpps_staging/i);
    expect(DEF).toMatch(/update\s+rpps_staging/i);
    // Aucune référence à la table servie `rpps` nue (le swap est atomique : on
    // ne modifie JAMAIS la table en ligne hors bascule).
    expect(DEF).not.toMatch(/\b(from|update)\s+rpps\b(?!_staging)/i);
  });

  it("joint finess par PK via cast EXPLICITE ::CHAR(9) et exige un geom FINESS", () => {
    // Gotcha CLAUDE.md : `col_char = p_text` caste la COLONNE indexée en text →
    // `finess_pkey` inutilisable. Le cast doit être côté texte (rpps).
    expect(DEF).toMatch(/join\s+finess\s+f/i);
    expect(DEF).toMatch(/f\.num_finess\s*=\s*b\.num_finess::char\(9\)/i);
    expect(DEF).toMatch(/f\.geom\s+is\s+not\s+null/i);
  });

  it("pose geom + geom_source='finess_join' SANS écraser la commune déclarée", () => {
    expect(DEF).toMatch(/set\s+geom\s*=\s*f\.geom/i);
    expect(DEF).toMatch(/geom_source\s*=\s*'finess_join'/i);
    // ≠ 5b : ici la ligne a déjà sa commune (reconnue) → référence des
    // comptages par commune ; seul le point change.
    expect(DEF).not.toMatch(/code_insee\s*=/i);
    expect(DEF).not.toMatch(/code_departement\s*=/i);
    expect(DEF).toMatch(/returning\s+1/i);
  });

  it("est SECURITY DEFINER, exécutable par service_role seulement", () => {
    expect(DEF).toMatch(/security\s+definer/i);
    const sql = readFileSync(
      `${ingestDir}/../../supabase/migrations/20260905T140000_rpps_finess_centroid_fallback.sql`,
      "utf8",
    );
    expect(sql).toMatch(
      new RegExp(
        `revoke\\s+execute\\s+on\\s+function\\s+(?:public\\.)?${RPC}[^;]*from\\s+public`,
        "i",
      ),
    );
    expect(sql).toMatch(
      new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+(?:public\\.)?${RPC}[^;]*to\\s+service_role`,
        "i",
      ),
    );
  });
});

describe("rpps.ts — câblage 5c-bis", () => {
  it("appelle la RPC via runKeysetRpc avec p_limit entier et le timeout par lot", () => {
    const idx = RPPS_SRC.indexOf(`"${RPC}"`);
    expect(idx, "site d'appel introuvable dans rpps.ts").toBeGreaterThan(0);
    const start = RPPS_SRC.lastIndexOf("runKeysetRpc(", idx);
    expect(
      start,
      "la RPC doit être pilotée par runKeysetRpc (keyset, garde de convergence)",
    ).toBeGreaterThan(0);
    expect(idx - start).toBeLessThan(200);
    const block = RPPS_SRC.slice(start, RPPS_SRC.indexOf(");", idx));
    expect(block).toMatch(/p_limit:\s*ENRICH_BATCH_SIZE/);
    expect(block).toContain("RPC_BATCH_TIMEOUT_MS");
  });

  it("compte les éligibles sur rpps_staging avec le MÊME prédicat que la RPC (centroid + num_finess non null)", () => {
    const idx = RPPS_SRC.indexOf(`"${RPC}"`);
    const before = RPPS_SRC.slice(Math.max(0, idx - 2500), idx);
    expect(before).toMatch(
      /\.from\("rpps_staging"\)[\s\S]*\.eq\("geom_source",\s*GEOM_SOURCES\.COMMUNE_CENTROID\)[\s\S]*\.not\("num_finess",\s*"is",\s*null\)/,
    );
    // Un échec du count est fail-loud (IngestError), jamais un 0 silencieux.
    expect(before).toMatch(/Failed to count FINESS fallback eligible rows/);
  });

  it("sentinelle « 0 posé sur N éligibles » → partial + trace audit (même politique que ban_join)", () => {
    const idx = RPPS_SRC.indexOf(`"${RPC}"`);
    const after = RPPS_SRC.slice(idx, idx + 2500);
    expect(after).toMatch(/fallbackApplied === 0/);
    expect(after).toMatch(/log\.status = "partial"/);
    expect(after).toMatch(/appendLogMessage\(log,/);
  });
});
