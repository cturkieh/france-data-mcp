import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock supabase au niveau du module : sinon `getRppsById` appellerait
// `getUntypedAnonClient` qui throw `Error` (pas `RangeError`) quand
// `SUPABASE_URL` est absent en env de test — les tests d'acceptation
// passeraient alors par tautologie (env var manquante ≠ regex valide).
// Le mock retourne data: [] pour permettre une assertion `.resolves` qui
// exerce vraiment le chemin validation → RPC.
const mockRpc = vi.fn().mockResolvedValue({ data: [], error: null });
vi.mock("../storage/supabase.js", () => ({
  getUntypedAnonClient: () => ({ rpc: mockRpc }),
}));

import {
  CATEGORIE_CODES_DEFAUT,
  CATEGORIE_CODES_OFFICIELS,
  CATEGORIE_CODE_AGENT_PUBLIC,
  CATEGORIE_CODE_CIVIL,
  CATEGORIE_CODE_ETUDIANT,
  assertKnownRppsCodes,
  buildCategorieCodes,
  countRppsByCommune,
  getRppsById,
  getRppsByName,
  getRppsInRadius,
} from "./rpps-db.js";

/** Row brute RPPS minimale (tous champs présents) — surcharger via overrides. */
function makeRawRppsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    rpps_id: "810005156566",
    civilite: null,
    nom: "MARTIN",
    prenom: "JEAN",
    profession_code: null,
    profession_libelle: null,
    savoir_faire_code: null,
    savoir_faire_libelle: null,
    mode_exercice_code: null,
    mode_exercice_libelle: null,
    categorie_code: "C",
    categorie_libelle: "Civil",
    num_finess: null,
    num_finess_ej: null,
    siret: null,
    raison_sociale: null,
    adresse: null,
    code_postal: null,
    ville: null,
    code_departement: "75",
    code_insee: null,
    telephone: null,
    geom: null,
    ...overrides,
  };
}

// Pure unit tests pour les helpers catégorie ANS TRE_R09. Verrouille le
// contrat contre la dérive vers les codes fictifs `R`/`S`/`D` (jamais en
// base — l'ANS pré-filtre `PS_LibreAcces_Personne_activite` aux actifs).

describe("CATEGORIE_CODES_OFFICIELS", () => {
  it("matches the 3 codes effectively present in the ANS extraction (TRE_R09 minus deprecated F)", () => {
    expect([...CATEGORIE_CODES_OFFICIELS]).toEqual(["C", "E", "M"]);
  });

  it("never includes the deprecated F code (merged into M on 2026-02-23)", () => {
    expect(CATEGORIE_CODES_OFFICIELS).not.toContain("F");
  });

  it("never includes fictional codes R/S/D (active-only ANS pre-filter)", () => {
    for (const code of ["R", "S", "D"]) {
      expect(CATEGORIE_CODES_OFFICIELS).not.toContain(code);
    }
  });
});

describe("CATEGORIE_CODES_DEFAUT", () => {
  it("defaults to Civils only — agents publics and étudiants are opt-in", () => {
    expect([...CATEGORIE_CODES_DEFAUT]).toEqual([CATEGORIE_CODE_CIVIL]);
  });
});

describe("buildCategorieCodes", () => {
  it("returns Civils only when no flag is set", () => {
    expect(buildCategorieCodes({})).toEqual(["C"]);
    expect(buildCategorieCodes({ includeEtudiants: false, includeAgentsPublics: false })).toEqual([
      "C",
    ]);
  });

  it("adds Agents publics (M) when includeAgentsPublics is true", () => {
    expect(buildCategorieCodes({ includeAgentsPublics: true })).toEqual([
      CATEGORIE_CODE_CIVIL,
      CATEGORIE_CODE_AGENT_PUBLIC,
    ]);
  });

  it("adds Étudiants (E) when includeEtudiants is true", () => {
    expect(buildCategorieCodes({ includeEtudiants: true })).toEqual([
      CATEGORIE_CODE_CIVIL,
      CATEGORIE_CODE_ETUDIANT,
    ]);
  });

  it("includes all 3 codes when both flags are true", () => {
    const all = buildCategorieCodes({ includeEtudiants: true, includeAgentsPublics: true });
    expect(all).toEqual(["C", "M", "E"]);
    // Sanity check : same set as the official list (order-insensitive)
    expect([...all].sort()).toEqual([...CATEGORIE_CODES_OFFICIELS].sort());
  });

  it("never returns an empty array — the default Civil is always present", () => {
    // Empty array would silently cancel the SQL filter (cardinality = 0 →
    // default `[C]` SQL-side, but defensive contract here too).
    expect(buildCategorieCodes({}).length).toBeGreaterThan(0);
    expect(buildCategorieCodes({ includeEtudiants: true }).length).toBeGreaterThan(0);
  });
});

// Verrouille la 4-way sync entre TS const, TS function literal, SQL helper
// `rpps_categorie_match` et SQL RPC `rpps_par_specialite_dept` COALESCE.
// Sans ce test, un dev qui change `CATEGORIE_CODE_CIVIL = 'X'` côté TS
// passerait tsc/tests verts mais laisserait le SQL sur 'C' → résultat
// silencieusement vide ou incohérent en prod.
describe("V0.5.5 default — TS/SQL sync", () => {
  const migrationPath = join(
    __dirname,
    "../../supabase/migrations/20260510T040000_rpps_v055_categorie_codes_default_civil.sql",
  );
  // Strip les commentaires SQL (-- ... fin de ligne) pour ne matcher que le
  // code exécutable. Sinon un test passerait à vide tant qu'un commentaire
  // mentionne le pattern, même si le code SQL réel a divergé.
  const migrationSql = readFileSync(migrationPath, "utf-8").replace(/--[^\n]*/g, "");

  it("la migration SQL utilise le même default `[C]` que CATEGORIE_CODES_DEFAUT", () => {
    const defaultCode = CATEGORIE_CODES_DEFAUT[0];
    expect(defaultCode).toBe("C");
    // Helper SQL : `p_code = 'C' OR p_code IS NULL` quand cardinality(p_codes)=0
    expect(migrationSql).toMatch(new RegExp(`p_code\\s*=\\s*'${defaultCode}'\\s+OR`));
    // RPC EXECUTE format : COALESCE(NULLIF(...), ARRAY['C'])
    expect(migrationSql).toMatch(new RegExp(`ARRAY\\[\\s*'${defaultCode}'\\s*\\]`));
  });
});

// V0.5.6 — Verrouille le format des 3 IDNPS canary (12 chars en prod ANS),
// sans test on aurait introduit des IDs cassés (ex: 11 chars du V0.5.0
// placeholder qui ne matchaient jamais en base) sans signal.
describe("V0.5.6 canary RPPS — format IDNPS", () => {
  const canaryMigrationPath = join(
    __dirname,
    "../../supabase/migrations/20260510T050000_rpps_canary_seeds_v056.sql",
  );
  const canaryMigration = readFileSync(canaryMigrationPath, "utf-8").replace(/--[^\n]*/g, "");

  it("contient 3 IDNPS au format ANS (11 ou 12 chiffres)", () => {
    // Match les VALUES INSERT, pas les DELETE (placeholders historiques 11 chars).
    const insertBlock = canaryMigration.match(
      /INSERT INTO ingest_canary_targets[\s\S]+?ON CONFLICT/,
    );
    expect(insertBlock, "INSERT block missing in V0.5.6 migration").toBeTruthy();
    const idnpsMatches = insertBlock?.[0].match(/'rpps_id',\s*'(\d+)'/g) ?? [];
    expect(idnpsMatches.length).toBe(3);
    for (const match of idnpsMatches) {
      const id = match.match(/'(\d+)'/)?.[1];
      expect(id, `IDNPS extrait de ${match}`).toMatch(/^\d{11,12}$/);
    }
  });

  it("INSERT précède DELETE (pas de fenêtre table-vide pour le canary)", () => {
    const insertPos = canaryMigration.indexOf("INSERT INTO ingest_canary_targets");
    const deletePos = canaryMigration.indexOf("DELETE FROM ingest_canary_targets");
    expect(insertPos).toBeGreaterThan(0);
    expect(deletePos).toBeGreaterThan(insertPos);
  });
});

// V0.5.6 — Lock le contrat regex `getRppsById` (11 ou 12 chars). Sans ce
// test, le bug pré-V0.5.6 (regex /^\d{11}$/ qui rejetait les vrais IDs
// 12 chars en prod) pourrait revenir silencieusement.
describe("getRppsById — format rpps_id (V0.5.6 fix)", () => {
  // mockClear avant chaque cas pour pouvoir asserter le comptage d'appels
  // RPC sans interférence inter-tests.
  beforeEach(() => {
    mockRpc.mockClear();
  });

  // Pour les inputs valides : assertion couplée `.resolves` + `mockRpc.toHaveBeenCalledWith`
  // exerce vraiment la chaîne validation → RPC (sans la 2e assertion, un
  // futur court-circuit du RPC qui retournerait `[]` early passerait vert).
  // Pour les inputs invalides : `RangeError` est levé AVANT le RPC ; on
  // asserte ET sur l'instance ET sur le message stable ET sur l'absence
  // d'appel RPC — détection d'un revert via 3 gardes indépendantes.
  it("accepte un IDNPS 12 chars (format moderne avec préfixe 81)", async () => {
    await expect(getRppsById("810005156566")).resolves.toEqual([]);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("rpps_lookup_by_id", { p_rpps_id: "810005156566" });
  });

  it("accepte un IDNPS 11 chars (format legacy sans préfixe)", async () => {
    await expect(getRppsById("12345678901")).resolves.toEqual([]);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("rpps_lookup_by_id", { p_rpps_id: "12345678901" });
  });

  it("rejette un format manifestement invalide (10 chars, alpha, 13 chars)", async () => {
    await expect(getRppsById("1234567890")).rejects.toThrow(RangeError);
    await expect(getRppsById("1234567890")).rejects.toThrow(/rpps_id invalide/);
    await expect(getRppsById("abcdefghijk")).rejects.toThrow(RangeError);
    await expect(getRppsById("8100051565666")).rejects.toThrow(RangeError);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("trim les whitespaces avant validation (cohérent avec le pattern MCP)", async () => {
    await expect(getRppsById("  810005156566  ")).resolves.toEqual([]);
    // Le rpps_id passé à la RPC est trimmed (pas avec les whitespaces).
    expect(mockRpc).toHaveBeenCalledWith("rpps_lookup_by_id", { p_rpps_id: "810005156566" });
  });
});

describe("getRppsByName — V0.6.0 search par identité", () => {
  beforeEach(() => {
    mockRpc.mockClear();
    mockRpc.mockResolvedValue({ data: [], error: null });
  });

  it("nom seul → p_prenom null, p_departement null", async () => {
    await getRppsByName({ nom: "MARTIN" });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("rpps_search_by_name", {
      p_nom: "MARTIN",
      p_prenom: null,
      p_departement: null,
      p_categorie_codes: ["C"],
      p_limit: 101,
    });
  });

  it("nom + prenom + dept → tous les params passés à la RPC", async () => {
    await getRppsByName({ nom: "Martin", prenom: "Jean", departement: "75" });
    expect(mockRpc).toHaveBeenCalledWith("rpps_search_by_name", {
      p_nom: "Martin",
      p_prenom: "Jean",
      p_departement: "75",
      p_categorie_codes: ["C"],
      p_limit: 101,
    });
  });

  it("trim systématique sur nom/prenom (cohérent avec les autres tools)", async () => {
    await getRppsByName({ nom: "  Martin  ", prenom: "  Jean  " });
    expect(mockRpc).toHaveBeenCalledWith("rpps_search_by_name", {
      p_nom: "Martin",
      p_prenom: "Jean",
      p_departement: null,
      p_categorie_codes: ["C"],
      p_limit: 101,
    });
  });

  it("prenom vide après trim → traité comme absent (p_prenom null)", async () => {
    await getRppsByName({ nom: "Martin", prenom: "   " });
    expect(mockRpc).toHaveBeenCalledWith("rpps_search_by_name", {
      p_nom: "Martin",
      p_prenom: null,
      p_departement: null,
      p_categorie_codes: ["C"],
      p_limit: 101,
    });
  });

  it("nom vide ou whitespace → RangeError AVANT appel RPC", async () => {
    await expect(getRppsByName({ nom: "" })).rejects.toThrow(RangeError);
    await expect(getRppsByName({ nom: "   " })).rejects.toThrow(RangeError);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("departement malformé → throw via assertValidDept AVANT appel RPC", async () => {
    await expect(getRppsByName({ nom: "Martin", departement: "ZZ" })).rejects.toThrow();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("Corse 2A/2B accepté par assertValidDept", async () => {
    await getRppsByName({ nom: "Martin", departement: "2A" });
    expect(mockRpc).toHaveBeenCalled();
  });

  it("DOM/COM 3-chiffres accepté (974, 988, 971…)", async () => {
    await getRppsByName({ nom: "Martin", departement: "974" });
    expect(mockRpc).toHaveBeenCalled();
  });

  it("limit custom propagé en p_limit + 1 (détection truncated)", async () => {
    await getRppsByName({ nom: "Martin", limit: 5 });
    expect(mockRpc).toHaveBeenCalledWith(
      "rpps_search_by_name",
      expect.objectContaining({ p_limit: 6 }),
    );
  });

  it("resolveCategorieCodes : array vide explicite → fallback default `[C]` (pas pass-through `[]`)", async () => {
    // Sémantique critique : `categorieCodes: []` côté caller ne signifie PAS
    // "pas de filtre" ici — ce wrapper force le default TS-side `[C]`. À
    // distinguer des wrappers `?? []` (countRpps/getRppsInRadius/etc.) qui
    // laissent la RPC retomber sur son COALESCE SQL. Cf. JSDoc de
    // `resolveCategorieCodes` dans rpps-db.ts.
    await getRppsByName({ nom: "Martin", categorieCodes: [] });
    expect(mockRpc).toHaveBeenCalledWith(
      "rpps_search_by_name",
      expect.objectContaining({ p_categorie_codes: ["C"] }),
    );
  });

  it("resolveCategorieCodes : array non-vide → forwardé tel quel (pas de copy défensive observable)", async () => {
    await getRppsByName({ nom: "Martin", categorieCodes: ["C", "E"] });
    expect(mockRpc).toHaveBeenCalledWith(
      "rpps_search_by_name",
      expect.objectContaining({ p_categorie_codes: ["C", "E"] }),
    );
  });

  it("mappe match_score depuis row.match_score quand finite", async () => {
    mockRpc.mockResolvedValueOnce({
      data: [makeRawRppsRow({ match_score: 0.87 })],
      error: null,
    });

    const result = await getRppsByName({ nom: "Martin" });
    expect(result.count).toBe(1);
    expect(result.results[0]?.match_score).toBe(0.87);
  });

  it("omet match_score quand row.match_score est null ou non-finite", async () => {
    mockRpc.mockResolvedValueOnce({
      data: [makeRawRppsRow({ match_score: null })],
      error: null,
    });

    const result = await getRppsByName({ nom: "Martin" });
    expect(result.results[0]).not.toHaveProperty("match_score");
  });

  it("attache rppsSearchByNameMetadata (note trigram dans query_metadata.notes)", async () => {
    const result = await getRppsByName({ nom: "Martin" });
    expect(result.query_metadata?.geo_precision).toBe("centroide_commune_ans");
    const notesJoined = result.query_metadata?.notes.join(" ") ?? "";
    expect(notesJoined).toContain("similarité trigram");
    expect(notesJoined).toContain("match_score");
  });
});

describe("countRppsByCommune (V0.9)", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("appelle count_rpps_by_commune avec defaults `[]` (let RPC apply DREES)", async () => {
    mockRpc.mockResolvedValueOnce({ data: 42, error: null });
    const result = await countRppsByCommune({ codeInsee: "59009" });
    expect(result).toBe(42);
    expect(mockRpc).toHaveBeenCalledWith("count_rpps_by_commune", {
      p_code_insee: "59009",
      p_profession_code: null,
      p_savoir_faire_code: null,
      p_mode_exercice_codes: [],
      p_categorie_codes: [],
    });
  });

  it("propage tous les filtres TS → RPC params", async () => {
    mockRpc.mockResolvedValueOnce({ data: 17, error: null });
    await countRppsByCommune({
      codeInsee: "75108",
      professionCode: "10",
      savoirFaireCode: "SM04",
      modeExerciceCodes: ["L", "S", "M"],
      categorieCodes: ["C", "M"],
    });
    expect(mockRpc).toHaveBeenCalledWith("count_rpps_by_commune", {
      p_code_insee: "75108",
      p_profession_code: "10",
      p_savoir_faire_code: "SM04",
      p_mode_exercice_codes: ["L", "S", "M"],
      p_categorie_codes: ["C", "M"],
    });
  });

  it("code_insee malformé → RangeError AVANT appel RPC (mapping JSON-RPC -32602)", async () => {
    await expect(countRppsByCommune({ codeInsee: "ZZZZZ" })).rejects.toThrow(RangeError);
    await expect(countRppsByCommune({ codeInsee: "99999" })).rejects.toThrow(RangeError);
    await expect(countRppsByCommune({ codeInsee: "75" })).rejects.toThrow(RangeError);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("Corse 2A001 accepté + DOM 97411 accepté", async () => {
    mockRpc.mockResolvedValue({ data: 5, error: null });
    await countRppsByCommune({ codeInsee: "2A004" });
    await countRppsByCommune({ codeInsee: "97411" });
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it("RPC error → Error avec contexte formaté", async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "p_code_insee invalid" },
    });
    await expect(countRppsByCommune({ codeInsee: "75056" })).rejects.toThrow(
      /count_rpps_by_commune/,
    );
  });

  it("RPC returns non-number → throw avec dump JSON pour debug", async () => {
    mockRpc.mockResolvedValueOnce({ data: "not-a-number", error: null });
    await expect(countRppsByCommune({ codeInsee: "75056" })).rejects.toThrow(/unexpected type/);
  });

  it("RPC returns 0 (commune sans PS matching) → return 0 (pas une erreur)", async () => {
    mockRpc.mockResolvedValueOnce({ data: 0, error: null });
    const result = await countRppsByCommune({
      codeInsee: "59009",
      professionCode: "10",
      savoirFaireCode: "SM04", // cardiologue à Villeneuve-d'Ascq, possible 0
    });
    expect(result).toBe(0);
  });
});

describe("getRppsInRadius — geo_precision par PS (B5)", () => {
  const radiusRow = makeRawRppsRow({
    id: 7,
    prenom: "PIERRE",
    profession_code: "10",
    profession_libelle: "Médecin",
    mode_exercice_code: "L",
    mode_exercice_libelle: "Libéral",
    ville: "LILLE",
    code_departement: "59",
    code_insee: "59350",
    geom: { type: "Point", coordinates: [3.0573, 50.6292] },
    distance_meters: 1830,
  });

  it("marque geo_precision=centroide_commune sur chaque PS géolocalisé", async () => {
    mockRpc.mockResolvedValueOnce({ data: [radiusRow], error: null });
    const out = await getRppsInRadius({ center: { lat: 50.63, lon: 3.06 }, radiusKm: 5 });
    expect(out.results[0]?.geo_precision).toBe("centroide_commune");
  });

  it("omet geo_precision quand les coords sont absentes", async () => {
    mockRpc.mockResolvedValueOnce({ data: [{ ...radiusRow, geom: null }], error: null });
    const out = await getRppsInRadius({ center: { lat: 50.63, lon: 3.06 }, radiusKm: 5 });
    expect(out.results[0]?.coords).toBeNull();
    expect(out.results[0]?.geo_precision).toBeUndefined();
  });
});

describe("assertKnownRppsCodes (dette #1 — garde-fou nomenclature ANS)", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("no-op (aucun appel RPC) quand ni profession ni savoir_faire fournis", async () => {
    await expect(assertKnownRppsCodes({})).resolves.toBeUndefined();
    await expect(
      assertKnownRppsCodes({ professionCode: null, savoirFaireCode: null }),
    ).resolves.toBeUndefined();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("appelle rpps_nomenclature_exists avec les codes fournis", async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ profession_known: true, savoir_faire_known: true }],
      error: null,
    });
    await assertKnownRppsCodes({ professionCode: "10", savoirFaireCode: "SM04" });
    expect(mockRpc).toHaveBeenCalledWith("rpps_nomenclature_exists", {
      p_profession_code: "10",
      p_savoir_faire_code: "SM04",
    });
  });

  it("résout sans erreur quand les codes sont connus", async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ profession_known: true, savoir_faire_known: true }],
      error: null,
    });
    await expect(
      assertKnownRppsCodes({ professionCode: "10", savoirFaireCode: "SM04" }),
    ).resolves.toBeUndefined();
  });

  it("RangeError si profession_code inconnu (mappe JSON-RPC -32602)", async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ profession_known: false, savoir_faire_known: true }],
      error: null,
    });
    await expect(assertKnownRppsCodes({ professionCode: "999" })).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it("RangeError si savoir_faire_code inconnu (code Ameli homographe)", async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ profession_known: true, savoir_faire_known: false }],
      error: null,
    });
    await expect(assertKnownRppsCodes({ savoirFaireCode: "10" })).rejects.toThrow(
      /savoir_faire_code '10'/,
    );
  });

  it("ne signale PAS un code non fourni même si la RPC le dit false", async () => {
    // profession non fournie → profession_known:false ignoré (rien à valider).
    mockRpc.mockResolvedValueOnce({
      data: [{ profession_known: false, savoir_faire_known: true }],
      error: null,
    });
    await expect(assertKnownRppsCodes({ savoirFaireCode: "SM04" })).resolves.toBeUndefined();
  });

  it("Error (pas RangeError) si la RPC échoue — distinct d'un input invalide", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const err = await assertKnownRppsCodes({ professionCode: "10" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RangeError);
  });

  it("Error si la RPC ne retourne aucune ligne (invariant violé, pas swallow)", async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(assertKnownRppsCodes({ professionCode: "10" })).rejects.toThrow(/invariant/i);
  });
});
