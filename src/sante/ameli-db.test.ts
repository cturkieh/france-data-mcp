import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRpc = vi.fn();
vi.mock("../storage/supabase.js", () => ({
  getAnonClient: () => ({ rpc: mockRpc }),
  // `getAmeliInRadius` passe au client untyped depuis la migration
  // 20260522T003000 (param RPC `p_precise_only` absent des types générés).
  getUntypedAnonClient: () => ({ rpc: mockRpc }),
}));

// Le garde-fou nomenclature Ameli vit dans un module séparé : on le neutralise
// ici pour tester getAmeliInRadius/getAmeliBySpecialiteDept en isolation (son
// comportement propre est gardé par specialite-nomenclature-guard.test.ts ; le
// câblage est gardé par les assertions dédiées plus bas). Jumeau du pattern
// densite.test.ts qui spy assertKnownRppsCodes.
vi.mock("./specialite-nomenclature-guard.js", () => ({
  assertKnownAmeliSpecialiteCodes: vi.fn().mockResolvedValue(undefined),
  assertKnownCdsSpecialiteCodes: vi.fn().mockResolvedValue(undefined),
}));

import { _resetRefineAmeliWarnings } from "../core/query-metadata.js";
import {
  _resetAmeliGeoPrecisionMissingWarning,
  getAmeliBySpecialiteDept,
  getAmeliInRadius,
  listAmeliSpecialites,
  listAmeliTypesPs,
} from "./ameli-db.js";
import { assertKnownAmeliSpecialiteCodes } from "./specialite-nomenclature-guard.js";

const guardSpy = vi.mocked(assertKnownAmeliSpecialiteCodes);

const sampleRow = {
  id: 1234,
  nom: "MAYAUD",
  prenom: "NORBERT",
  civilite: "M",
  raison_sociale: "SELAS DE CARDIO",
  specialite_code: "03",
  specialite_libelle: "Cardiologue",
  type_ps_code: "1",
  type_ps_libelle: "Médecins",
  adresse: "60 AVENUE DE JASSERON",
  code_postal: "08000",
  ville: "CHARLEVILLE MEZIERES",
  code_departement: "08 ", // CHAR(3) padded — must be trimmed by toAmeliResult
  code_insee: "08105",
  secteur_conventionnel_code: "3",
  secteur_conventionnel_libelle: "Secteur 2",
  nature_exercice_libelle: "Libéral intégral",
  telephone: "0474247675",
  geom: { type: "Point", coordinates: [4.7203, 49.7724] },
  distance_meters: 280.5,
};

beforeEach(() => {
  mockRpc.mockReset();
  guardSpy.mockReset();
  guardSpy.mockResolvedValue(undefined);
  _resetAmeliGeoPrecisionMissingWarning();
  // Reset des flags 1-shot du module query-metadata (fix /review Passe 1
  // silent-failure-hunter H-2 : sans ça, un test précédent qui brûle le flag
  // empêche les tests suivants de vérifier qu'un warn est émis → flakiness
  // selon l'ordre d'exécution).
  _resetRefineAmeliWarnings();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAmeliInRadius", () => {
  it("calls ameli_in_radius RPC and maps each row", async () => {
    mockRpc.mockResolvedValue({ data: [sampleRow], error: null });
    const out = await getAmeliInRadius({
      center: { lat: 49.77, lon: 4.72 },
      radiusKm: 5,
      specialiteCodes: ["03"],
      typePsCodes: ["1"],
      limit: 50,
    });
    expect(mockRpc).toHaveBeenCalledWith("ameli_in_radius", {
      p_lat: 49.77,
      p_lon: 4.72,
      p_radius_meters: 5000,
      p_specialite_codes: ["03"],
      p_type_ps_codes: ["1"],
      p_limit: 51,
    });
    expect(out.count).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.results[0]?.identite.nom).toBe("MAYAUD");
    expect(out.results[0]?.adresse.code_departement).toBe("08"); // trimmed
    expect(out.results[0]?.coords).toEqual({ lat: 49.7724, lon: 4.7203 });
    expect(out.results[0]?.distance_km).toBe(0.28); // 280.5m → 0.28km
  });

  it("marque geo_precision=centroide_commune sur chaque PS géolocalisé (B5)", async () => {
    mockRpc.mockResolvedValue({ data: [sampleRow], error: null });
    const out = await getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5 });
    expect(out.results[0]?.geo_precision).toBe("centroide_commune");
  });

  it("omet geo_precision quand les coords sont absentes (B5)", async () => {
    const noGeom = { ...sampleRow, geom: null };
    mockRpc.mockResolvedValue({ data: [noGeom], error: null });
    const out = await getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5 });
    expect(out.results[0]?.coords).toBeNull();
    expect(out.results[0]?.geo_precision).toBeUndefined();
  });

  it("Chantier C — geom_source='ban_address' → geo_precision='adresse'", async () => {
    // RPC post-20260521T103000 expose geom_source. Une row BAN-géocodée doit
    // remonter `adresse` (≠ centroide_commune ~3 km) sinon le caller LLM tire
    // de mauvaises conclusions sur les distances.
    mockRpc.mockResolvedValue({
      data: [{ ...sampleRow, geom_source: "ban_address" }],
      error: null,
    });
    const out = await getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5 });
    expect(out.results[0]?.geo_precision).toBe("adresse");
  });

  it("Chantier C — geom_source='commune_centroid' explicite → geo_precision='centroide_commune'", async () => {
    mockRpc.mockResolvedValue({
      data: [{ ...sampleRow, geom_source: "commune_centroid" }],
      error: null,
    });
    const out = await getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5 });
    expect(out.results[0]?.geo_precision).toBe("centroide_commune");
  });

  it("Chantier C — fallback centroide_commune + warn 1-shot quand geom_source absent (RPC pré-migration)", async () => {
    // Fenêtre transitoire code↔migration : sampleRow ne porte pas
    // `geom_source` → fallback `centroide_commune` (mentir vers le bas, jamais
    // vers le haut). MAIS doit émettre 1× un warn console pour signaler à
    // l'opérateur que le chantier C est INVISIBLE côté tools (silent-failure
    // hunter H-2 Passe 1).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockRpc.mockResolvedValue({ data: [sampleRow, sampleRow], error: null });
    const out = await getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5 });
    expect(out.results[0]?.geo_precision).toBe("centroide_commune");
    expect(out.results[1]?.geo_precision).toBe("centroide_commune");
    // 1-shot : même 2 rows sans geom_source → 1 seul warn (pas spam).
    const matching = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes("[ameli-db] RPC returned a row without `geom_source`"),
    );
    expect(matching.length, "1 warn 1-shot attendu pour le fallback geom_source").toBe(1);
    warnSpy.mockRestore();
  });

  it("flags truncation when RPC returns limit+1 rows", async () => {
    const rows = Array.from({ length: 11 }, () => sampleRow);
    mockRpc.mockResolvedValue({ data: rows, error: null });
    const out = await getAmeliInRadius({
      center: { lat: 49.77, lon: 4.72 },
      radiusKm: 5,
      limit: 10,
    });
    expect(out.count).toBe(10);
    expect(out.truncated).toBe(true);
  });

  it("rejects out-of-range coordinates with RangeError", async () => {
    await expect(getAmeliInRadius({ center: { lat: 91, lon: 4.72 }, radiusKm: 5 })).rejects.toThrow(
      /lat must be in/,
    );
    await expect(
      getAmeliInRadius({ center: { lat: 49.77, lon: 200 }, radiusKm: 5 }),
    ).rejects.toThrow(/lon must be in/);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects radius > 50 km or <= 0 with RangeError", async () => {
    await expect(
      getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 51 }),
    ).rejects.toThrow(/radiusKm must be in/);
    await expect(
      getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 0 }),
    ).rejects.toThrow(/radiusKm must be in/);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejette un type_ps_code filtré à l'ingestion (3 = laboratoires) avec un message orientant vers FINESS", async () => {
    await expect(
      getAmeliInRadius({
        center: { lat: 49.77, lon: 4.72 },
        radiusKm: 5,
        typePsCodes: ["3"],
      }),
    ).rejects.toThrow(/n'est pas filtrable.*FINESS/s);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects limit out of [1, 500]", async () => {
    await expect(
      getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5, limit: 0 }),
    ).rejects.toThrow(/limit must be between/);
    await expect(
      getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5, limit: 501 }),
    ).rejects.toThrow(/limit must be between/);
  });

  it("formats RPC error with code, hint, and details", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "42703", message: "column missing", hint: "rebuild RPC", details: "x" },
    });
    await expect(
      getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5 }),
    ).rejects.toThrow(/ameli_in_radius \(42703\): column missing.*details: x.*hint: rebuild/);
  });

  it("defaults specialite_codes and type_ps_codes to empty arrays", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getAmeliInRadius({ center: { lat: 49.77, lon: 4.72 }, radiusKm: 5 });
    expect(mockRpc).toHaveBeenCalledWith(
      "ameli_in_radius",
      expect.objectContaining({ p_specialite_codes: [], p_type_ps_codes: [] }),
    );
  });

  it("propage preciseOnly=true au paramètre RPC p_precise_only", async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    await getAmeliInRadius({
      center: { lat: 48.85, lon: 2.35 },
      radiusKm: 5,
      preciseOnly: true,
    });
    expect(mockRpc).toHaveBeenCalledWith(
      "ameli_in_radius",
      expect.objectContaining({ p_precise_only: true }),
    );
  });

  // `p_precise_only` est OMIS de l'appel quand le caller ne demande pas le
  // mode précis → l'appel reste à 6 args, résolvable contre la RPC du schéma
  // de base (6 params) comme contre la RPC prod (7e param via DEFAULT FALSE).
  // C'est ce qui garde `ameli-db.integration.test.ts` vert (cf. getAmeliInRadius).
  it("preciseOnly absent → p_precise_only OMIS de l'appel RPC (compat schéma de base 6-param)", async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    await getAmeliInRadius({ center: { lat: 48.85, lon: 2.35 }, radiusKm: 5 });
    const rpcArgs = mockRpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(rpcArgs).not.toHaveProperty("p_precise_only");
  });

  it("preciseOnly=false explicite → p_precise_only OMIS (false = comportement par défaut, inutile à envoyer)", async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    await getAmeliInRadius({ center: { lat: 48.85, lon: 2.35 }, radiusKm: 5, preciseOnly: false });
    const rpcArgs = mockRpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(rpcArgs).not.toHaveProperty("p_precise_only");
  });

  // Jumeau RPPS — preciseOnly=true + 0 résultat = ambiguïté zone sans PS
  // adresse-précise vs rayon trop court. Note metadata explicite pour que le
  // LLM puisse suggérer le mode hybride (qui inclurait les PS centroïde).
  it("preciseOnly=true + 0 résultats → note metadata 'precise_only=true et 0 résultat'", async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    const out = await getAmeliInRadius({
      center: { lat: 48.85, lon: 2.35 },
      radiusKm: 5,
      preciseOnly: true,
    });
    expect(out.count).toBe(0);
    const notesJoined = out.query_metadata?.notes.join(" ") ?? "";
    expect(notesJoined).toMatch(/precise_only=true.*0 résultat/);
    expect(notesJoined).toMatch(/precise_only=false|mode hybride/);
  });

  it("preciseOnly absent + 0 résultats → PAS de note 'precise_only' (le caller n'a rien exclu)", async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    const out = await getAmeliInRadius({ center: { lat: 48.85, lon: 2.35 }, radiusKm: 5 });
    expect(out.count).toBe(0);
    const notesJoined = out.query_metadata?.notes.join(" ") ?? "";
    expect(notesJoined).not.toMatch(/precise_only=true.*0 résultat/);
  });

  // Jumeau getRppsInRadius — caller npm hors MCP (sans coerceBoolean filet)
  // passant preciseOnly:"yes" doit throw RangeError au boundary lib, pas
  // retomber silencieusement en hybride.
  it("preciseOnly typé non-boolean → RangeError au boundary lib (hors MCP)", async () => {
    await expect(
      getAmeliInRadius({
        center: { lat: 48.85, lon: 2.35 },
        radiusKm: 5,
        // biome-ignore lint/suspicious/noExplicitAny: simule un caller npm sans filet TS
        preciseOnly: "yes" as any,
      }),
    ).rejects.toThrow(RangeError);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("getAmeliBySpecialiteDept", () => {
  it("calls ameli_by_specialite_dept with explicit nulls for omitted filters", async () => {
    // The dept RPC returns NULL::DOUBLE PRECISION for distance_meters,
    // mirror that in the mock so distance_km comes back null.
    mockRpc.mockResolvedValue({ data: [{ ...sampleRow, distance_meters: null }], error: null });
    const out = await getAmeliBySpecialiteDept({ departement: "08", specialiteCode: "03" });
    expect(mockRpc).toHaveBeenCalledWith("ameli_by_specialite_dept", {
      p_departement: "08",
      p_specialite_code: "03",
      p_type_ps_code: null,
      p_limit: 101,
      p_offset: 0,
    });
    expect(out.count).toBe(1);
    expect(out.results[0]?.distance_km).toBeNull();
  });

  it("accepts Corse 2A/2B and DOM 974", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getAmeliBySpecialiteDept({ departement: "2A" });
    await getAmeliBySpecialiteDept({ departement: "974" });
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid department codes", async () => {
    await expect(getAmeliBySpecialiteDept({ departement: "20" })).rejects.toThrow(
      /must be a valid INSEE code/,
    );
    await expect(getAmeliBySpecialiteDept({ departement: "999" })).rejects.toThrow(
      /must be a valid INSEE code/,
    );
    await expect(getAmeliBySpecialiteDept({ departement: "" })).rejects.toThrow(
      /must be a valid INSEE code/,
    );
  });

  it("forwarde offset au RPC pour énumérer un département à fort effectif", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getAmeliBySpecialiteDept({ departement: "75", limit: 100, offset: 200 });
    // Strict matcher : un refactor qui transposerait p_specialite_code et
    // p_type_ps_code dans le code-path offset doit être détecté.
    expect(mockRpc).toHaveBeenCalledWith("ameli_by_specialite_dept", {
      p_departement: "75",
      p_specialite_code: null,
      p_type_ps_code: null,
      p_limit: 101,
      p_offset: 200,
    });
  });

  it("rejette un offset négatif ou hors borne avec RangeError", async () => {
    await expect(getAmeliBySpecialiteDept({ departement: "75", offset: -1 })).rejects.toThrow(
      /offset must be between/,
    );
    await expect(getAmeliBySpecialiteDept({ departement: "75", offset: 200_000 })).rejects.toThrow(
      /offset must be between/,
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("câblage garde-fou nomenclature Ameli (Niveau 1 — specialite_code)", () => {
  it("getAmeliInRadius valide les specialite_codes via le garde-fou", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getAmeliInRadius({
      center: { lat: 49.77, lon: 4.72 },
      radiusKm: 5,
      specialiteCodes: ["03"],
    });
    expect(guardSpy).toHaveBeenCalledWith(["03"]);
  });

  it("getAmeliInRadius : une RangeError du garde-fou remonte (code inconnu → -32602)", async () => {
    guardSpy.mockRejectedValueOnce(new RangeError("Code(s) spécialité Ameli inconnu(s)"));
    await expect(
      getAmeliInRadius({
        center: { lat: 49.77, lon: 4.72 },
        radiusKm: 5,
        specialiteCodes: ["SM04"],
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("getAmeliBySpecialiteDept valide le specialite_code (emballé en tableau)", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getAmeliBySpecialiteDept({ departement: "75", specialiteCode: "03" });
    expect(guardSpy).toHaveBeenCalledWith(["03"]);
  });

  it("getAmeliBySpecialiteDept : garde-fou appelé avec undefined si aucun specialite_code (no-op)", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await getAmeliBySpecialiteDept({ departement: "75" });
    expect(guardSpy).toHaveBeenCalledWith(undefined);
  });
});

describe("listAmeliSpecialites", () => {
  it("call le RPC et map les rows en AmeliSpecialiteEntry triés par count", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          code: "24",
          libelle: "Infirmier",
          libelle_clarifie: "Infirmier",
          type_ps_code: "2",
          type_ps_libelle: "Autres PS (...)",
          count: "104041",
          is_libelle_partage: false,
        },
        {
          code: "01",
          libelle: "Médecin généraliste",
          libelle_clarifie: "Médecin généraliste (code 01, 55K)",
          type_ps_code: "1",
          type_ps_libelle: "Médecins généralistes et spécialistes",
          count: 55381,
          is_libelle_partage: true,
        },
      ],
      error: null,
    });
    const out = await listAmeliSpecialites();
    expect(mockRpc).toHaveBeenCalledWith("ameli_lister_specialites");
    expect(out).toHaveLength(2);
    expect(out[0]?.code).toBe("24");
    expect(out[0]?.count).toBe(104041); // string BIGINT coerced to number
    expect(out[0]?.libelle_clarifie).toBe("Infirmier"); // unique → identique au libelle
    expect(out[0]?.is_libelle_partage).toBe(false);
    expect(out[1]?.count).toBe(55381); // number passes through
    expect(out[1]?.libelle_clarifie).toBe("Médecin généraliste (code 01, 55K)");
    expect(out[1]?.is_libelle_partage).toBe(true);
  });

  it("propage libelle_clarifie pour les libellés partagés (V0.4.4 — Bug B7)", async () => {
    // Cas réel : 3 codes différents partagent le libellé "Médecin généraliste".
    // Le RPC SQL calcule libelle_clarifie via window function PARTITION BY libelle.
    mockRpc.mockResolvedValue({
      data: [
        {
          code: "01",
          libelle: "Médecin généraliste",
          libelle_clarifie: "Médecin généraliste (code 01, 55K)",
          type_ps_code: "1",
          type_ps_libelle: "Médecins",
          count: 55381,
          is_libelle_partage: true,
        },
        {
          code: "22",
          libelle: "Médecin généraliste",
          libelle_clarifie: "Médecin généraliste (code 22, 5.8K)",
          type_ps_code: "1",
          type_ps_libelle: "Médecins",
          count: 5808,
          is_libelle_partage: true,
        },
        {
          code: "03",
          libelle: "Cardiologue",
          libelle_clarifie: "Cardiologue",
          type_ps_code: "1",
          type_ps_libelle: "Médecins",
          count: 7000,
          is_libelle_partage: false,
        },
      ],
      error: null,
    });
    const out = await listAmeliSpecialites();
    expect(out).toHaveLength(3);
    // Les 2 "Médecin généraliste" sont désambiguïsés via leur code et count.
    const mg01 = out.find((s) => s.code === "01");
    const mg22 = out.find((s) => s.code === "22");
    expect(mg01?.libelle_clarifie).toBe("Médecin généraliste (code 01, 55K)");
    expect(mg01?.is_libelle_partage).toBe(true);
    expect(mg22?.libelle_clarifie).toBe("Médecin généraliste (code 22, 5.8K)");
    expect(mg22?.is_libelle_partage).toBe(true);
    // Le libellé unique reste inchangé.
    const cardio = out.find((s) => s.code === "03");
    expect(cardio?.libelle_clarifie).toBe("Cardiologue");
    expect(cardio?.is_libelle_partage).toBe(false);
  });

  it("fallback sur libelle si le RPC est pré-V0.4.4 (libelle_clarifie absent)", async () => {
    // Si la migration SQL n'est pas encore appliquée, le RPC ne renvoie pas
    // les nouvelles colonnes — le code TS doit fallback sur `libelle` brut
    // sans planter ni produire de "undefined" côté caller.
    mockRpc.mockResolvedValue({
      data: [
        {
          code: "01",
          libelle: "Médecin généraliste",
          type_ps_code: "1",
          type_ps_libelle: "Médecins",
          count: 55381,
        },
      ],
      error: null,
    });
    const out = await listAmeliSpecialites();
    expect(out).toHaveLength(1);
    expect(out[0]?.libelle_clarifie).toBe("Médecin généraliste");
    expect(out[0]?.is_libelle_partage).toBe(false);
  });

  it("filtre les rows sans code (defensive)", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          code: null,
          libelle: "x",
          libelle_clarifie: "x",
          type_ps_code: "1",
          type_ps_libelle: "y",
          count: 1,
          is_libelle_partage: false,
        },
        {
          code: "01",
          libelle: "MG",
          libelle_clarifie: "MG",
          type_ps_code: "1",
          type_ps_libelle: "Médecins",
          count: 100,
          is_libelle_partage: false,
        },
      ],
      error: null,
    });
    const out = await listAmeliSpecialites();
    expect(out).toHaveLength(1);
    expect(out[0]?.code).toBe("01");
  });

  it("retourne un array vide quand le RPC renvoie un array vide (catalogue absent)", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    expect(await listAmeliSpecialites()).toEqual([]);
  });

  it("throw quand le RPC viole son contrat (data null sans error — V0.4.3 expectRpcRows)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await expect(listAmeliSpecialites()).rejects.toThrow(/RPC contract violation/);
  });

  it("propage l'erreur RPC en exception", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(listAmeliSpecialites()).rejects.toThrow(/ameli_lister_specialites.*boom/);
  });
});

describe("listAmeliTypesPs", () => {
  it("clarifie le libellé du code 2 quand la source matche la référence", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          code: "2",
          libelle_source: "Autres PS (chirurgien-dentiste, sage-femme, infirmier, orthoptiste…)",
          count: "245990",
          specialites_presentes: [
            { code: "24", libelle: "Infirmier", count: 104041 },
            { code: "26", libelle: "Masseur-kinésithérapeute", count: 86588 },
          ],
        },
      ],
      error: null,
    });
    const out = await listAmeliTypesPs();
    expect(out[0]?.code).toBe("2");
    expect(out[0]?.libelle_source).toContain("Autres PS");
    expect(out[0]?.libelle_clarifie).toContain("Auxiliaires médicaux");
    expect(out[0]?.specialites_presentes).toHaveLength(2);
    expect(out[0]?.specialites_presentes[0]?.code).toBe("24");
  });

  it("garde la source quand elle ne matche pas la référence (drift detection)", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          code: "2",
          libelle_source: "LIBELLE AMELI MODIFIE EN UPSTREAM",
          count: 245990,
          specialites_presentes: [],
        },
      ],
      error: null,
    });
    const out = await listAmeliTypesPs();
    expect(out[0]?.libelle_clarifie).toBe("LIBELLE AMELI MODIFIE EN UPSTREAM");
  });

  it("gère specialites_presentes null/undefined", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          code: "1",
          libelle_source: "Médecins généralistes et spécialistes",
          count: 172150,
          specialites_presentes: null,
        },
      ],
      error: null,
    });
    const out = await listAmeliTypesPs();
    expect(out[0]?.specialites_presentes).toEqual([]);
  });
});
