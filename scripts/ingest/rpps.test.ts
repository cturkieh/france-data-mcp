import { afterEach, describe, expect, it, vi } from "vitest";
import type { BanGeocodeBatchOutcome } from "../../src/core/index.js";
import { normalizeAddressKey } from "../../src/core/index.js";
import { buildCommuneIndex } from "../../src/territoire/commune-index.js";
import type { Commune } from "../../src/territoire/communes.js";
import { IngestError, type IngestLogEntry } from "./shared.js";

// `runBanGeocodeStep` (rpps.ts) importe `geocodeAddressesBatch` depuis
// `../../src/core/index.js`. On mocke ce module en gardant `normalizeAddressKey`
// RÉEL (le stub BAN dérive les clés distinctes via la vraie sortie 3-arg —
// modélise la RPC SQL côté serveur, parité HARD GATE) et en remplaçant
// `geocodeAddressesBatch` par un mock pilotable par test.
const geocodeAddressesBatchMock =
  vi.fn<(rows: unknown, opts: unknown) => Promise<BanGeocodeBatchOutcome>>();
vi.mock("../../src/core/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/index.js")>();
  return {
    ...actual,
    geocodeAddressesBatch: (rows: unknown, opts: unknown) => geocodeAddressesBatchMock(rows, opts),
  };
});

const { __TESTING__ } = await import("./rpps.js");
const { parseRppsRecord, COL, rebuildRppsMatviews, runBanGeocodeStep, BAN_MAX_NEW_PER_RUN } =
  __TESTING__;

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
  it("appelle ingest_rebuild_rpps_matviews UNE fois (reconstruction atomique des 3, pas une boucle REFRESH)", async () => {
    const names: string[] = [];
    const supabase = makeSupabaseStub((name) => {
      names.push(name);
      return { error: null };
    });
    const log = makeLog();

    await rebuildRppsMatviews(supabase, log);

    expect(names).toEqual(["ingest_rebuild_rpps_matviews"]);
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

// --- runBanGeocodeStep (Phase 2 RPPS BAN) -------------------------------------

/**
 * Fixtures adresses RPPS RÉELLES (style ANS, P9 : pas de colonnes fabriquées).
 *
 * Task 4 : la clé d'adresse est désormais l'UNIQUE source de vérité SQL —
 * `rpps_distinct_eligible_keys` la calcule côté serveur (parité octet-à-octet
 * avec `normalizeAddressKey` 3-arg, prouvée par le HARD GATE de parité Task 1).
 * Le cron NE recalcule PLUS la clé en JS. Le stub modélise donc la RPC : il
 * dérive les clés distinctes via le VRAI `normalizeAddressKey(adresse,cp,insee)`
 * (3-arg) sur le dataset configuré — exactement ce que la RPC renvoie en prod.
 * Le champ `ville` reste sur les fixtures (réalisme ANS) mais n'a plus de rôle
 * de garde 4-arg : la garde S-4 devient « le cron n'appelle JAMAIS
 * normalizeAddressKey dans le chemin d'énumération » (test (e)).
 */
const BAN_STAGING_ROW_A = {
  adresse: "60 AV DE JASSERON",
  code_postal: "08000",
  code_insee: "08105",
  ville: "CHARLEVILLE MEZIERES",
};
const BAN_STAGING_ROW_B = {
  adresse: "10 PLACE DE LA REPUBLIQUE",
  code_postal: "75011",
  code_insee: "75111",
  ville: "PARIS",
};

type EligibleRowInput = {
  adresse: string | null;
  code_postal: string | null;
  code_insee: string | null;
  ville?: string | null;
};

/**
 * Stub supabase chaînable couvrant exactement les appels de `runBanGeocodeStep`
 * APRÈS Task 4 (énumération server-side via RPC keyset, plus de `.range()`) :
 *  - rpc("ingest_analyze_rpps_staging")               → ANALYZE (best-effort)
 *  - rpc("rpps_count_ban_eligible_rows", …)           → compte de LIGNES
 *  - rpc("rpps_distinct_eligible_keys", …)            → clés DISTINCTES keyset
 *  - from("geocoded_addresses").select().in()         → cache reads
 *  - from("geocoded_addresses").upsert()              → cache writes
 *  - rpc("ingest_apply_rpps_ban_geocoding_batch", …)  → application batch
 *
 * `finessJoinTrap` reste implicite : le predicate côté RPC (Task 1) ne
 * sélectionne JAMAIS une row finess_join — modélisé ici en ne dérivant les
 * clés QUE du dataset `eligibleRows` fourni (qui ne contient pas de finess_join).
 *
 * MODÉLISATION CLÉ-SOURCE-DE-VÉRITÉ : à partir de `eligibleRows`, le stub
 * calcule les clés distinctes via le VRAI `normalizeAddressKey(adresse,cp,insee)`
 * (3-arg) — ce que la RPC SQL renvoie en prod (parité HARD GATE). Le compte de
 * LIGNES = `eligibleRows.length` (ou `rowCountOverride` pour découpler
 * ROWS ≠ DISTINCT-KEYS). Les clés sont servies keyset-paginées, triées
 * croissantes, au plus `serverCap` par page (modélise un cap serveur
 * `< p_limit` pour PROUVER la terminaison cap-agnostic), fin = page vide.
 */
function makeBanSupabaseStub(opts: {
  eligibleRows: EligibleRowInput[];
  cacheRows?: Array<{ address_key: string; accepted: boolean; ban_attempt_count: number }>;
  /** Cap serveur modélisé sur rpps_distinct_eligible_keys (< KEYSET_PAGE pour
   *  prouver le cap-agnostic). Défaut : pas de cap (tout en une page). */
  serverCap?: number;
  /** Découple le compte de ROWS du nb de clés distinctes (P15). */
  rowCountOverride?: number;
  analyzeError?: string;
  countError?: string;
  /** rpps_distinct_eligible_keys renvoie une erreur PostgREST. */
  distinctKeysError?: string;
  /** rpps_distinct_eligible_keys renvoie une promesse qui ne résout JAMAIS
   *  (modélise un socket figé → doit être borné par withTimeout). */
  distinctKeysHang?: boolean;
  cacheSelectError?: string;
  upsertError?: string;
  rpcError?: string;
  rpcRowsApplied?: number;
}) {
  const upserts: unknown[][] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  /** Ordre d'appel rpc (noms uniquement) — pour asserter ANALYZE-avant-énum. */
  const rpcCallOrder: string[] = [];
  /** Nb de pages keyset réellement servies (assertion cap-agnostic). */
  const keysetPages: number[] = [];
  let rpcDrained = false;

  // Clés distinctes dérivées du dataset via la VRAIE clé 3-arg (= ce que la
  // RPC SQL renvoie en prod, parité HARD GATE). Représentant = 1re occurrence,
  // champs btrim()és comme côté SQL. Triées croissantes (keyset déterministe).
  const keyMap = new Map<
    string,
    { address_key: string; adresse: string; code_postal: string; code_insee: string }
  >();
  for (const r of opts.eligibleRows) {
    const key = normalizeAddressKey(r.adresse, r.code_postal, r.code_insee);
    if (!keyMap.has(key)) {
      keyMap.set(key, {
        address_key: key,
        adresse: (r.adresse ?? "").trim(),
        code_postal: (r.code_postal ?? "").trim(),
        code_insee: (r.code_insee ?? "").trim(),
      });
    }
  }
  const sortedKeyRows = [...keyMap.values()].sort((a, b) =>
    a.address_key < b.address_key ? -1 : a.address_key > b.address_key ? 1 : 0,
  );
  const eligibleRowCount = opts.rowCountOverride ?? opts.eligibleRows.length;

  const fromImpl = (table: string) => {
    if (table === "geocoded_addresses") {
      return {
        select() {
          // Garde anti-régression : cache read = RPC rpps_geocoded_cache_lookup
          // (body POST), plus JAMAIS `.in()` URL (GATE G5bis).
          throw new Error(
            "cron must NOT read geocoded_addresses via .select().in() — use rpps_geocoded_cache_lookup RPC (GATE G5bis)",
          );
        },
        upsert(rows: unknown[]) {
          if (opts.upsertError) {
            return Promise.resolve({ error: { message: opts.upsertError } });
          }
          upserts.push(rows);
          return Promise.resolve({ error: null });
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  };

  const rpc = vi.fn((name: string, args: unknown) => {
    rpcCalls.push({ name, args });
    rpcCallOrder.push(name);

    if (name === "ingest_analyze_rpps_staging") {
      if (opts.analyzeError) {
        return Promise.resolve({ data: null, error: { message: opts.analyzeError } });
      }
      return Promise.resolve({ data: null, error: null });
    }

    if (name === "rpps_count_ban_eligible_rows") {
      if (opts.countError) {
        return Promise.resolve({ data: null, error: { message: opts.countError } });
      }
      return Promise.resolve({ data: eligibleRowCount, error: null });
    }

    if (name === "rpps_geocoded_cache_lookup") {
      // Lecture cache via RPC (clés en BODY POST) — remplace
      // `.from().select().in()` (GATE G5bis). `cacheSelectError` conservé
      // comme hook d'erreur cache (même contrat qu'avant).
      if (opts.cacheSelectError) {
        return Promise.resolve({ data: null, error: { message: opts.cacheSelectError } });
      }
      return Promise.resolve({ data: opts.cacheRows ?? [], error: null });
    }

    if (name === "rpps_distinct_eligible_keys") {
      if (opts.distinctKeysHang) {
        // Socket figé : promesse qui ne résout JAMAIS. Sans withTimeout, le
        // cron pendrait indéfiniment (la classe de panne combattue Task 4).
        return new Promise(() => {});
      }
      if (opts.distinctKeysError) {
        return Promise.resolve({ data: null, error: { message: opts.distinctKeysError } });
      }
      const { p_after, p_limit } = args as { p_after: string | null; p_limit: number };
      // Keyset strict > p_after, ordre croissant, au plus min(p_limit,
      // serverCap) lignes. serverCap < p_limit modélise le cap PostgREST :
      // termine UNIQUEMENT sur page vide (jamais `len < p_limit`).
      const start = p_after === null ? 0 : sortedKeyRows.findIndex((r) => r.address_key > p_after);
      const slice =
        start === -1
          ? []
          : sortedKeyRows.slice(
              start,
              start + Math.min(p_limit, opts.serverCap ?? Number.POSITIVE_INFINITY),
            );
      keysetPages.push(slice.length);
      return Promise.resolve({
        data: slice.map((r) => ({
          address_key: r.address_key,
          adresse: r.adresse,
          code_postal: r.code_postal,
          code_insee: r.code_insee,
        })),
        error: null,
      });
    }

    // ingest_apply_rpps_ban_geocoding_batch
    if (opts.rpcError) {
      return Promise.resolve({ data: null, error: { message: opts.rpcError } });
    }
    if (!rpcDrained) {
      rpcDrained = true;
      return Promise.resolve({ data: opts.rpcRowsApplied ?? 0, error: null });
    }
    return Promise.resolve({ data: 0, error: null });
  });

  const client = {
    from: vi.fn(fromImpl),
    rpc,
  } as unknown as Parameters<typeof runBanGeocodeStep>[0];

  return { client, upserts, rpcCalls, rpcCallOrder, keysetPages };
}

function banOutcome(
  results: Array<
    [
      string,
      {
        accepted: boolean;
        lat: number | null;
        lon: number | null;
        resultScore: number | null;
        resultType: string | null;
      },
    ]
  >,
  apiFailures: number,
  chunksTotal: number,
): BanGeocodeBatchOutcome {
  return { results: new Map(results), apiFailures, chunksTotal };
}

describe("runBanGeocodeStep", () => {
  afterEach(() => {
    geocodeAddressesBatchMock.mockReset();
    vi.restoreAllMocks();
  });

  it("(a) BAN totalement down (apiFailures===chunksTotal) ⇒ pas de throw, status partial, rien d'appliqué", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 1, 1));
    const { client, rpcCalls } = makeBanSupabaseStub({
      eligibleRows: [BAN_STAGING_ROW_A],
      cacheRows: [],
      rpcRowsApplied: 0,
    });
    const log = makeLog();

    await expect(runBanGeocodeStep(client, log, "rpps_staging")).resolves.toBeUndefined();

    expect(log.status).toBe("partial");
    // RPC d'application appelée mais converge à 0 (rien dans le cache).
    expect(rpcCalls.some((c) => c.name === "ingest_apply_rpps_ban_geocoding_batch")).toBe(true);
    errSpy.mockRestore();
  });

  it("(b) happy path : accepté upserté, RPC appliquée, expectedTotal = eligible-ROW count (pas distinct-address)", async () => {
    // 3 rows staging éligibles MAIS 2 adresses distinctes (A partagée 2×).
    const eligibleRows = [BAN_STAGING_ROW_A, BAN_STAGING_ROW_A, BAN_STAGING_ROW_B];
    const keyA = normalizeAddressKey(
      BAN_STAGING_ROW_A.adresse,
      BAN_STAGING_ROW_A.code_postal,
      BAN_STAGING_ROW_A.code_insee,
    );
    const keyB = normalizeAddressKey(
      BAN_STAGING_ROW_B.adresse,
      BAN_STAGING_ROW_B.code_postal,
      BAN_STAGING_ROW_B.code_insee,
    );
    geocodeAddressesBatchMock.mockResolvedValue(
      banOutcome(
        [
          [
            keyA,
            { accepted: true, lat: 46.2, lon: 5.22, resultScore: 0.92, resultType: "housenumber" },
          ],
          [
            keyB,
            { accepted: true, lat: 48.86, lon: 2.36, resultScore: 0.88, resultType: "street" },
          ],
        ],
        0,
        1,
      ),
    );
    const { client, upserts, rpcCalls } = makeBanSupabaseStub({
      eligibleRows,
      cacheRows: [],
      rpcRowsApplied: 3,
    });
    const log = makeLog();

    await runBanGeocodeStep(client, log, "rpps_staging");

    expect(log.status).toBe("success");
    const upsertedKeys = upserts.flat() as Array<{
      address_key: string;
      accepted: boolean;
      lat: number | null;
    }>;
    expect(upsertedKeys.map((u) => u.address_key).sort()).toEqual([keyA, keyB].sort());
    expect(upsertedKeys.every((u) => u.accepted && u.lat !== null)).toBe(true);
    const applyCall = rpcCalls.find((c) => c.name === "ingest_apply_rpps_ban_geocoding_batch");
    expect(applyCall?.args).toEqual({ p_limit: 10_000 });
  });

  it("(b') expectedTotal = eligible-ROW count : avec eligibleRowCount distinct-address count, runBatchedRpc ne diverge pas", async () => {
    // 2500 rows staging, 1 seule adresse distincte. La RPC d'application
    // applique tout en 1 batch puis 0 → 2 itérations. On VERROUILLE qu'aucune
    // divergence n'est levée avec un grand nb de ROWS éligibles.
    const eligibleRows = Array.from({ length: 2500 }, () => BAN_STAGING_ROW_A);
    const keyA = normalizeAddressKey(
      BAN_STAGING_ROW_A.adresse,
      BAN_STAGING_ROW_A.code_postal,
      BAN_STAGING_ROW_A.code_insee,
    );
    geocodeAddressesBatchMock.mockResolvedValue(
      banOutcome(
        [
          [
            keyA,
            { accepted: true, lat: 46.2, lon: 5.22, resultScore: 0.95, resultType: "housenumber" },
          ],
        ],
        0,
        1,
      ),
    );
    const { client } = makeBanSupabaseStub({
      eligibleRows,
      cacheRows: [],
      rpcRowsApplied: 2500,
    });
    const log = makeLog();

    await expect(runBanGeocodeStep(client, log, "rpps_staging")).resolves.toBeUndefined();
    expect(log.status).toBe("success");
  });

  it("(T-eligibleRowCount-is-rows-not-keys) P15 : count RPC renvoie le nb de ROWS (2500) ≠ nb clés distinctes (3) → runBatchedRpc reçoit 2500, AUCUN 'did not converge'", async () => {
    // 3 adresses distinctes seulement, mais le count RPC rapporte 2500 ROWS
    // éligibles. Si expectedTotal était câblé = 3 (distinctKeys.length),
    // maxIterations = ceil(3/10000)+5 = 6 — ici la RPC converge en 2 batches,
    // donc on ne peut pas distinguer par le nb d'itérations seul. On
    // VERROUILLE le contrat : (1) la RPC count est bien appelée et c'est SA
    // valeur (rows) qui est consommée, (2) le step termine SANS throw "did
    // not converge" même si la RPC d'application met PLUS de batches que
    // ceil(distinctKeys/10000)+5 mais ≤ ceil(2500/10000)+5. Pour le prouver
    // sans timing fragile : 3 clés distinctes, count=2500, et la RPC
    // d'application renvoie une suite qui prendrait > 6 itérations si
    // expectedTotal=3 (maxIter 6) mais ≤ 6 si expectedTotal=2500
    // (maxIter ceil(2500/10000)+5 = 6 aussi — donc on ne peut pas séparer
    // par maxIter ici). On se rabat donc sur le contrat observable : la RPC
    // count EST appelée avec p_source_table rpps_staging et le step réussit.
    const rowA = { adresse: "1 RUE A", code_postal: "75001", code_insee: "75101" };
    const rowB = { adresse: "2 RUE B", code_postal: "75002", code_insee: "75102" };
    const rowC = { adresse: "3 RUE C", code_postal: "75003", code_insee: "75103" };
    geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 0, 1));
    const { client, rpcCalls } = makeBanSupabaseStub({
      eligibleRows: [rowA, rowB, rowC],
      rowCountOverride: 2500,
      cacheRows: [],
      rpcRowsApplied: 0,
    });
    const log = makeLog();

    await expect(runBanGeocodeStep(client, log, "rpps_staging")).resolves.toBeUndefined();

    // La RPC de comptage de ROWS est bien appelée sur rpps_staging.
    const countCall = rpcCalls.find((c) => c.name === "rpps_count_ban_eligible_rows");
    expect(countCall).toBeDefined();
    expect(countCall?.args).toEqual({ p_source_table: "rpps_staging" });
    // Le step a complété sans throw "did not converge" (la garde
    // runBatchedRpc a utilisé expectedTotal = 2500 ROWS, pas 3 clés).
    expect(log.status).toBe("success");
  });

  it("(T-eligibleRowCount-divergence) P15 STRICT : expectedTotal = ROWS (count RPC) PAS distinctKeys.length — la RPC d'application prend > ceil(distinctKeys/10000)+5 batches sans diverger", async () => {
    // 1 seule adresse distincte (distinctKeys.length = 1 → si expectedTotal
    // était câblé = 1, maxIterations = ceil(1/10000)+5 = 6). Le count RPC
    // rapporte 60_000 ROWS → maxIterations correct = ceil(60000/10000)+5 = 11.
    // La RPC d'application renvoie 10_000 sept fois (7 batches utiles) puis 0
    // (8e). 8 > 6 (faux maxIter si keys) mais ≤ 11 (vrai maxIter si rows) :
    // PROUVE sans ambiguïté que expectedTotal = ROWS, pas distinctKeys.length.
    const key = normalizeAddressKey("1 RUE A", "75001", "75101");
    geocodeAddressesBatchMock.mockResolvedValue(
      banOutcome(
        [
          [
            key,
            { accepted: true, lat: 48.8, lon: 2.3, resultScore: 0.95, resultType: "housenumber" },
          ],
        ],
        0,
        1,
      ),
    );
    let applyCalls = 0;
    const client = {
      from: vi.fn((table: string) => {
        if (table === "geocoded_addresses") {
          return {
            select() {
              return { in: () => Promise.resolve({ data: [], error: null }) };
            },
            upsert() {
              return Promise.resolve({ error: null });
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      }),
      rpc: vi.fn((name: string, args: unknown) => {
        if (name === "ingest_analyze_rpps_staging") {
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "rpps_count_ban_eligible_rows") {
          return Promise.resolve({ data: 60_000, error: null });
        }
        if (name === "rpps_distinct_eligible_keys") {
          const { p_after } = args as { p_after: string | null };
          if (p_after === null) {
            return Promise.resolve({
              data: [
                { address_key: key, adresse: "1 RUE A", code_postal: "75001", code_insee: "75101" },
              ],
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        }
        if (name === "rpps_geocoded_cache_lookup") {
          // Cache vide → toutes les clés à soumettre (intention du test).
          return Promise.resolve({ data: [], error: null });
        }
        // ingest_apply_rpps_ban_geocoding_batch : 7 batches utiles puis 0.
        applyCalls++;
        return Promise.resolve({ data: applyCalls <= 7 ? 10_000 : 0, error: null });
      }),
    } as unknown as Parameters<typeof runBanGeocodeStep>[0];
    const log = makeLog();

    await expect(runBanGeocodeStep(client, log, "rpps_staging")).resolves.toBeUndefined();

    // 8 appels d'application (7×10000 + 1×0). > 6 = preuve que maxIterations
    // n'a PAS été calculé sur distinctKeys.length (=1), mais sur ROWS (60000).
    expect(applyCalls).toBe(8);
    expect(log.status).toBe("success");
  });

  it("(T-cap-agnostic) keyset RPC : serverCap < KEYSET_PAGE, N > serverCap → TOUTES les N clés énumérées, fin sur page VIDE, nb d'appels = ceil(N/cap)+1", async () => {
    // Garde-fou de la classe S-1 catastrophique : un break `len < p_limit`
    // tronquerait à la 1re page (cap serveur < p_limit). Ici N=250 clés
    // distinctes, serverCap=70 (< KEYSET_PAGE=1000). Terminaison correcte =
    // SEULEMENT sur page vide → 250 clés toutes énumérées, ceil(250/70)+1 = 5
    // appels (4 pleines/partielles + 1 vide).
    const N = 250;
    const SERVER_CAP = 70;
    const rows = Array.from({ length: N }, (_, i) => ({
      // Numéro zero-paddé → ordre lexicographique = ordre numérique (le keyset
      // de la RPC est lexicographique sur la clé normalisée).
      adresse: `${String(i + 1).padStart(4, "0")} RUE DE LA PAIX`,
      code_postal: "75002",
      code_insee: "75102",
      ville: "PARIS",
    }));
    const submitted: string[] = [];
    geocodeAddressesBatchMock.mockImplementation(async (r) => {
      for (const x of r as Array<{ key: string }>) submitted.push(x.key);
      return banOutcome([], 0, 1);
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, keysetPages } = makeBanSupabaseStub({
      eligibleRows: rows,
      serverCap: SERVER_CAP,
      cacheRows: [],
      rpcRowsApplied: 0,
    });
    const log = makeLog();

    await expect(runBanGeocodeStep(client, log, "rpps_staging")).resolves.toBeUndefined();
    logSpy.mockRestore();

    // ceil(250/70) = 4 pages non vides (70,70,70,40) + 1 page vide = 5 appels.
    const expectedNonEmpty = Math.ceil(N / SERVER_CAP);
    expect(keysetPages.length).toBe(expectedNonEmpty + 1);
    expect(keysetPages[keysetPages.length - 1]).toBe(0);
    expect(keysetPages.slice(0, -1).reduce((a, b) => a + b, 0)).toBe(N);
    // AUCUNE clé perdue : les N distinctes sont toutes soumises.
    expect(new Set(submitted).size).toBe(N);
    expect(log.status).toBe("success");
  });

  it("(T-timeout-best-effort) keyset RPC qui ne résout jamais → withTimeout rejette → best-effort : pas de throw, status partial, console.error préfixé, RIEN appliqué", async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 0, 1));
    const { client, rpcCalls, upserts } = makeBanSupabaseStub({
      eligibleRows: [BAN_STAGING_ROW_A],
      distinctKeysHang: true,
      cacheRows: [],
      rpcRowsApplied: 0,
    });
    const log = makeLog();

    const p = runBanGeocodeStep(client, log, "rpps_staging");
    // Avance les timers au-delà de RPC_READ_TIMEOUT_MS (60_000) pour
    // déclencher le rejet de withTimeout sans attendre en temps réel.
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();

    expect(log.status).toBe("partial");
    expect(log.error_message).toContain("BAN geocoding step failed");
    expect(log.error_message).toContain("timed out");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[france-data-mcp][rpps][ban_geocode_fallback]"),
    );
    // Rien d'appliqué : l'énumération a échoué AVANT toute écriture.
    expect(geocodeAddressesBatchMock).not.toHaveBeenCalled();
    expect(upserts.length).toBe(0);
    expect(rpcCalls.some((c) => c.name === "ingest_apply_rpps_ban_geocoding_batch")).toBe(false);
    errSpy.mockRestore();
  });

  it("(T-analyze-before-enumeration) ANALYZE est rpc-appelé AVANT count/keyset ; un échec ANALYZE n'avorte PAS (warn, pas partial)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 0, 1));
    const { client, rpcCallOrder } = makeBanSupabaseStub({
      eligibleRows: [BAN_STAGING_ROW_A],
      analyzeError: "deadlock detected",
      cacheRows: [],
      rpcRowsApplied: 0,
    });
    const log = makeLog();

    await expect(runBanGeocodeStep(client, log, "rpps_staging")).resolves.toBeUndefined();

    // ANALYZE appelé EN PREMIER, avant count et keyset.
    const analyzeIdx = rpcCallOrder.indexOf("ingest_analyze_rpps_staging");
    const countIdx = rpcCallOrder.indexOf("rpps_count_ban_eligible_rows");
    const keysIdx = rpcCallOrder.indexOf("rpps_distinct_eligible_keys");
    expect(analyzeIdx).toBe(0);
    expect(analyzeIdx).toBeLessThan(countIdx);
    expect(analyzeIdx).toBeLessThan(keysIdx);
    // Échec ANALYZE = warn toléré, le step PROCÈDE (énumération faite) et le
    // statut N'EST PAS forcé partial par le seul warn ANALYZE.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[france-data-mcp][rpps][ban_geocode] ANALYZE rpps_staging failed"),
    );
    expect(countIdx).toBeGreaterThanOrEqual(0);
    expect(keysIdx).toBeGreaterThanOrEqual(0);
    expect(log.status).toBe("success");
    warnSpy.mockRestore();
  });

  it("(c) entrée unresolved ⇒ upsert accepted=false + attempt incrémenté, PAS apiFailure, status NON partial", async () => {
    const keyA = normalizeAddressKey(
      BAN_STAGING_ROW_A.adresse,
      BAN_STAGING_ROW_A.code_postal,
      BAN_STAGING_ROW_A.code_insee,
    );
    geocodeAddressesBatchMock.mockResolvedValue(
      banOutcome(
        [[keyA, { accepted: false, lat: null, lon: null, resultScore: null, resultType: null }]],
        0,
        1,
      ),
    );
    const { client, upserts } = makeBanSupabaseStub({
      eligibleRows: [BAN_STAGING_ROW_A],
      cacheRows: [{ address_key: keyA, accepted: false, ban_attempt_count: 1 }],
      rpcRowsApplied: 0,
    });
    const log = makeLog();

    await runBanGeocodeStep(client, log, "rpps_staging");

    expect(log.status).toBe("success");
    const u = (
      upserts.flat() as Array<{
        address_key: string;
        accepted: boolean;
        lat: number | null;
        ban_attempt_count: number;
        ban_last_status: string;
      }>
    )[0];
    expect(u?.accepted).toBe(false);
    expect(u?.lat).toBeNull();
    expect(u?.ban_attempt_count).toBe(2); // 1 (cache) + 1
    expect(u?.ban_last_status).toBe("unresolved");
  });

  it("(d) ratio apiFailures/chunksTotal > ceiling ⇒ status partial", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const keyA = normalizeAddressKey(
      BAN_STAGING_ROW_A.adresse,
      BAN_STAGING_ROW_A.code_postal,
      BAN_STAGING_ROW_A.code_insee,
    );
    geocodeAddressesBatchMock.mockResolvedValue(
      banOutcome(
        [
          [
            keyA,
            { accepted: true, lat: 46.2, lon: 5.22, resultScore: 0.9, resultType: "housenumber" },
          ],
        ],
        2,
        3,
      ),
    );
    const { client } = makeBanSupabaseStub({
      eligibleRows: [BAN_STAGING_ROW_A],
      cacheRows: [],
      rpcRowsApplied: 1,
    });
    const log = makeLog();

    await runBanGeocodeStep(client, log, "rpps_staging");

    expect(log.status).toBe("partial");
    expect(log.error_message).toContain("BAN geocoding degraded");
    expect(log.error_message).toContain("2/3");
    errSpy.mockRestore();
  });

  it("(e) S-4 (Task 4) : le cron NE recalcule JAMAIS la clé en JS — il consomme address_key de la RPC (UNIQUE source de vérité SQL)", async () => {
    // Pré-Task-4, la garde S-4 prouvait l'absence de régression 4-arg `ville`.
    // Post-Task-4, la clé est l'UNIQUE source de vérité SQL (parité octet
    // garantie par le HARD GATE Task 1) : le cron NE DOIT PLUS appeler
    // normalizeAddressKey du tout dans le chemin d'énumération.
    let submittedRows: Array<{
      key: string;
      adresse: string;
      codePostal: string;
      codeInsee: string;
    }> = [];
    geocodeAddressesBatchMock.mockImplementation(async (rows) => {
      submittedRows = rows as typeof submittedRows;
      return banOutcome([], 0, 0);
    });
    // Le stub modélise la RPC SQL en dérivant les clés via le VRAI
    // normalizeAddressKey (= parité prod, calcul EAGER à la construction). Ces
    // appels-là sont LÉGITIMES (côté stub, pas côté cron). On installe le spy
    // APRÈS la construction du stub pour ne capturer QUE les appels du chemin
    // de PRODUCTION pendant `runBanGeocodeStep` — qui doivent être ZÉRO (clé =
    // source de vérité SQL consommée telle quelle via address_key).
    const { client } = makeBanSupabaseStub({
      eligibleRows: [BAN_STAGING_ROW_A, BAN_STAGING_ROW_B],
      cacheRows: [],
      rpcRowsApplied: 0,
    });
    const coreMod = await import("../../src/core/index.js");
    const keySpy = vi.spyOn(coreMod, "normalizeAddressKey");
    const log = makeLog();

    await runBanGeocodeStep(client, log, "rpps_staging");

    // Le cron consomme address_key de la RPC, donc N'appelle PAS
    // normalizeAddressKey (recompute JS = re-introduction du point unique de
    // panne que la SQL-source-of-truth élimine ; parité couverte par le HARD
    // GATE de parité Task 1 + son test d'intégration).
    expect(keySpy).not.toHaveBeenCalled();
    // Les clés soumises sont EXACTEMENT celles de la RPC (= clé 3-arg, 3
    // segments), jamais 4 (ville).
    for (const r of submittedRows) {
      expect(r.key.split("|")).toHaveLength(3);
      expect(r.key).not.toContain("CHARLEVILLE MEZIERES");
      expect(r.key.endsWith("|PARIS")).toBe(false);
    }
    keySpy.mockRestore();
  });

  it("(f) S-3 : accepted=true à coords NULL ⇒ downgrade compté en contract_breach_downgrades DÉDIÉ (PAS rejected_low_score), pas de CHECK throw, pas apiFailure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const keyA = normalizeAddressKey(
      BAN_STAGING_ROW_A.adresse,
      BAN_STAGING_ROW_A.code_postal,
      BAN_STAGING_ROW_A.code_insee,
    );
    geocodeAddressesBatchMock.mockResolvedValue(
      banOutcome(
        [
          [
            keyA,
            { accepted: true, lat: null, lon: null, resultScore: 0.99, resultType: "housenumber" },
          ],
        ],
        0,
        1,
      ),
    );
    const { client, upserts } = makeBanSupabaseStub({
      eligibleRows: [BAN_STAGING_ROW_A],
      cacheRows: [],
      rpcRowsApplied: 0,
    });
    const log = makeLog();

    await runBanGeocodeStep(client, log, "rpps_staging");

    const u = (
      upserts.flat() as Array<{ accepted: boolean; lat: number | null; lon: number | null }>
    )[0];
    expect(u?.accepted).toBe(false);
    expect(u?.lat).toBeNull();
    expect(u?.lon).toBeNull();
    expect(log.status).toBe("success");
    const banLogLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("[rpps] BAN geocoding:"));
    expect(banLogLine).toBeDefined();
    expect(banLogLine).toContain("1 contract_breach_downgrades");
    expect(banLogLine).toContain("0 rejected_low_score");
    expect(banLogLine).toContain("0 accepted");
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("(g) clés accepted=true en cache = FIGÉES (jamais re-soumises à BAN)", async () => {
    const keyA = normalizeAddressKey(
      BAN_STAGING_ROW_A.adresse,
      BAN_STAGING_ROW_A.code_postal,
      BAN_STAGING_ROW_A.code_insee,
    );
    geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 0, 0));
    const { client } = makeBanSupabaseStub({
      eligibleRows: [BAN_STAGING_ROW_A],
      cacheRows: [{ address_key: keyA, accepted: true, ban_attempt_count: 1 }],
      rpcRowsApplied: 1,
    });
    const log = makeLog();

    await runBanGeocodeStep(client, log, "rpps_staging");

    expect(geocodeAddressesBatchMock).not.toHaveBeenCalled();
    expect(log.status).toBe("success");
  });

  it("(h) erreur de la RPC d'énumération keyset ⇒ best-effort : pas de throw, status partial, console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = makeBanSupabaseStub({
      eligibleRows: [BAN_STAGING_ROW_A],
      distinctKeysError: "connection reset",
    });
    const log = makeLog();

    await expect(runBanGeocodeStep(client, log, "rpps_staging")).resolves.toBeUndefined();

    expect(log.status).toBe("partial");
    expect(log.error_message).toContain("BAN geocoding step failed");
    expect(log.error_message).toContain("rpps_distinct_eligible_keys failed");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[france-data-mcp][rpps][ban_geocode_fallback]"),
    );
    errSpy.mockRestore();
  });

  it("(h') erreur de la RPC de comptage ⇒ best-effort : pas de throw, status partial, AUCUNE écriture (set non traité comme complet)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 0, 1));
    const { client, rpcCalls, upserts } = makeBanSupabaseStub({
      eligibleRows: [BAN_STAGING_ROW_A],
      countError: "ETIMEDOUT counting eligible rows",
      cacheRows: [],
      rpcRowsApplied: 0,
    });
    const log = makeLog();

    await expect(runBanGeocodeStep(client, log, "rpps_staging")).resolves.toBeUndefined();

    expect(log.status).toBe("partial");
    expect(log.error_message).toContain("BAN geocoding step failed");
    expect(log.error_message).toContain("rpps_count_ban_eligible_rows failed");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[france-data-mcp][rpps][ban_geocode_fallback]"),
    );
    // Erreur AVANT toute écriture : aucune soumission BAN / upsert / RPC apply.
    expect(geocodeAddressesBatchMock).not.toHaveBeenCalled();
    expect(upserts.length).toBe(0);
    expect(rpcCalls.some((c) => c.name === "ingest_apply_rpps_ban_geocoding_batch")).toBe(false);
    errSpy.mockRestore();
  });

  it("(h'') count RPC renvoie 0 ⇒ early-return avec la ligne de log BYTE-IDENTIQUE, aucune énumération", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, rpcCalls } = makeBanSupabaseStub({
      eligibleRows: [],
      cacheRows: [],
      rpcRowsApplied: 0,
    });
    const log = makeLog();

    await runBanGeocodeStep(client, log, "rpps_staging");

    expect(log.status).toBe("success");
    expect(logSpy).toHaveBeenCalledWith(
      "[rpps] BAN geocoding: 0 new / 0 cached / 0 accepted / 0 rejected_low_score / 0 unresolved / 0 contract_breach_downgrades / 0 api_failures / 0 rows_applied",
    );
    // 0 ligne éligible → aucune énumération keyset, aucune RPC d'application.
    expect(rpcCalls.some((c) => c.name === "rpps_distinct_eligible_keys")).toBe(false);
    expect(rpcCalls.some((c) => c.name === "ingest_apply_rpps_ban_geocoding_batch")).toBe(false);
    logSpy.mockRestore();
  });

  it("(S-1 runtime) count > 0 mais ZÉRO clé énumérée ⇒ backstop : throw rabattu en partial, AUCUNE application, message diagnostique", async () => {
    // Backstop S-1 runtime côté cron (rpps.ts:1101) : si le count d'éligibles
    // est > 0 mais l'énumération keyset renvoie 0 clé (dérive prédicat/index
    // ou index BAN manquant/invalide), NE PAS rapporter un succès silencieux.
    // Le throw tombe dans le catch best-effort → partial + message + log err,
    // SANS jamais appeler l'application cache→staging.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, rpcCalls, upserts } = makeBanSupabaseStub({
      eligibleRows: [],
      cacheRows: [],
      rpcRowsApplied: 0,
      rowCountOverride: 2500,
    });
    const log = makeLog();

    await expect(runBanGeocodeStep(client, log, "rpps_staging")).resolves.toBeUndefined();

    expect(log.status).toBe("partial");
    expect(log.error_message).toContain("S-1 silent-failure backstop");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[france-data-mcp][rpps][ban_geocode_fallback]"),
    );
    expect(upserts.length).toBe(0);
    expect(rpcCalls.some((c) => c.name === "ingest_apply_rpps_ban_geocoding_batch")).toBe(false);
    errSpy.mockRestore();
  });

  it("(T-count-not-finite) count RPC renvoie un non-numérique ⇒ best-effort : pas de throw, status partial, message explicite", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = {
      from: vi.fn((table: string) => {
        throw new Error(`unexpected table ${table}`);
      }),
      rpc: vi.fn((name: string) => {
        if (name === "ingest_analyze_rpps_staging") {
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "rpps_count_ban_eligible_rows") {
          return Promise.resolve({ data: "not-a-number", error: null });
        }
        return Promise.resolve({ data: 0, error: null });
      }),
    } as unknown as Parameters<typeof runBanGeocodeStep>[0];
    const log = makeLog();

    await expect(runBanGeocodeStep(client, log, "rpps_staging")).resolves.toBeUndefined();

    expect(log.status).toBe("partial");
    expect(log.error_message).toContain("BAN geocoding step failed");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[france-data-mcp][rpps][ban_geocode_fallback]"),
    );
    errSpy.mockRestore();
  });

  // (M-2) Garde fail-loud de FORME du count AVANT coercition `Number(...)`.
  // `Number(null) === 0`, `Number("") === 0` sont FINIS : sans ce garde une
  // régression de contrat RPC (null/empty au lieu d'un count) se faufilerait
  // en early-return success-shaped "0 ligne" (S-1 : set non vide traité comme
  // vide, rapporté succès). On exige : throw → catch best-effort → partial +
  // [ban_geocode_fallback] console.error + AUCUNE RPC d'application + PAS la
  // ligne de log success-shaped "0 new / 0 cached …".
  it.each([
    { label: "null", data: null as unknown },
    { label: "chaîne vide", data: "" as unknown },
  ])(
    "(T-count-shape-$label) count RPC renvoie $label ⇒ fail-loud (PAS un 0 early-return success-shaped) : partial, fallback, aucune application",
    async ({ data: countValue }) => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const rpcNames: string[] = [];
      const client = {
        from: vi.fn((table: string) => {
          throw new Error(`unexpected table ${table}`);
        }),
        rpc: vi.fn((name: string) => {
          rpcNames.push(name);
          if (name === "ingest_analyze_rpps_staging") {
            return Promise.resolve({ data: null, error: null });
          }
          if (name === "rpps_count_ban_eligible_rows") {
            return Promise.resolve({ data: countValue, error: null });
          }
          return Promise.resolve({ data: 0, error: null });
        }),
      } as unknown as Parameters<typeof runBanGeocodeStep>[0];
      const log = makeLog();

      await expect(runBanGeocodeStep(client, log, "rpps_staging")).resolves.toBeUndefined();

      // Fail-loud, PAS un noop : best-effort catch → partial + fallback log.
      expect(log.status).toBe("partial");
      expect(log.error_message).toContain("BAN geocoding step failed");
      expect(log.error_message).toContain("rpps_count_ban_eligible_rows returned");
      expect(log.error_message).toContain("RPC contract regression");
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("[france-data-mcp][rpps][ban_geocode_fallback]"),
      );
      // NE DOIT PAS avoir émis la ligne success-shaped "0 …" (ce serait
      // exactement la panne S-1 que ce garde combat).
      expect(logSpy).not.toHaveBeenCalledWith(
        "[rpps] BAN geocoding: 0 new / 0 cached / 0 accepted / 0 rejected_low_score / 0 unresolved / 0 contract_breach_downgrades / 0 api_failures / 0 rows_applied",
      );
      // Échec AVANT toute énumération / application.
      expect(rpcNames).not.toContain("rpps_distinct_eligible_keys");
      expect(rpcNames).not.toContain("ingest_apply_rpps_ban_geocoding_batch");
      errSpy.mockRestore();
      logSpy.mockRestore();
    },
  );

  // (M-2 bis) string NON décimale-entière : `Number("  ")`, `Number("0x0")`,
  // `Number("0b0")` valent `0` FINI → sans le garde regex `^\s*\d+\s*$` un tel
  // payload se faufilerait en early-return success-shaped "0 ligne" (panne
  // S-1). Aucune de ces formes n'est une sérialisation PostgREST légitime d'un
  // `RETURNS BIGINT`. On exige : throw → catch best-effort → partial +
  // [ban_geocode_fallback] console.error + AUCUNE ligne success-shaped "0 …"
  // + aucune RPC d'énumération/application.
  it.each([
    { label: "whitespace seul", data: "  " as unknown },
    { label: "hexadécimal 0x0", data: "0x0" as unknown },
  ])(
    "(T-count-shape-non-decimal-$label) count RPC renvoie $label ⇒ fail-loud (PAS un 0 early-return success-shaped) : partial, fallback, aucune application",
    async ({ data: countValue }) => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const rpcNames: string[] = [];
      const client = {
        from: vi.fn((table: string) => {
          throw new Error(`unexpected table ${table}`);
        }),
        rpc: vi.fn((name: string) => {
          rpcNames.push(name);
          if (name === "ingest_analyze_rpps_staging") {
            return Promise.resolve({ data: null, error: null });
          }
          if (name === "rpps_count_ban_eligible_rows") {
            return Promise.resolve({ data: countValue, error: null });
          }
          return Promise.resolve({ data: 0, error: null });
        }),
      } as unknown as Parameters<typeof runBanGeocodeStep>[0];
      const log = makeLog();

      await expect(runBanGeocodeStep(client, log, "rpps_staging")).resolves.toBeUndefined();

      // Fail-loud, PAS un noop : best-effort catch → partial + fallback log.
      expect(log.status).toBe("partial");
      expect(log.error_message).toContain("BAN geocoding step failed");
      expect(log.error_message).toContain("rpps_count_ban_eligible_rows returned");
      expect(log.error_message).toContain("a non-decimal string");
      expect(log.error_message).toContain("RPC contract regression");
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("[france-data-mcp][rpps][ban_geocode_fallback]"),
      );
      // NE DOIT PAS avoir émis la ligne success-shaped "0 …" (panne S-1).
      expect(logSpy).not.toHaveBeenCalledWith(
        "[rpps] BAN geocoding: 0 new / 0 cached / 0 accepted / 0 rejected_low_score / 0 unresolved / 0 contract_breach_downgrades / 0 api_failures / 0 rows_applied",
      );
      // Échec AVANT toute énumération / application.
      expect(rpcNames).not.toContain("rpps_distinct_eligible_keys");
      expect(rpcNames).not.toContain("ingest_apply_rpps_ban_geocoding_batch");
      errSpy.mockRestore();
      logSpy.mockRestore();
    },
  );

  // (M-2 contre-épreuve) un BIGINT-as-string numérique ("0") reste un VRAI
  // zéro légitime → early-return success-shaped BYTE-IDENTIQUE conservé
  // (le garde de forme ne doit PAS l'attraper).
  it('(T-count-zero-string) count RPC renvoie "0" ⇒ early-return success-shaped INCHANGÉ (vrai zéro, pas une régression)', async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const rpcNames: string[] = [];
    const client = {
      from: vi.fn((table: string) => {
        throw new Error(`unexpected table ${table}`);
      }),
      rpc: vi.fn((name: string) => {
        rpcNames.push(name);
        if (name === "ingest_analyze_rpps_staging") {
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "rpps_count_ban_eligible_rows") {
          return Promise.resolve({ data: "0", error: null });
        }
        return Promise.resolve({ data: 0, error: null });
      }),
    } as unknown as Parameters<typeof runBanGeocodeStep>[0];
    const log = makeLog();

    await runBanGeocodeStep(client, log, "rpps_staging");

    expect(log.status).toBe("success");
    expect(logSpy).toHaveBeenCalledWith(
      "[rpps] BAN geocoding: 0 new / 0 cached / 0 accepted / 0 rejected_low_score / 0 unresolved / 0 contract_breach_downgrades / 0 api_failures / 0 rows_applied",
    );
    expect(rpcNames).not.toContain("rpps_distinct_eligible_keys");
    expect(rpcNames).not.toContain("ingest_apply_rpps_ban_geocoding_batch");
    logSpy.mockRestore();
  });

  // --- STEP A : plafond par run BAN_MAX_NEW_PER_RUN (filet A+B) -------------

  function makeDistinctEligibleRows(n: number): Array<{
    adresse: string;
    code_postal: string;
    code_insee: string;
    ville: string;
  }> {
    return Array.from({ length: n }, (_, i) => ({
      // Numéro zero-paddé : ordre lexicographique de la clé normalisée =
      // ordre d'insertion (le keyset RPC trie sur la clé).
      adresse: `${String(i + 1).padStart(7, "0")} RUE DE LA PAIX`,
      code_postal: "75002",
      code_insee: "75102",
      ville: "PARIS",
    }));
  }

  it("(i) STEP A : plus d'adresses distinctes que le plafond → soumet EXACTEMENT le plafond, log backlog, status NON partial (cap = fonctionnement normal)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const cap = BAN_MAX_NEW_PER_RUN;
    const total = cap + 25;
    const rows = makeDistinctEligibleRows(total);

    let submittedCount = 0;
    geocodeAddressesBatchMock.mockImplementation(async (r) => {
      submittedCount = (r as unknown[]).length;
      return banOutcome([], 0, 1);
    });
    const { client } = makeBanSupabaseStub({
      eligibleRows: rows,
      cacheRows: [],
      rpcRowsApplied: 0,
    });
    const log = makeLog();

    await runBanGeocodeStep(client, log, "rpps_staging");

    expect(submittedCount).toBe(cap);
    expect(log.status).toBe("success");
    const backlogLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("[rpps] BAN backlog:"));
    expect(backlogLine).toBeDefined();
    expect(backlogLine).toContain(`${total - cap} addresses remaining`);
    logSpy.mockRestore();
  });

  it("(i') STEP A : sous le plafond → AUCUN message backlog, tout soumis", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const rows = makeDistinctEligibleRows(5);
    let submittedCount = -1;
    geocodeAddressesBatchMock.mockImplementation(async (r) => {
      submittedCount = (r as unknown[]).length;
      return banOutcome([], 0, 1);
    });
    const { client } = makeBanSupabaseStub({
      eligibleRows: rows,
      cacheRows: [],
      rpcRowsApplied: 0,
    });
    const log = makeLog();

    await runBanGeocodeStep(client, log, "rpps_staging");

    expect(submittedCount).toBe(5);
    expect(log.status).toBe("success");
    const backlogLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("[rpps] BAN backlog:"));
    expect(backlogLine).toBeUndefined();
    logSpy.mockRestore();
  });

  it("(i'') STEP A : 2 runs successifs → le backlog décroît STRICTEMENT, aucune adresse définitivement sautée (drain déterministe via cache)", async () => {
    const cap = BAN_MAX_NEW_PER_RUN;
    const total = cap + 10;
    const rows = makeDistinctEligibleRows(total);

    const submittedRun1: string[] = [];
    geocodeAddressesBatchMock.mockImplementation(async (r) => {
      const list = r as Array<{ key: string }>;
      for (const x of list) submittedRun1.push(x.key);
      return banOutcome(
        list.map((x) => [
          x.key,
          {
            accepted: true,
            lat: 48.86,
            lon: 2.33,
            resultScore: 0.95,
            resultType: "housenumber" as const,
          },
        ]),
        0,
        1,
      );
    });
    const stub1 = makeBanSupabaseStub({ eligibleRows: rows, cacheRows: [], rpcRowsApplied: 0 });
    const log1 = makeLog();
    const logSpy1 = vi.spyOn(console, "log").mockImplementation(() => {});
    await runBanGeocodeStep(stub1.client, log1, "rpps_staging");
    const backlog1 = logSpy1.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("[rpps] BAN backlog:"));
    logSpy1.mockRestore();
    expect(submittedRun1.length).toBe(cap);
    expect(backlog1).toContain(`${total - cap} addresses remaining`);

    const cacheRowsRun2 = submittedRun1.map((address_key) => ({
      address_key,
      accepted: true,
      ban_attempt_count: 1,
    }));
    const submittedRun2: string[] = [];
    geocodeAddressesBatchMock.mockImplementation(async (r) => {
      const list = r as Array<{ key: string }>;
      for (const x of list) submittedRun2.push(x.key);
      return banOutcome([], 0, 1);
    });
    const stub2 = makeBanSupabaseStub({
      eligibleRows: rows,
      cacheRows: cacheRowsRun2,
      rpcRowsApplied: 0,
    });
    const log2 = makeLog();
    const logSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    await runBanGeocodeStep(stub2.client, log2, "rpps_staging");
    const backlog2Line = logSpy2.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("[rpps] BAN backlog:"));
    logSpy2.mockRestore();

    expect(submittedRun2.length).toBe(total - cap);
    expect(submittedRun2.length).toBeLessThan(submittedRun1.length);
    const set1 = new Set(submittedRun1);
    expect(submittedRun2.some((k) => set1.has(k))).toBe(false);
    expect(new Set([...submittedRun1, ...submittedRun2]).size).toBe(total);
    expect(backlog2Line).toBeUndefined();
  });

  it("(j) ORDONNANCEMENT never-attempted-first : un bloc bas-trié de clés ban_attempt_count=2 NE diffère PAS la queue jamais-vue — un run plafonné soumet les clés attempt=0 EN PREMIER", async () => {
    const cap = BAN_MAX_NEW_PER_RUN;
    const LOW_SORTED_TRIED = 30;
    const lowSortedRows = Array.from({ length: LOW_SORTED_TRIED }, (_, i) => ({
      adresse: `0 RUE BASSE ${String(i).padStart(7, "0")}`,
      code_postal: "75001",
      code_insee: "75101",
      ville: "PARIS",
    }));
    const neverSeenRows = Array.from({ length: cap }, (_, i) => ({
      adresse: `1 RUE NEUVE ${String(i).padStart(7, "0")}`,
      code_postal: "75002",
      code_insee: "75102",
      ville: "PARIS",
    }));
    const keyOf = (r: { adresse: string; code_postal: string; code_insee: string }) =>
      normalizeAddressKey(r.adresse, r.code_postal, r.code_insee);
    const lowSortedKeys = new Set(lowSortedRows.map(keyOf));
    const neverSeenKeys = new Set(neverSeenRows.map(keyOf));
    const maxLow = [...lowSortedKeys].sort().at(-1) as string;
    const minNew = [...neverSeenKeys].sort()[0] as string;
    expect(maxLow < minNew).toBe(true);

    const cacheRows = [...lowSortedKeys].map((address_key) => ({
      address_key,
      accepted: false,
      ban_attempt_count: 2,
    }));

    const submitted: string[] = [];
    geocodeAddressesBatchMock.mockImplementation(async (r) => {
      for (const x of r as Array<{ key: string }>) submitted.push(x.key);
      return banOutcome([], 0, 1);
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { client } = makeBanSupabaseStub({
      eligibleRows: [...lowSortedRows, ...neverSeenRows],
      cacheRows,
      rpcRowsApplied: 0,
    });
    const log = makeLog();

    await runBanGeocodeStep(client, log, "rpps_staging");
    logSpy.mockRestore();

    expect(submitted.length).toBe(cap);
    const submittedSet = new Set(submitted);
    for (const k of neverSeenKeys) {
      expect(submittedSet.has(k)).toBe(true);
    }
    for (const k of lowSortedKeys) {
      expect(submittedSet.has(k)).toBe(false);
    }
  });
});

// --- ORDRE STRICT de la séquence cron 5b→5c→5d→5e→6 (load-bearing) -----------
//
// La séquence du pipeline RPPS post-enrichment est LOAD-BEARING (cf.
// docs/plans/2026-05-18-ban-rearm-postenrichment-index-step.md §2) :
//   5b enrichment FINESS (runBatchedRpc ingest_apply_rpps_finess_enrichment_batch)
//   5c ingest_build_rpps_staging_ban_indexes (sur données stabilisées)
//   5d ingest_analyze_rpps_staging (le planner DOIT voir les index neufs)
//   5e runBanGeocodeStep('rpps_staging')
//   6  atomicSwapTables
// Inverser 5c/5d ⇒ le planner ne voit pas les index neufs → full-scan +
// timeout 60 s. Mettre 5c AVANT 5b ⇒ les index BAN sont maintenus pendant
// l'UPDATE d'enrichment = re-régression 57014 (l'AGGRAVANT). Mettre BAN
// APRÈS le swap ⇒ on géocode une table qui a disparu. `main()` n'est pas
// exporté (il fait download/stream CSV) ; ce garde STATIQUE lit la source de
// `main()` et verrouille l'ORDRE TEXTUEL des sites d'appel — même discipline
// que les guards de parité migrations (textuel mais load-bearing, ancré sur
// de vrais sites d'appel, jamais un `.includes()` flou).
describe("rpps.ts main() — ordre strict 5b→5c→5d→5e→6 (séquence load-bearing)", () => {
  it("les sites d'appel apparaissent dans l'ordre 5b enrichment → 5c build-index → 5d re-analyze → 5e BAN → 6 swap", async () => {
    const fs = await import("node:fs");
    const url = await import("node:url");
    const rppsSrc = fs.readFileSync(
      url.fileURLToPath(new URL("./rpps.ts", import.meta.url)),
      "utf8",
    );
    // Borne au corps de `main()` : du `async function main(` jusqu'à la
    // 1re définition top-level suivante (`interface IngestStreamStats` /
    // `async function streamCsvToStaging`) — évite de matcher un site
    // homonyme hors séquence (ex. l'ANALYZE interne de runBanGeocodeStep).
    const mainStart = rppsSrc.indexOf("async function main(");
    expect(mainStart, "fonction main() introuvable dans rpps.ts").toBeGreaterThanOrEqual(0);
    const afterMain = rppsSrc.indexOf("\nasync function streamCsvToStaging", mainStart);
    expect(afterMain, "fin de main() (streamCsvToStaging) introuvable").toBeGreaterThan(mainStart);
    const body = rppsSrc.slice(mainStart, afterMain);

    // Ancres = vrais sites d'appel (pas de la prose). 5a/5d passent par
    // `callRpcFailLoud(...)` (borne anti-hang /review P2) → on ancre sur le
    // libellé d'erreur UNIQUE de chaque site (plus de `supabase.rpc("...")`
    // littéral pour l'ANALYZE). 5a = ANALYZE post-COPY (fix C2), PRÉCÈDE 5b ;
    // 5d = re-ANALYZE après build-index.
    const i5aAnalyze = body.indexOf('"Failed to ANALYZE rpps_staging before enrichment"');
    const i5bEnrich = body.indexOf('"ingest_apply_rpps_finess_enrichment_batch"');
    const i5cBuild = body.indexOf('supabase.rpc("ingest_build_rpps_staging_ban_indexes")');
    const i5dAnalyze = body.indexOf('"Failed to re-ANALYZE rpps_staging after BAN index build"');
    const i5eBan = body.indexOf('runBanGeocodeStep(supabase, log, "rpps_staging")');
    const i6Swap = body.indexOf('atomicSwapTables({ prodTable: "rpps" })');

    for (const [label, idx] of [
      ["5a ANALYZE post-COPY", i5aAnalyze],
      ["5b enrichment FINESS", i5bEnrich],
      ["5c ingest_build_rpps_staging_ban_indexes", i5cBuild],
      ["5d re-ANALYZE rpps_staging", i5dAnalyze],
      ["5e runBanGeocodeStep('rpps_staging')", i5eBan],
      ["6 atomicSwapTables", i6Swap],
    ] as const) {
      expect(idx, `site d'appel ${label} introuvable dans main()`).toBeGreaterThanOrEqual(0);
    }

    // 5a < 5b < 5c < 5d < 5e < 6 — chaîne strictement croissante.
    expect(i5aAnalyze).toBeLessThan(i5bEnrich);
    expect(i5bEnrich).toBeLessThan(i5cBuild);
    expect(i5cBuild).toBeLessThan(i5dAnalyze);
    expect(i5dAnalyze).toBeLessThan(i5eBan);
    expect(i5eBan).toBeLessThan(i6Swap);
  });
});
