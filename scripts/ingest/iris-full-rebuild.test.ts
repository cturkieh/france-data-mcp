/**
 * Garde-fous de la vue `iris_full` (sans base).
 *
 * Une vue suit ses tables par OID : après une bascule IRIS (RENAME `iris` →
 * `iris_previous`), `iris_full` lirait l'ancien millésime. `iris.ts` la rattache
 * par `ingest_rebuild_iris_full()` (migration `20261122T230000`), avant la
 * première bascule et après la dernière. Ce fichier vérifie :
 *  - que la définition recopiée dans la fonction reste celle de la vue ;
 *  - que toute vue créée par migration a sa fonction de reconstruction ;
 *  - le câblage dans `main()` et le comportement de `rebuildIrisFull`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PgErrorLike } from "../../src/core/index.js";
import { IngestError } from "./ingest-error.js";
import { __TESTING__ } from "./iris.js";
import {
  allMigrationsSql,
  ingestDir,
  latestFunctionBody,
  latestFunctionDef,
  migrationsDir,
} from "./migration-sql.js";

const {
  rebuildIrisFull,
  rebuildIrisFullAfterFailure,
  IRIS_FULL_TABLES,
  REBUILD_MAX_ATTEMPTS,
  REBUILD_RETRY_DELAY_MS,
  REBUILD_AFTER_FAILURE_TIMEOUT_MS,
} = __TESTING__;

const REBUILD_FN = "ingest_rebuild_iris_full";

/**
 * Vue → fonction qui la redéfinit après bascule. Toute nouvelle vue lisant une
 * table basculée par `ingest_atomic_swap` doit avoir la sienne, et figurer ici.
 */
const VIEW_REBUILDERS: Record<string, string> = {
  iris_full: REBUILD_FN,
};

/** Retire les commentaires `--` et les corps dollar-quotés : reste le SQL de niveau fichier. */
function fileLevelSql(sql: string): string {
  const noComments = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  return noComments.replace(/(\$[a-zA-Z_]*\$)[\s\S]*?\1/g, " ");
}

const CREATE_VIEW_RE =
  /\bcreate\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(?:recursive\s+)?view\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;

/** SELECT (jusqu'au `;`) de la dernière `CREATE [OR REPLACE] VIEW <name>` du texte, compacté. */
function lastViewSelect(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?view\\s+(?:public\\.)?${name}\\b[\\s\\S]*?\\bas\\s+(select\\b[\\s\\S]*?);`,
    "gi",
  );
  let last = "";
  for (const m of sql.matchAll(re)) last = m[1] ?? "";
  return last.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Valeur en ms d'un `SET <param> = '<n><unité>'` de l'en-tête, null si absent ou illisible. */
function headerTimeoutMs(header: string, param: string): number | null {
  const m = header.match(new RegExp(`\\bset\\s+${param}\\s*(?:=|to)\\s*'(\\d+)\\s*(ms|s|min)?'`));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  return unit === "min" ? n * 60_000 : unit === "s" ? n * 1000 : n;
}

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

describe("iris_full : la fonction de reconstruction reste fidèle à la vue", () => {
  it("le SELECT de ingest_rebuild_iris_full est celui de la dernière CREATE VIEW iris_full de niveau fichier", () => {
    const fileLevel = migrationFiles()
      .map((f) => fileLevelSql(readFileSync(`${migrationsDir}/${f}`, "utf8")))
      .join("\n");
    const canonical = lastViewSelect(fileLevel, "iris_full");
    expect(
      canonical.length,
      "CREATE VIEW iris_full introuvable hors corps de fonction",
    ).toBeGreaterThan(0);

    const body = latestFunctionBody(allMigrationsSql(), REBUILD_FN, { stripComments: true });
    expect(body.length, `${REBUILD_FN} introuvable dans les migrations`).toBeGreaterThan(0);
    const rebuilt = lastViewSelect(body, "iris_full");
    expect(
      rebuilt,
      `${REBUILD_FN} redéfinit iris_full avec un SELECT différent de la vue en place : recopier la nouvelle définition dans la fonction. Vue="${canonical}" Fonction="${rebuilt}"`,
    ).toBe(canonical);
  });

  it("la fonction redit security_invoker, sans CASCADE ni DROP VIEW", () => {
    const body = latestFunctionBody(allMigrationsSql(), REBUILD_FN, {
      stripComments: true,
    }).toLowerCase();
    expect(
      body,
      "security_invoker = true absent : la vue perdrait l'option au CREATE OR REPLACE",
    ).toMatch(/with\s*\(\s*security_invoker\s*=\s*true\s*\)/);
    expect(body, "CASCADE dans la fonction : détruirait les objets dépendants").not.toMatch(
      /\bcascade\b/,
    );
    expect(body, "DROP VIEW dans la fonction : la vue perdrait son OID et ses droits").not.toMatch(
      /\bdrop\s+view\b/,
    );
  });

  it("l'en-tête de la fonction pose statement_timeout < 60 s et lock_timeout < 8 s", () => {
    // En-tête seulement : un SET dans le corps fuirait dans la session du pool.
    const def = latestFunctionDef(REBUILD_FN);
    const asIdx = def.search(/\bas\s+\$\$/);
    expect(asIdx, `${REBUILD_FN} : en-tête introuvable`).toBeGreaterThan(0);
    const header = def.slice(0, asIdx);

    const statementMs = headerTimeoutMs(header, "statement_timeout");
    expect(
      statementMs,
      "statement_timeout absent de l'en-tête : l'appel PostgREST hériterait des 8 s d'authenticator",
    ).not.toBeNull();
    expect(
      statementMs ?? Number.POSITIVE_INFINITY,
      "statement_timeout ≥ 60 s : la passerelle PostgREST coupe avant",
    ).toBeLessThan(60_000);

    const lockMs = headerTimeoutMs(header, "lock_timeout");
    expect(
      lockMs,
      "lock_timeout absent de l'en-tête : la redéfinition bloquerait les lectures derrière une requête longue",
    ).not.toBeNull();
    expect(
      lockMs ?? Number.POSITIVE_INFINITY,
      "lock_timeout ≥ 8 s (budget hérité d'authenticator)",
    ).toBeLessThan(8_000);
  });

  it("toute vue non matérialisée créée par une migration a sa fonction de reconstruction déclarée", () => {
    const views = new Set<string>();
    for (const f of migrationFiles()) {
      const sql = fileLevelSql(readFileSync(`${migrationsDir}/${f}`, "utf8"));
      for (const m of sql.matchAll(CREATE_VIEW_RE)) views.add((m[1] ?? "").toLowerCase());
    }
    expect(views.size, "aucune vue trouvée : le lecteur de migrations est cassé").toBeGreaterThan(
      0,
    );

    const sansReconstruction = [...views].filter((v) => !(v in VIEW_REBUILDERS));
    expect(
      sansReconstruction,
      `vue(s) sans fonction de reconstruction : ${sansReconstruction.join(", ")}. Une vue suit ses tables par OID : si elle lit une table basculée par ingest_atomic_swap, elle servira l'ancienne après la bascule. Écrire une fonction ingest_rebuild_<vue> (modèle ${REBUILD_FN}), l'appeler depuis le script d'ingestion et la déclarer dans VIEW_REBUILDERS.`,
    ).toEqual([]);

    for (const [view, fn] of Object.entries(VIEW_REBUILDERS)) {
      const body = latestFunctionBody(allMigrationsSql(), fn, { stripComments: true });
      expect(body, `${fn} (déclarée pour ${view}) ne redéfinit pas ${view}`).toMatch(
        new RegExp(`create\\s+or\\s+replace\\s+view\\s+(?:public\\.)?${view}\\b`, "i"),
      );
    }
  });
});

describe("iris.ts : câblage de la reconstruction dans main()", () => {
  const src = readFileSync(`${ingestDir}/iris.ts`, "utf8");
  const mainStart = src.indexOf("async function main(");
  const mainEnd = src.indexOf("\n}\n", mainStart);
  const mainSrc = src
    .slice(mainStart, mainEnd)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const calls = [...mainSrc.matchAll(/\brebuildIrisFull\(\s*supabase\s*,\s*"(\w+)"/g)].map((m) => ({
    index: m.index ?? -1,
    moment: m[1],
  }));
  const contours = mainSrc.indexOf("ingestContours(");
  const lastSwap = mainSrc.lastIndexOf("swappedBlocks.push(");
  const canary = mainSrc.indexOf("runAndRecordCanary(");
  const catchIdx = mainSrc.search(/\}\s*catch\s*\(/);

  it("main() et ses repères sont trouvés", () => {
    expect(mainStart).toBeGreaterThanOrEqual(0);
    expect(mainEnd).toBeGreaterThan(mainStart);
    expect(contours, "ingestContours( absent de main()").toBeGreaterThan(0);
    expect(lastSwap, "swappedBlocks.push( absent de main()").toBeGreaterThan(contours);
    expect(canary, "runAndRecordCanary( absent de main()").toBeGreaterThan(lastSwap);
    expect(catchIdx, "catch absent de main()").toBeGreaterThan(canary);
  });

  it('l\'appel avant ingestContours( porte "avant_bascule", puis basculePossible est posé', () => {
    const avant = calls.filter((c) => c.index < contours);
    expect(
      avant.map((c) => c.moment),
      'il faut exactement un rebuildIrisFull(supabase, "avant_bascule") avant ingestContours(',
    ).toEqual(["avant_bascule"]);
    const flag = mainSrc.indexOf("basculePossible = true");
    expect(
      flag > (avant[0]?.index ?? Number.POSITIVE_INFINITY) && flag < contours,
      "basculePossible = true doit suivre l'appel d'avant bascule et précéder ingestContours(",
    ).toBe(true);
  });

  it('l\'appel entre la dernière bascule et le canary porte "apres_bascule", précédé de rebuildApresTentee = true', () => {
    const apres = calls.filter((c) => c.index > lastSwap && c.index < canary);
    expect(
      apres.map((c) => c.moment),
      'il faut exactement un rebuildIrisFull(supabase, "apres_bascule") entre la dernière bascule et le canary',
    ).toEqual(["apres_bascule"]);
    const flag = mainSrc.indexOf("rebuildApresTentee = true");
    expect(
      flag > lastSwap && flag < (apres[0]?.index ?? -1),
      "rebuildApresTentee = true doit se trouver entre la dernière bascule et l'appel d'après bascule",
    ).toBe(true);
  });

  it("le catch tente le rattachement avant d'écrire ingest_log, et son suffixe entre dans error_message", () => {
    const catchSrc = mainSrc.slice(catchIdx);
    const m = catchSrc.match(/const\s+(\w+)\s*=\s*await\s+rebuildIrisFullAfterFailure\(/);
    expect(
      m,
      "rebuildIrisFullAfterFailure( absent du catch (ou résultat non conservé)",
    ).not.toBeNull();
    const writeIdx = catchSrc.indexOf("writeIngestLogFailureFallback(");
    expect(writeIdx, "writeIngestLogFailureFallback( absent du catch").toBeGreaterThan(0);
    expect(m?.index ?? Number.POSITIVE_INFINITY).toBeLessThan(writeIdx);
    const varName = m?.[1] ?? "";
    const assign = catchSrc
      .slice(m?.index ?? 0, writeIdx)
      .match(/log\.error_message\s*=([\s\S]*?);\n/);
    expect(
      assign,
      "log.error_message non affecté entre le rattachement et l'écriture d'ingest_log",
    ).not.toBeNull();
    expect(assign?.[1] ?? "", `le suffixe ${varName} n'entre pas dans log.error_message`).toContain(
      `\${${varName}}`,
    );
  });
});

type RpcResult = { data: unknown; error: PgErrorLike | null };
type FakeStep = RpcResult | "reject" | "hang";

function fakeClient(steps: FakeStep[]) {
  const rpc = vi.fn((_fn: "ingest_rebuild_iris_full"): Promise<RpcResult> => {
    const next = steps.shift();
    if (next === undefined) throw new Error("appel rpc non prévu par le test");
    if (next === "reject") return Promise.reject(new Error("socket hang up"));
    if (next === "hang") return new Promise<RpcResult>(() => {});
    return Promise.resolve(next);
  });
  return { client: { rpc }, rpc };
}

const REJECT = "reject" as const;
const HANG = "hang" as const;
const NETWORK: RpcResult = {
  data: null,
  error: {
    code: "",
    message: "TypeError: fetch failed",
    details: "Error: read ECONNRESET",
    hint: "",
  },
};

const OK: RpcResult = { data: [...IRIS_FULL_TABLES], error: null };
const LOCK: RpcResult = { data: null, error: { code: "55P03", message: "lock timeout" } };
const TIMEOUT: RpcResult = { data: null, error: { code: "57014", message: "statement timeout" } };

async function catchIngestError(p: Promise<unknown>): Promise<IngestError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(IngestError);
  return err as IngestError;
}

describe("rebuildIrisFull", () => {
  it("succès direct : un appel, aucune attente", async () => {
    const { client, rpc } = fakeClient([OK]);
    const sleep = vi.fn(async () => {});
    await rebuildIrisFull(client, "apres_bascule", { sleep });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("ingest_rebuild_iris_full");
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["liste incomplète", ["iris", "iris_familles", "iris_population"]],
    ["tables _previous", ["iris_previous", "iris_familles", "iris_population", "iris_revenu"]],
    ["ordre différent", ["iris_revenu", "iris", "iris_familles", "iris_population"]],
    ["chaîne", "{iris,iris_familles,iris_population,iris_revenu}"],
  ])("retour inattendu (%s) → IngestError", async (_label, data) => {
    const { client } = fakeClient([{ data, error: null }]);
    const err = await catchIngestError(
      rebuildIrisFull(client, "apres_bascule", { sleep: vi.fn(async () => {}) }),
    );
    expect(err.message).toContain("SELECT ingest_rebuild_iris_full();");
  });

  it("transitoire puis succès : deux appels, une attente de 2 s", async () => {
    const { client, rpc } = fakeClient([LOCK, OK]);
    const sleep = vi.fn(async () => {});
    await rebuildIrisFull(client, "apres_bascule", { sleep });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(REBUILD_RETRY_DELAY_MS);
    expect(REBUILD_RETRY_DELAY_MS).toBe(2000);
  });

  it("trois transitoires → IngestError après 3 appels", async () => {
    const { client, rpc } = fakeClient([LOCK, TIMEOUT, LOCK]);
    const sleep = vi.fn(async () => {});
    const err = await catchIngestError(rebuildIrisFull(client, "apres_bascule", { sleep }));
    expect(REBUILD_MAX_ATTEMPTS).toBe(3);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(err.message).toContain("55P03");
    expect(err.message).toContain("après bascule");
    expect(err.message).toContain("SELECT ingest_rebuild_iris_full();");
  });

  it.each(["PGRST202", "42501"])(
    "erreur structurelle %s → IngestError au premier appel",
    async (code) => {
      const { client, rpc } = fakeClient([{ data: null, error: { code, message: "boom" } }]);
      const sleep = vi.fn(async () => {});
      const err = await catchIngestError(rebuildIrisFull(client, "apres_bascule", { sleep }));
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(err.message).toContain(code);
      expect(err.message).toContain("SELECT ingest_rebuild_iris_full();");
    },
  );

  it("42P16 → pas de réessai, consigne de migration au lieu de la relance", async () => {
    const { client, rpc } = fakeClient([
      { data: null, error: { code: "42P16", message: "cannot drop columns from view" } },
    ]);
    const err = await catchIngestError(
      rebuildIrisFull(client, "apres_bascule", { sleep: vi.fn(async () => {}) }),
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(err.message).toContain("42P16");
    expect(err.message).toContain("il faut une migration");
    expect(err.message).not.toContain("Réparation à la main");
  });

  it.each<[string, FakeStep]>([
    ["coupure réseau (code vide)", NETWORK],
    [
      "erreur sans code (corps de passerelle)",
      { data: null, error: { message: "upstream request timeout" } },
    ],
    [
      "code null (JSON, hors du type déclaré)",
      { data: null, error: { code: null, message: "Bad Gateway" } as unknown as PgErrorLike },
    ],
    ["rpc() qui rejette", REJECT],
  ])("%s → transitoire : réessai puis succès", async (_label, first) => {
    const { client, rpc } = fakeClient([first, OK]);
    const sleep = vi.fn(async () => {});
    await rebuildIrisFull(client, "apres_bascule", { sleep });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("coupure réseau persistante → IngestError avec code none et details", async () => {
    const { client, rpc } = fakeClient([NETWORK, NETWORK, NETWORK]);
    const err = await catchIngestError(
      rebuildIrisFull(client, "apres_bascule", { sleep: vi.fn(async () => {}) }),
    );
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(err.message).toContain("code=none");
    expect(err.message).toContain("ECONNRESET");
  });

  it("details et hint longs sont tronqués", async () => {
    const long = "x".repeat(1000);
    const { client } = fakeClient([
      { data: null, error: { code: "42501", message: "refus", details: long, hint: long } },
    ]);
    const err = await catchIngestError(
      rebuildIrisFull(client, "apres_bascule", { sleep: vi.fn(async () => {}) }),
    );
    expect(err.message).toContain("details: ");
    expect(err.message).toContain("hint: ");
    expect(err.message.length).toBeLessThan(1000);
  });

  it("rpc() qui rejette → réessai, puis IngestError avec la cause", async () => {
    const { client, rpc } = fakeClient([REJECT, REJECT, REJECT]);
    const sleep = vi.fn(async () => {});
    const err = await catchIngestError(rebuildIrisFull(client, "apres_bascule", { sleep }));
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(err.phase).toBe("swap");
    expect(err.message).toContain("socket hang up");
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("phase pre_validate avant bascule, swap après", async () => {
    const structural: RpcResult = { data: null, error: { code: "PGRST202", message: "absente" } };
    const avant = await catchIngestError(
      rebuildIrisFull(fakeClient([structural]).client, "avant_bascule"),
    );
    expect(avant.phase).toBe("pre_validate");
    expect(avant.message).toContain("avant bascule");
    const apres = await catchIngestError(
      rebuildIrisFull(fakeClient([structural]).client, "apres_bascule"),
    );
    expect(apres.phase).toBe("swap");
    const inattendu = await catchIngestError(
      rebuildIrisFull(fakeClient([{ data: null, error: null }]).client, "avant_bascule"),
    );
    expect(inattendu.phase).toBe("pre_validate");
  });
});

describe("rebuildIrisFullAfterFailure (chemin catch de main)", () => {
  const sleep = vi.fn(async () => {});
  const base = {
    basculePossible: true,
    rebuildApresTentee: false,
    originPhase: "validate" as const,
  };

  it("aucune bascule possible → pas d'appel, suffixe vide", async () => {
    const { client, rpc } = fakeClient([]);
    const suffix = await rebuildIrisFullAfterFailure(
      { ...base, basculePossible: false, supabase: client },
      { sleep },
    );
    expect(suffix).toBe("");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("bascule possible, reconstruction pas encore tentée → appel, suffixe « rattachée »", async () => {
    const { client, rpc } = fakeClient([OK]);
    const suffix = await rebuildIrisFullAfterFailure({ ...base, supabase: client }, { sleep });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(suffix).toBe(" ; vue iris_full rattachée aux tables en place");
  });

  it("erreur d'origine en phase swap → suffixe nuancé, relance manuelle citée", async () => {
    const { client } = fakeClient([OK]);
    const suffix = await rebuildIrisFullAfterFailure(
      { ...base, originPhase: "swap", supabase: client },
      { sleep },
    );
    expect(suffix).toContain("rattachée aux tables en place");
    expect(suffix).toContain("a pu s'appliquer après coup");
    expect(suffix).toContain("SELECT ingest_rebuild_iris_full();");
  });

  it("échec de la tentative → suffixe « NON rattachée », sans lever", async () => {
    const { client } = fakeClient([{ data: null, error: { code: "42P16", message: "colonnes" } }]);
    const suffix = await rebuildIrisFullAfterFailure({ ...base, supabase: client }, { sleep });
    expect(suffix).toContain("vue iris_full NON rattachée");
    expect(suffix).toContain("42P16");
    expect(suffix).toContain("SELECT ingest_rebuild_iris_full();");
  });

  it("rpc() qui rejette à chaque tentative → « NON rattachée », sans lever", async () => {
    const { client, rpc } = fakeClient([REJECT, REJECT, REJECT]);
    const suffix = await rebuildIrisFullAfterFailure({ ...base, supabase: client }, { sleep });
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(suffix).toContain("vue iris_full NON rattachée");
    expect(suffix).toContain("socket hang up");
  });

  it("dépassement de la borne de durée → « NON rattachée », sans lever", async () => {
    const { client } = fakeClient([HANG]);
    const suffix = await rebuildIrisFullAfterFailure(
      { ...base, supabase: client },
      { sleep, afterFailureTimeoutMs: 20 },
    );
    expect(suffix).toContain("vue iris_full NON rattachée");
    expect(suffix).toContain("timed out");
    expect(REBUILD_AFTER_FAILURE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("client absent → « NON rattachée », sans appel", async () => {
    const suffix = await rebuildIrisFullAfterFailure({ ...base, supabase: null }, { sleep });
    expect(suffix).toContain("vue iris_full NON rattachée");
    expect(suffix).toContain("SELECT ingest_rebuild_iris_full();");
  });

  it("reconstruction d'après bascule déjà tentée → pas d'appel", async () => {
    const { client, rpc } = fakeClient([]);
    const suffix = await rebuildIrisFullAfterFailure(
      { ...base, rebuildApresTentee: true, supabase: client },
      { sleep },
    );
    expect(suffix).toBe("");
    expect(rpc).not.toHaveBeenCalled();
  });
});
