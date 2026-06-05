import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCommuneIndex } from "../../src/territoire/commune-index.js";
import type { Commune } from "../../src/territoire/communes.js";
import { ingestDir } from "./migration-sql.js";
import { IngestError, type IngestLogEntry } from "./shared.js";

// `ingestDir` (helper partagé migration-sql.ts) — même pattern que
// rpps-matview-rebuild.test.ts / finess-hosted-rebuild.test.ts pour lire un source.
const RPPS_SRC = readFileSync(`${ingestDir}/rpps.ts`, "utf8");

const { __TESTING__ } = await import("./rpps.js");
const { parseRppsRecord, COL, rebuildRppsMatviews, evaluateBanJoinOutcome } = __TESTING__;

const fixtures: Commune[] = [
  {
    code: "08105",
    nom: "Charleville-Mézières",
    codesPostaux: ["08000"],
    centre: { lon: 4.7203, lat: 49.7724 },
    codeDepartement: "08",
  },
  {
    code: "75108",
    nom: "Paris 8e Arrondissement",
    codesPostaux: ["75008"],
    centre: { lon: 2.3175, lat: 48.8722 },
    codeDepartement: "75",
  },
];
const idx = buildCommuneIndex(fixtures);

/**
 * Construit une ligne RPPS avec des valeurs par défaut plausibles. Les keys
 * matchent strictement les noms de colonnes ANS (`Identification nationale PP`,
 * etc.) que `parseRppsRecord` lit via les constantes `COL`.
 */
function row(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    [COL.RPPS_ID]: "810009647990",
    [COL.IDENTIFIANT_PP]: "10009647990",
    [COL.CIVILITE_LIBELLE]: "M.",
    [COL.NOM]: "DUPONT",
    [COL.PRENOM]: "JEAN",
    [COL.PROFESSION_CODE]: "10",
    [COL.PROFESSION_LIBELLE]: "Médecin",
    [COL.CATEGORIE_CODE]: "C",
    [COL.CATEGORIE_LIBELLE]: "Civil",
    [COL.SAVOIR_FAIRE_CODE]: "SM26",
    [COL.SAVOIR_FAIRE_LIBELLE]: "Cardiologie et maladies vasculaires",
    [COL.MODE_EXERCICE_CODE]: "S",
    [COL.MODE_EXERCICE_LIBELLE]: "Salarié",
    [COL.SIRET]: "78712043500012",
    [COL.SIREN]: "787120435",
    [COL.NUM_FINESS]: "080010234",
    [COL.NUM_FINESS_EJ]: "080000456",
    [COL.RAISON_SOCIALE]: "LBM BIO ARD'AISNE",
    [COL.ENSEIGNE]: "BIO ARD'AISNE",
    [COL.SECTEUR_LIBELLE]: "Privé",
    [COL.NUM_VOIE]: "60",
    [COL.TYPE_VOIE_LIBELLE]: "AV",
    [COL.VOIE]: "DE JASSERON",
    [COL.CODE_POSTAL]: "08000",
    [COL.CODE_COMMUNE]: "08105",
    [COL.LIBELLE_COMMUNE]: "CHARLEVILLE MEZIERES",
    [COL.TELEPHONE]: "0324567890",
    [COL.EMAIL]: "contact@example.com",
    ...overrides,
  };
}

describe("parseRppsRecord", () => {
  it("parses une ligne complète et produit un EWKT geom au centroïde commune", () => {
    const result = parseRppsRecord(row(), idx);
    expect(result.row).toBeDefined();
    if (!result.row) throw new Error("expected row");
    expect(result.row.rpps_id).toBe("810009647990");
    expect(result.row.nom).toBe("DUPONT");
    expect(result.row.prenom).toBe("JEAN");
    expect(result.row.profession_code).toBe("10");
    expect(result.row.savoir_faire_code).toBe("SM26");
    expect(result.row.mode_exercice_code).toBe("S");
    expect(result.row.num_finess).toBe("080010234");
    expect(result.row.code_insee).toBe("08105");
    expect(result.row.code_departement).toBe("08");
    expect(result.row.code_postal).toBe("08000");
    expect(result.row.geom).toBe("SRID=4326;POINT(4.7203 49.7724)");
    expect(result.row.geom_source).toBe("commune_centroid");
    expect(result.row.adresse).toBe("60 AV DE JASSERON");
  });

  it("concatène num_voie + type_voie + libelle_voie séparés par espace", () => {
    const result = parseRppsRecord(
      row({ [COL.NUM_VOIE]: "12", [COL.TYPE_VOIE_LIBELLE]: "PLACE", [COL.VOIE]: "DE LA PAIX" }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.adresse).toBe("12 PLACE DE LA PAIX");
  });

  it("retourne adresse=null quand voie + type + numéro tous vides", () => {
    const result = parseRppsRecord(
      row({ [COL.NUM_VOIE]: "", [COL.TYPE_VOIE_LIBELLE]: "", [COL.VOIE]: "" }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.adresse).toBeNull();
  });

  it("skip no_identity quand rpps_id est vide (row absent)", () => {
    const result = parseRppsRecord(row({ [COL.RPPS_ID]: "" }), idx);
    expect(result.row).toBeUndefined();
  });

  it("skip no_identity quand nom OU prénom vide", () => {
    expect(parseRppsRecord(row({ [COL.NOM]: "", [COL.PRENOM]: "" }), idx).row).toBeUndefined();
    expect(parseRppsRecord(row({ [COL.NOM]: "" }), idx).row).toBeUndefined();
    expect(parseRppsRecord(row({ [COL.PRENOM]: "" }), idx).row).toBeUndefined();
  });

  it("conserve nom et prénom tels quels (pas de duplication silencieuse)", () => {
    const r = parseRppsRecord(row({ [COL.NOM]: "MARTIN", [COL.PRENOM]: "Sophie" }), idx);
    if (!r.row) throw new Error("expected row");
    expect(r.row.nom).toBe("MARTIN");
    expect(r.row.prenom).toBe("Sophie");
  });

  // --- Pas de skip no_locality : geom NULL fallback + enrichissement FINESS ---

  it("produit row geom NULL quand CP ET ville absents (étudiant/retraité)", () => {
    const result = parseRppsRecord(row({ [COL.CODE_POSTAL]: "", [COL.LIBELLE_COMMUNE]: "" }), idx);
    if (!result.row) throw new Error("expected row (CP+ville absents)");
    expect(result.row.geom).toBeNull();
    expect(result.row.geom_source).toBeNull();
    expect(result.row.code_departement).toBeNull();
    expect(result.row.code_insee).toBeNull();
    // Identité préservée pour permettre lookup par rpps_id
    expect(result.row.rpps_id).toBe("810009647990");
    expect(result.row.num_finess).toBe("080010234");
  });

  it("produit row geom NULL avec dept dérivé du CP quand CP+ville unmatched (métropole)", () => {
    const result = parseRppsRecord(
      row({ [COL.CODE_POSTAL]: "08999", [COL.LIBELLE_COMMUNE]: "VILLE INCONNUE" }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.geom).toBeNull();
    expect(result.row.geom_source).toBeNull();
    expect(result.row.code_departement).toBe("08");
    expect(result.row.code_insee).toBeNull();
  });

  it("dérive dept DOM 3-chars depuis CP unmatched", () => {
    const result = parseRppsRecord(
      row({ [COL.CODE_POSTAL]: "97400", [COL.LIBELLE_COMMUNE]: "SAINT-DENIS-LA-REUNION" }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.geom).toBeNull();
    expect(result.row.code_departement).toBe("974");
  });

  it("retourne dept NULL pour CP Corse 20xxx (ambigu 2A/2B sans commune)", () => {
    const result = parseRppsRecord(
      row({ [COL.CODE_POSTAL]: "20100", [COL.LIBELLE_COMMUNE]: "VILLE INCONNUE" }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.code_departement).toBeNull();
  });

  it("retourne dept NULL pour CP malformé sans match commune", () => {
    const result = parseRppsRecord(
      row({ [COL.CODE_POSTAL]: "ABC", [COL.LIBELLE_COMMUNE]: "" }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.code_departement).toBeNull();
  });

  it("préserve num_finess sur PS sans adresse — clé du post-enrichissement", () => {
    const result = parseRppsRecord(
      row({
        [COL.CODE_POSTAL]: "",
        [COL.LIBELLE_COMMUNE]: "",
        [COL.NUM_FINESS]: "750100166",
      }),
      idx,
    );
    if (!result.row) throw new Error("expected row");
    expect(result.row.num_finess).toBe("750100166");
    expect(result.row.geom).toBeNull();
    // Le post-INSERT `ingest_apply_rpps_finess_enrichment_batch` joindra
    // sur ce num_finess pour combler geom + dept + insee depuis FINESS.
  });

  // --- Pas de match commune mais infos préservées ---------------------------------------------------

  it("trim+slice le code_postal à 5 chars (CHAR(5) safety)", () => {
    const result = parseRppsRecord(row({ [COL.CODE_POSTAL]: "  08000 CEDEX " }), idx);
    if (!result.row) throw new Error("expected row");
    // Le matchCommune travaille sur le CP brut ; le slice ne s'applique
    // qu'au stockage final.
    expect(result.row.code_postal).toBe("08000");
  });

  it("expose num_finess et num_finess_ej pour le pivot RPPS↔FINESS", () => {
    const result = parseRppsRecord(row(), idx);
    if (!result.row) throw new Error("expected row");
    expect(result.row.num_finess).toBe("080010234");
    expect(result.row.num_finess_ej).toBe("080000456");
    expect(result.row.siret).toBe("78712043500012");
    expect(result.row.siren).toBe("787120435");
  });

  it("propage les modes d'exercice (libéral L, salarié S, mixte M)", () => {
    const lib = parseRppsRecord(row({ [COL.MODE_EXERCICE_CODE]: "L" }), idx);
    expect(lib.row?.mode_exercice_code).toBe("L");
    const sal = parseRppsRecord(row({ [COL.MODE_EXERCICE_CODE]: "S" }), idx);
    expect(sal.row?.mode_exercice_code).toBe("S");
    const mix = parseRppsRecord(row({ [COL.MODE_EXERCICE_CODE]: "M" }), idx);
    expect(mix.row?.mode_exercice_code).toBe("M");
  });

  it("conserve raw vide pour économiser le stockage Supabase", () => {
    const result = parseRppsRecord(row(), idx);
    if (!result.row) throw new Error("expected row");
    expect(result.row.raw).toEqual({});
  });

  // --- Invariant geom ⟹ code_insee (filet de sécurité) ---------------------
  // `rpps_in_radius` (matview centroïdes communaux + LATERAL early-stop)
  // suppose qu'AUCUNE row n'a `geom NOT NULL AND code_insee NULL` : sans
  // code_insee, une row géolocalisée serait invisible au CROSS JOIN LATERAL
  // sur `code_insee` → trou silencieux dans la recherche par rayon. Vrai à
  // 100 % en prod mais non contraint en base : ce test verrouille la
  // garantie au point de construction (un futur refactor posant `geom` sans
  // `code_insee` casse CI ici, pas en prod six semaines plus tard).
  it("INVARIANT : une row avec geom a TOUJOURS code_insee (jamais geom sans code_insee)", () => {
    const cases: Array<Record<string, string>> = [
      row(), // match commune métropole
      row({ [COL.CODE_POSTAL]: "75008", [COL.LIBELLE_COMMUNE]: "PARIS 8E" }), // match Paris
      row({ [COL.CODE_POSTAL]: "08999", [COL.LIBELLE_COMMUNE]: "VILLE INCONNUE" }), // unmatched métro
      row({ [COL.CODE_POSTAL]: "97400", [COL.LIBELLE_COMMUNE]: "INCONNUE" }), // unmatched DOM
      row({ [COL.CODE_POSTAL]: "", [COL.LIBELLE_COMMUNE]: "" }), // ni CP ni ville
      row({ [COL.NUM_VOIE]: "", [COL.TYPE_VOIE_LIBELLE]: "", [COL.VOIE]: "" }), // sans adresse
    ];
    for (const rec of cases) {
      const { row: r } = parseRppsRecord(rec, idx);
      if (!r) continue;
      if (r.geom !== null) {
        expect(r.code_insee, `geom="${r.geom}" sans code_insee viole l'invariant`).not.toBeNull();
      }
    }
  });
});

// --- rebuildRppsMatviews (robustesse matview/swap 2026-05-18) ----------------

function makeLog(): IngestLogEntry {
  return {
    source: "rpps",
    started_at: "2026-05-14T10:00:00Z",
    status: "success",
  };
}

function makeSupabaseStub(rpcImpl: (name: string, args: unknown) => { error: unknown }) {
  return { rpc: vi.fn(rpcImpl) } as unknown as Parameters<typeof rebuildRppsMatviews>[0];
}

// Contrat d'erreur de `rebuildRppsMatviews` (source de vérité = son JSDoc
// dans rpps.ts) : transitoire → "partial" sans throw (rollback préserve
// l'ancienne matview) ; structurel → throw IngestError → failed+exit(1).
// Durcissement vs l'ancien refresh-only qui avalait 42P01 (trou /review).
describe("rebuildRppsMatviews", () => {
  it("appelle ingest_rebuild_rpps_matviews UNE fois (reconstruction atomique des 3, pas une boucle REFRESH), puis chaîne le rebuild Phase 2 finess_hosted_activities", async () => {
    // Phase 2 (2026-05-23) : chaînage hosted_activities ajouté SÉQUENTIELLEMENT
    // après rpps_matviews. Ordre load-bearing (rpps PUIS hosted) gardé en
    // détail dans `rpps-hosted-rebuild.test.ts`. Ici on vérifie juste la
    // co-présence des 2 appels en chemin nominal (le contrat d'unicité de
    // rpps_matviews "1 fois, pas une boucle REFRESH" reste préservé).
    const names: string[] = [];
    const supabase = makeSupabaseStub((name) => {
      names.push(name);
      return { error: null };
    });
    const log = makeLog();

    await rebuildRppsMatviews(supabase, log);

    expect(names).toEqual([
      "ingest_rebuild_rpps_matviews",
      "ingest_rebuild_finess_hosted_activities",
    ]);
    expect(log.status).toBe("success");
    expect(log.error_message).toBeUndefined();
  });

  it("lock transitoire (55P03) → partial + nomme la reconstruction, SANS throw (rollback préserve l'ancienne matview, retry au prochain cron)", async () => {
    const supabase = makeSupabaseStub(() => ({
      error: { code: "55P03", message: "lock not available" },
    }));
    const log = makeLog();

    await expect(rebuildRppsMatviews(supabase, log)).resolves.toBeUndefined();

    expect(log.status).toBe("partial");
    expect(log.error_message).toContain("rebuild");
    expect(log.error_message).toContain("55P03");
  });

  it("timeout (57014) → partial sans throw (transaction rollback = aucune matview détruite, pas de tool down)", async () => {
    const supabase = makeSupabaseStub(() => ({
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    }));
    const log = makeLog();

    await expect(rebuildRppsMatviews(supabase, log)).resolves.toBeUndefined();

    expect(log.status).toBe("partial");
    expect(log.error_message).toContain("57014");
  });

  it("DURCISSEMENT : erreur structurelle (42P01) → throw IngestError (LOUD), ne dégrade PAS en partial silencieux", async () => {
    // L'ancien refreshRppsMatviews posait status=partial et avalait 42P01
    // (trou prouvé par /review silent-failure-hunter : matview détruite =
    // rpps_in_radius down, masqué en "partial" non bloquant). Le nouveau
    // contrat FAIL LOUD : throw → catch de main → status "failed" + exit(1).
    const supabase = makeSupabaseStub(() => ({
      error: { code: "42P01", message: 'relation "rpps" does not exist' },
    }));
    const log = makeLog();

    await expect(rebuildRppsMatviews(supabase, log)).rejects.toBeInstanceOf(IngestError);
    expect(log.status).not.toBe("partial");
  });

  it("erreur SQL inattendue (code absent) → traitée comme structurelle → throw IngestError", async () => {
    const supabase = makeSupabaseStub(() => ({
      error: { message: "unexpected failure without code" },
    }));
    const log = makeLog();

    await expect(rebuildRppsMatviews(supabase, log)).rejects.toBeInstanceOf(IngestError);
  });

  it("préserve un error_message préexistant et concatène (cas transitoire)", async () => {
    const supabase = makeSupabaseStub(() => ({
      error: { code: "53300", message: "too many connections" },
    }));
    const log = makeLog();
    log.error_message = "earlier non-fatal warning";

    await rebuildRppsMatviews(supabase, log);

    expect(log.status).toBe("partial");
    expect(log.error_message?.startsWith("earlier non-fatal warning;")).toBe(true);
  });
});

// --- ORDRE STRICT de la séquence cron 5a→5b→5c(ban_join)→6 (load-bearing) ----
//
// Refonte ban_join (2026-05-19, cf. docs/plans/2026-05-19-ban-join-design.md) :
// le build d'index BAN (ex-5c), le re-ANALYZE (ex-5d) et runBanGeocodeStep
// (ex-5e) sont SUPPRIMÉS. La séquence post-COPY est désormais :
//   5a ingest_analyze_rpps_staging (ANALYZE post-COPY, fix C2)
//   5b enrichment FINESS (runBatchedRpc ingest_apply_rpps_finess_enrichment_batch)
//   5c ban_join : count rpps_count_ban_eligible_rows PUIS runKeysetRpc
//      ingest_apply_rpps_ban_join_batch (pose ensembliste cache→staging)
//   6  atomicSwapTables
// Inverser ban_join AVANT l'enrichment FINESS ⇒ des lignes finess_join
// seraient encore commune_centroid au moment du JOIN cache (résultat
// incohérent). ban_join APRÈS le swap ⇒ on écrit une table disparue.
// `main()` n'est pas exporté ; ce garde STATIQUE lit la source de `main()`
// et verrouille l'ORDRE TEXTUEL des sites d'appel (même discipline que les
// guards de parité migrations : textuel mais load-bearing, ancré sur de
// vrais sites d'appel, jamais un `.includes()` flou).
describe("rpps.ts main() — ordre strict 5a→5b→5c ban_join→6 (séquence load-bearing)", () => {
  it("les sites d'appel apparaissent dans l'ordre 5a ANALYZE → 5b FINESS → 5c count → 5c ban_join apply → 6 swap", async () => {
    const fs = await import("node:fs");
    const url = await import("node:url");
    const rppsSrc = fs.readFileSync(
      url.fileURLToPath(new URL("./rpps.ts", import.meta.url)),
      "utf8",
    );
    // Borne au corps de `main()` : du `async function main(` jusqu'à la 1re
    // définition top-level suivante (`async function streamCsvToStaging`) —
    // évite de matcher un site homonyme hors séquence.
    const mainStart = rppsSrc.indexOf("async function main(");
    expect(mainStart, "fonction main() introuvable dans rpps.ts").toBeGreaterThanOrEqual(0);
    const afterMain = rppsSrc.indexOf("\nasync function streamCsvToStaging", mainStart);
    expect(afterMain, "fin de main() (streamCsvToStaging) introuvable").toBeGreaterThan(mainStart);
    const body = rppsSrc.slice(mainStart, afterMain);

    // Ancres = vrais sites d'appel (pas de la prose). 5a passe par
    // callRpcFailLoud → ancre sur son libellé d'erreur UNIQUE. 5c ban_join =
    // count (rpps_count_ban_eligible_rows) PUIS apply via runKeysetRpc
    // ("ingest_apply_rpps_ban_join_batch"). Plus de 5c build-index / 5d
    // re-ANALYZE / 5e runBanGeocodeStep (supprimés par la refonte).
    const i5aAnalyze = body.indexOf('"Failed to ANALYZE rpps_staging before enrichment"');
    const i5bEnrich = body.indexOf('"ingest_apply_rpps_finess_enrichment_batch"');
    const i5cCount = body.indexOf('supabase.rpc("rpps_count_ban_eligible_rows"');
    const i5cBanJoin = body.indexOf('"ingest_apply_rpps_ban_join_batch"');
    const i6Swap = body.indexOf('atomicSwapTables({ prodTable: "rpps" })');

    for (const [label, idx] of [
      ["5a ANALYZE post-COPY", i5aAnalyze],
      ["5b enrichment FINESS", i5bEnrich],
      ["5c ban_join count", i5cCount],
      ["5c ban_join apply (ingest_apply_rpps_ban_join_batch)", i5cBanJoin],
      ["6 atomicSwapTables", i6Swap],
    ] as const) {
      expect(idx, `site d'appel ${label} introuvable dans main()`).toBeGreaterThanOrEqual(0);
    }

    // Anti-régression : les sites supprimés ne doivent PAS réapparaître.
    expect(
      body.indexOf("ingest_build_rpps_staging_ban_indexes"),
      "ingest_build_rpps_staging_ban_indexes ne doit plus être câblé dans main() (refonte ban_join)",
    ).toBe(-1);
    expect(
      body.indexOf("runBanGeocodeStep"),
      "runBanGeocodeStep supprimé — ne doit plus être appelé dans main()",
    ).toBe(-1);

    // 5a < 5b < 5c count < 5c ban_join apply < 6 — chaîne strictement croissante.
    expect(i5aAnalyze).toBeLessThan(i5bEnrich);
    expect(i5bEnrich).toBeLessThan(i5cCount);
    expect(i5cCount).toBeLessThan(i5cBanJoin);
    expect(i5cBanJoin).toBeLessThan(i6Swap);
  });
});

describe("evaluateBanJoinOutcome — sentinelle cohérence ban_join (pure, /review P1)", () => {
  it("banApplied > 0 → aucun signal (succès nominal)", () => {
    expect(
      evaluateBanJoinOutcome({ banApplied: 1200, banEligible: 1290, cacheAccepted: 266 }),
    ).toEqual({
      partial: false,
    });
  });

  it("0 posé + sanity-check cache en échec → partial + warn + logMessage", () => {
    const o = evaluateBanJoinOutcome({
      banApplied: 0,
      banEligible: 1290,
      cacheAccepted: 0,
      cacheErrMessage: "boom",
    });
    expect(o.partial).toBe(true);
    expect(o.warn).toMatch(/cache sanity check failed.*boom/i);
    expect(o.logMessage).toMatch(/0 posed, cache check failed: boom/);
  });

  it("0 posé + cache accepté > 0 → partial + signal dérive parité / new-uncached", () => {
    const o = evaluateBanJoinOutcome({ banApplied: 0, banEligible: 1290, cacheAccepted: 266049 });
    expect(o.partial).toBe(true);
    expect(o.warn).toMatch(/266049 accepted.*parity drift|new uncached/i);
    expect(o.logMessage).toMatch(/0 posed \/ 1290 eligible while cache has 266049 accepted/);
  });

  it("0 posé + cache LISIBLE mais 0 accepté → partial + signal S-1 (3e cas, MEDIUM-1 : plus jamais muet)", () => {
    const o = evaluateBanJoinOutcome({ banApplied: 0, banEligible: 1290, cacheAccepted: 0 });
    expect(o.partial).toBe(true);
    expect(o.warn).toMatch(/0 accepted — cache empty\/wiped or never backfilled \(S-1/i);
    expect(o.logMessage).toMatch(
      /0 posed \/ 1290 eligible while cache has 0 accepted — cache empty\/wiped or pre-backfill/,
    );
    // INVARIANT anti-MEDIUM-1 : ce sous-cas DOIT émettre warn ET logMessage
    // (c'était le seul chemin sans aucune trace avant le correctif).
    expect(o.warn).toBeTruthy();
    expect(o.logMessage).toBeTruthy();
  });
});

// Garde-fou de WIRING de la mesure BAN delta (best-effort, observabilité Phase 1).
//
// Classe de bug (PROUVÉE PROD run #27003446829, 2026-06-05) : mesurée pré-swap sur
// `rpps_staging`, la RPC `rpps_measure_ban_to_geocode` scanne ~1,29 M lignes
// éligibles (tout en `commune_centroid` avant ban_join) → DISTINCT + anti-jointure
// > 55 s → 57014 → `ban_to_geocode_distinct = NULL` → alerte dégradée à CHAQUE
// cron. Le chiffre UTILE est le RÉSIDU post-ban_join (la file que la Phase 2
// géocoderait), mesuré sur `rpps` post-swap en <1 s. Ces 2 invariants verrouillent
// le fix : cible `rpps` (pas staging) ET appel APRÈS le swap.
describe("rpps.ts wiring mesure BAN delta : post-swap, sur rpps", () => {
  it('cible p_source_table:"rpps" (jamais rpps_staging — 57014 prouvé prod)', () => {
    // Regex ancrée sur le nom de la RPC + l'arg "rpps" (sans capture) : lie le
    // littéral à CET appel — le count ban_join voisin garde, lui, "rpps_staging".
    expect(
      RPPS_SRC,
      "la mesure doit cibler `rpps` (résidu post-ban_join), pas `rpps_staging` (~1,29 M → 57014)",
    ).toMatch(/rpps_measure_ban_to_geocode["']\s*,\s*\{\s*p_source_table:\s*["']rpps["']/);
  });

  it("appelée APRÈS atomicSwapTables (pré-swap = re-régression 57014)", () => {
    const swapIdx = RPPS_SRC.indexOf('atomicSwapTables({ prodTable: "rpps" })');
    const measureIdx = RPPS_SRC.indexOf("rpps_measure_ban_to_geocode");
    expect(swapIdx, "atomicSwapTables({ prodTable: 'rpps' }) introuvable").toBeGreaterThan(0);
    expect(measureIdx, "appel rpps_measure_ban_to_geocode introuvable").toBeGreaterThan(0);
    expect(
      measureIdx,
      "la mesure BAN delta doit venir APRÈS le swap (sinon scan staging 1,29 M → 57014)",
    ).toBeGreaterThan(swapIdx);
  });
});
