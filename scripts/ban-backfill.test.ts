import { afterEach, describe, expect, it, vi } from "vitest";
import type { BanGeocodeBatchOutcome } from "../src/core/index.js";
import { normalizeAddressKey } from "../src/core/index.js";

// `runBanBackfill` (ban-backfill.mjs) importe `geocodeAddressesBatch` depuis
// `../src/core/index.js`. On mocke ce module en gardant `normalizeAddressKey`
// RÉEL (utilisé ici pour FABRIQUER des clés de fixtures réalistes, PAS pour
// vérifier que le backfill recalcule la clé — il ne le fait PLUS, la clé vient
// de la RPC, UNIQUE source de vérité SQL Task 1) et en remplaçant
// `geocodeAddressesBatch` par un mock pilotable par test.
const geocodeAddressesBatchMock =
  vi.fn<(rows: unknown, opts: unknown) => Promise<BanGeocodeBatchOutcome>>();
// Espion sur `normalizeAddressKey` : le backfill NE DOIT PLUS l'appeler dans le
// chemin d'énumération (T-no-sort) — la clé est la source de vérité SQL.
const normalizeAddressKeySpy = vi.fn<(...a: unknown[]) => string>();
vi.mock("../src/core/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/index.js")>();
  return {
    ...actual,
    geocodeAddressesBatch: (rows: unknown, opts: unknown) => geocodeAddressesBatchMock(rows, opts),
    normalizeAddressKey: (...args: unknown[]) => {
      normalizeAddressKeySpy(...args);
      return (actual.normalizeAddressKey as (...a: unknown[]) => string)(...args);
    },
    normalizeAddressKey3: (...args: unknown[]) => {
      normalizeAddressKeySpy(...args);
      return (actual.normalizeAddressKey3 as (...a: unknown[]) => string)(...args);
    },
  };
});

const { runBanBackfill } = await import("./ban-backfill.mjs");

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

// Fixtures adresses RPPS RÉELLES (style ANS). On NE passe plus par
// `.range()` : on alimente directement le dataset de clés DISTINCTES de la RPC
// `rpps_distinct_eligible_keys`. Les helpers `realKey` fabriquent une clé
// byte-exacte avec le jumeau JS (parité octet-à-octet garantie par le HARD
// GATE Task 1) pour des assertions réalistes côté tests.
const ROW_A = { adresse: "60 AV DE JASSERON", code_postal: "08000", code_insee: "08105" };
const ROW_B = { adresse: "10 PLACE DE LA REPUBLIQUE", code_postal: "75011", code_insee: "75111" };

function distinctKeyRow(r: { adresse: string; code_postal: string; code_insee: string }) {
  return {
    address_key: normalizeAddressKey(r.adresse, r.code_postal, r.code_insee),
    adresse: r.adresse,
    code_postal: r.code_postal,
    code_insee: r.code_insee,
  };
}

type DistinctRow = {
  address_key: string;
  adresse: string | null;
  code_postal: string | null;
  code_insee: string | null;
};

/**
 * Injecteur de blip transport : les `count` premiers appels renvoient un
 * `Promise.reject(TypeError("fetch failed"))` (signature de l'incident G5,
 * réessayée par `retryTransient`), puis `null` (le caller poursuit la logique
 * normale). Factorise les 3 sites d'injection identiques du stub.
 */
function makeTransientGate(count: number): () => Promise<never> | null {
  let remaining = count;
  return () => {
    if (remaining > 0) {
      remaining--;
      return Promise.reject(new TypeError("fetch failed"));
    }
    return null;
  };
}

/**
 * Stub supabase chaînable couvrant exactement les appels de `runBanBackfill`
 * APRÈS Task 5 :
 *  - rpc("rpps_distinct_eligible_keys", {p_source_table,p_after,p_limit})
 *      → énumération keyset des clés DISTINCTES (PLUS de `.range()`)
 *  - from("geocoded_addresses").select().in()   → cache reads
 *  - from("geocoded_addresses").upsert()        → cache writes
 *
 * MODÉLISE un PLAFOND SERVEUR `serverCap` < KEYSET_PAGE : chaque appel RPC
 * renvoie au plus `min(serverCap, restant)` clés STRICTEMENT croissantes
 * (keyset : `> p_after`), une page VIDE quand le dataset est épuisé. Sans ce
 * cap < page, un stub renvoyant tout d'un coup ne pourrait PAS attraper la
 * régression `if (rows.length < KEYSET_PAGE) break` (perte silencieuse S-1,
 * leçon Task 9). Le whitelist `p_source_table` est validé côté SQL en prod ;
 * ici on vérifie juste qu'on ne reçoit pas un appel inattendu.
 *
 * `rpps_staging`/`rpps` writes : si un upsert/insert/update vise `rpps` ou
 * `rpps_staging`, le test échoue (le backfill est CACHE-ONLY).
 */
function makeStub(opts: {
  distinctRows: DistinctRow[];
  serverCap?: number;
  cacheRows?: Array<{ address_key: string; accepted: boolean; ban_attempt_count: number }>;
  // Force une erreur RPC au Nᵉ appel (1-based) → fail-loud test.
  rpcErrorOnCall?: number;
  // Le Nᵉ appel RPC (1-based) ne résout JAMAIS → withTimeout test.
  rpcHangOnCall?: number;
  // Rejets TRANSPORT transitoires (`TypeError: fetch failed`, incident G5)
  // avant de servir : les N premières invocations de l'op REJETTENT, puis
  // l'op réussit normalement. `retryTransient` doit les absorber.
  rpcTransientFails?: number;
  cacheReadTransientFails?: number;
  upsertTransientFails?: number;
  // Throw NON transitoire (erreur logique) sur la 1ʳᵉ lecture cache : ne doit
  // JAMAIS être réessayée → propage (fail-loud préservé).
  cacheReadNonTransientThrow?: boolean;
  // Les N premières lectures cache RÉSOLVENT `{ data:null, error:{message:
  // "TypeError: fetch failed"} }` (PAS un reject) — le mode de défaillance
  // RÉEL supabase-js prouvé en prod (incident G5). `isRetryableResult` doit
  // les absorber. Distinct de `cacheReadTransientFails` (qui, lui, REJETTE).
  cacheReadResolvedTransientFails?: number;
  // Valeur rendue par `rpps_count_ban_eligible_rows` (backstop S-1). Défaut =
  // nb de distinctRows (cohérent : count ROWS ≥ clés distinctes). Mettre
  // explicitement > 0 avec `distinctRows: []` pour armer le backstop S-1.
  eligibleRowCount?: number;
}) {
  const rpcTransientGate = makeTransientGate(opts.rpcTransientFails ?? 0);
  const cacheReadTransientGate = makeTransientGate(opts.cacheReadTransientFails ?? 0);
  const upsertTransientGate = makeTransientGate(opts.upsertTransientFails ?? 0);
  let cacheReadNonTransientPending = opts.cacheReadNonTransientThrow === true;
  let cacheReadResolvedTransientRemaining = opts.cacheReadResolvedTransientFails ?? 0;
  const serverCap = opts.serverCap ?? 1000;
  // Dataset trié ascendant par clé (la RPC garantit l'ordre croissant keyset).
  const sorted = [...opts.distinctRows].sort((a, b) =>
    a.address_key < b.address_key ? -1 : a.address_key > b.address_key ? 1 : 0,
  );
  const upserts: unknown[][] = [];
  const rpcCalls: Array<{ p_after: string | null; returned: number }> = [];
  const cache = new Map<
    string,
    { address_key: string; accepted: boolean; ban_attempt_count: number }
  >();
  for (const c of opts.cacheRows ?? []) cache.set(c.address_key, c);

  const rpc = vi.fn((fn: string, args: Record<string, unknown>) => {
    // Backstop S-1 : count de LIGNES éligibles (≥ clés distinctes). Défaut =
    // nb de distinctRows. Hors transient-gate (concerne l'énumération).
    if (fn === "rpps_count_ban_eligible_rows") {
      return Promise.resolve({ data: opts.eligibleRowCount ?? sorted.length, error: null });
    }
    if (fn === "rpps_geocoded_cache_lookup") {
      // Lecture cache via RPC (clés en BODY POST). Mêmes injections de faute
      // qu'avant (migrées du `.from().select().in()` supprimé).
      if (cacheReadNonTransientPending) {
        cacheReadNonTransientPending = false;
        return Promise.reject(new Error("permission denied for table"));
      }
      if (cacheReadResolvedTransientRemaining > 0) {
        cacheReadResolvedTransientRemaining--;
        // RÉSOUT `{error}` (PAS reject) = mode de défaillance réel G5.
        return Promise.resolve({ data: null, error: { message: "TypeError: fetch failed" } });
      }
      const crT = cacheReadTransientGate();
      if (crT) return crT;
      const vals = (args.p_keys as string[] | undefined) ?? [];
      const data = vals
        .map((v) => cache.get(v))
        .filter((c): c is NonNullable<typeof c> => c !== undefined);
      return Promise.resolve({ data, error: null });
    }
    if (fn !== "rpps_distinct_eligible_keys") {
      throw new Error(`unexpected rpc ${fn}`);
    }
    // Blip transport AVANT toute logique : ne consomme PAS un index d'appel
    // (le keyset `p_after` n'a pas avancé) — retryTransient ré-invoque à neuf.
    const rpcT = rpcTransientGate();
    if (rpcT) return rpcT;
    const callIndex = rpcCalls.length + 1;
    if (opts.rpcHangOnCall === callIndex) {
      // Promesse qui ne résout JAMAIS → withTimeout doit rejeter.
      rpcCalls.push({ p_after: (args.p_after as string | null) ?? null, returned: -1 });
      return new Promise(() => {});
    }
    if (opts.rpcErrorOnCall === callIndex) {
      rpcCalls.push({ p_after: (args.p_after as string | null) ?? null, returned: -1 });
      return Promise.resolve({ data: null, error: { message: "simulated rpc failure" } });
    }
    const after = (args.p_after as string | null) ?? null;
    const limit = args.p_limit as number;
    const startIdx = after === null ? 0 : sorted.findIndex((r) => r.address_key > after);
    const page =
      startIdx === -1 ? [] : sorted.slice(startIdx, startIdx + Math.min(limit, serverCap));
    rpcCalls.push({ p_after: after, returned: page.length });
    return Promise.resolve({ data: page, error: null });
  });

  const fromImpl = (table: string) => {
    if (table === "rpps" || table === "rpps_staging") {
      const builder: Record<string, unknown> = {
        select() {
          throw new Error(`backfill must NOT read ${table} via .from() (RPC-only)`);
        },
        upsert() {
          throw new Error(`backfill must NOT write ${table} (cache-only)`);
        },
        insert() {
          throw new Error(`backfill must NOT write ${table} (cache-only)`);
        },
        update() {
          throw new Error(`backfill must NOT write ${table} (cache-only)`);
        },
      };
      return builder;
    }
    if (table === "geocoded_addresses") {
      return {
        select() {
          // Garde anti-régression : la lecture cache DOIT passer par la RPC
          // `rpps_geocoded_cache_lookup` (body POST), plus JAMAIS `.in()` URL
          // (incident GATE G5 — ~670 GET séquentiels morts `fetch failed`).
          throw new Error(
            "backfill must NOT read geocoded_addresses via .select().in() — use rpps_geocoded_cache_lookup RPC (GATE G5bis)",
          );
        },
        upsert(rows: unknown[]) {
          const upT = upsertTransientGate();
          if (upT) return upT;
          upserts.push(rows);
          for (const r of rows as Array<{
            address_key: string;
            accepted: boolean;
            ban_attempt_count: number;
          }>) {
            cache.set(r.address_key, {
              address_key: r.address_key,
              accepted: r.accepted,
              ban_attempt_count: r.ban_attempt_count,
            });
          }
          return Promise.resolve({ error: null });
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  };

  const client = {
    from: vi.fn(fromImpl),
    rpc,
  } as never;

  return { client, upserts, rpcCalls, cache };
}

describe("runBanBackfill", () => {
  afterEach(() => {
    geocodeAddressesBatchMock.mockReset();
    normalizeAddressKeySpy.mockReset();
    vi.restoreAllMocks();
  });

  it("run 1 géocode les N clés distinctes éligibles non cachées et les upsert ; run 2 (cache plein) ne re-géocode RIEN (idempotent)", async () => {
    const keyA = normalizeAddressKey(ROW_A.adresse, ROW_A.code_postal, ROW_A.code_insee);
    const keyB = normalizeAddressKey(ROW_B.adresse, ROW_B.code_postal, ROW_B.code_insee);

    geocodeAddressesBatchMock.mockResolvedValue(
      banOutcome(
        [
          [
            keyA,
            { accepted: true, lat: 49.77, lon: 4.72, resultScore: 0.95, resultType: "housenumber" },
          ],
          [
            keyB,
            { accepted: true, lat: 48.86, lon: 2.36, resultScore: 0.91, resultType: "street" },
          ],
        ],
        0,
        1,
      ),
    );

    // La RPC renvoie les clés DISTINCTES (le dédoublonnage par adresse est
    // fait côté serveur — A "dupliquée" en amont n'apparaît qu'une fois ici).
    const stub = makeStub({
      distinctRows: [distinctKeyRow(ROW_A), distinctKeyRow(ROW_B)],
      cacheRows: [],
    });

    const r1 = await runBanBackfill(stub.client, {});
    expect(r1.geocoded).toBe(2);
    const upsertedKeys = (stub.upserts.flat() as Array<{ address_key: string }>)
      .map((u) => u.address_key)
      .sort();
    expect(upsertedKeys).toEqual([keyA, keyB].sort());
    expect(geocodeAddressesBatchMock).toHaveBeenCalledTimes(1);

    // Run 2 : le cache contient maintenant keyA+keyB accepted=true → 0 soumis.
    geocodeAddressesBatchMock.mockClear();
    const r2 = await runBanBackfill(stub.client, {});
    expect(r2.geocoded).toBe(0);
    expect(geocodeAddressesBatchMock).not.toHaveBeenCalled();
  });

  it("T-no-sort / order-from-RPC : le backfill NE re-trie PAS lexicographiquement les clés (l'ordre de service = le tri attempt-first) ET ne recalcule JAMAIS la clé en JS (source de vérité SQL)", async () => {
    // RPC renvoie 3 clés en ordre croissant. On injecte des attempts cache de
    // sorte que le tri attempt-first RÉORDONNE (les attempt=0 d'abord, puis
    // attempt>0). Si le backfill réappliquait un `.sort()` lexicographique sur
    // distinctKeys, l'ordre final serait l'ordre lexicographique, PAS l'ordre
    // attempt-first → assertion ROUGE.
    const rows = [
      { adresse: "1 RUE A", code_postal: "75001", code_insee: "75101" },
      { adresse: "2 RUE B", code_postal: "75002", code_insee: "75102" },
      { adresse: "3 RUE C", code_postal: "75003", code_insee: "75103" },
    ];
    const drs = rows.map(distinctKeyRow).sort((a, b) => (a.address_key < b.address_key ? -1 : 1));
    // La 1ère clé lexicographique a déjà 2 attempts ; les 2 autres sont neuves
    // (attempt 0) → le tri attempt-first la met EN DERNIER.
    const lexFirstRow = drs[0];
    if (lexFirstRow === undefined) throw new Error("fixture invariant: drs non-vide");
    const lexFirst = lexFirstRow.address_key;
    let submittedOrder: string[] = [];
    geocodeAddressesBatchMock.mockImplementation(async (r) => {
      submittedOrder = (r as Array<{ key: string }>).map((x) => x.key);
      return banOutcome([], 0, 0);
    });
    const stub = makeStub({
      distinctRows: drs,
      cacheRows: [{ address_key: lexFirst, accepted: false, ban_attempt_count: 2 }],
    });

    // Les fixtures ci-dessus ont appelé `normalizeAddressKey` (helper de test
    // `distinctKeyRow`). On RESET le spy juste avant l'invocation : seul un
    // appel DEPUIS `runBanBackfill` (recompute JS interdit) doit le déclencher.
    normalizeAddressKeySpy.mockClear();

    await runBanBackfill(stub.client, {});

    // Ordre de service = attempt-first : les 2 attempt=0 (ordre lexico entre
    // eux) PUIS lexFirst (attempt 2). PAS un re-tri lexicographique pur (qui
    // aurait mis lexFirst en tête).
    const attempt0 = drs.slice(1).map((d) => d.address_key);
    expect(submittedOrder).toEqual([...attempt0, lexFirst]);
    expect(submittedOrder[0]).not.toBe(lexFirst);
    // Le backfill NE recalcule PAS la clé en JS dans l'énumération : la clé
    // est consommée telle quelle depuis la RPC (UNIQUE source de vérité SQL).
    expect(normalizeAddressKeySpy).not.toHaveBeenCalled();
  });

  it("T-cap-agnostic (S-6/S-1) : N clés distinctes, plafond serveur K<KEYSET_PAGE, N>K → TOUTES énumérées, termine sur page VIDE, nb d'appels RPC == ceil(N/K)+1", async () => {
    // 2500 clés distinctes, plafond serveur K=400 (< KEYSET_PAGE=1000).
    // Régression S-1 ROUGE : `if(rows.length < KEYSET_PAGE) break` → break
    // après la 1ère page de 400 → 400/2500 traitées en rapportant un succès.
    // Vert SEULEMENT si terminaison = page VIDE + `after` = dernière clé reçue.
    const N = 2500;
    const K = 400;
    const rows: DistinctRow[] = Array.from({ length: N }, (_, i) => ({
      address_key: `KEY|${String(i).padStart(6, "0")}|75101`,
      adresse: `${i + 1} RUE DE LA PAIX`,
      code_postal: "75002",
      code_insee: "75102",
    }));
    let submittedCount = -1;
    geocodeAddressesBatchMock.mockImplementation(async (r) => {
      submittedCount = (r as unknown[]).length;
      return banOutcome([], 0, 1);
    });
    const stub = makeStub({ distinctRows: rows, serverCap: K, cacheRows: [] });

    await runBanBackfill(stub.client, {});

    // Les 2500 clés distinctes soumises (PAS 400 — pas de break précoce).
    expect(submittedCount).toBe(N);
    // ceil(2500/400)=7 pages pleines/partielles + 1 page VIDE qui SEULE termine.
    expect(stub.rpcCalls.length).toBe(Math.ceil(N / K) + 1);
    expect(stub.rpcCalls.at(-1)?.returned).toBe(0);
  });

  it("T-fail-loud-on-rpc-error : une erreur RPC en page 2 fait REJETER (throw) tout le run — PAS de best-effort (contrat backfill ≠ cron)", async () => {
    const rows: DistinctRow[] = Array.from({ length: 600 }, (_, i) => ({
      address_key: `KEY|${String(i).padStart(6, "0")}|75101`,
      adresse: `${i + 1} RUE X`,
      code_postal: "75002",
      code_insee: "75102",
    }));
    geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 0, 0));
    // serverCap=400 → page 1 OK (400), page 2 = erreur.
    const stub = makeStub({
      distinctRows: rows,
      serverCap: 400,
      cacheRows: [],
      rpcErrorOnCall: 2,
    });

    await expect(runBanBackfill(stub.client, {})).rejects.toThrow(
      /\[ban-backfill\] rpps_distinct_eligible_keys failed/,
    );
    // Fail-loud : BAN jamais appelé (le run avorte AVANT le géocodage).
    expect(geocodeAddressesBatchMock).not.toHaveBeenCalled();
  });

  it("T-timeout-fail-loud : une lecture RPC qui ne résout jamais → withTimeout REJETTE → run REJETÉ (throw 'timed out'), JAMAIS swallowed/best-effort", async () => {
    vi.useFakeTimers();
    try {
      const rows: DistinctRow[] = Array.from({ length: 10 }, (_, i) => ({
        address_key: `KEY|${String(i).padStart(6, "0")}|75101`,
        adresse: `${i + 1} RUE Y`,
        code_postal: "75002",
        code_insee: "75102",
      }));
      geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 0, 0));
      // 1er appel RPC ne résout JAMAIS.
      const stub = makeStub({
        distinctRows: rows,
        cacheRows: [],
        rpcHangOnCall: 1,
      });

      const promise = runBanBackfill(stub.client, {});
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      // Avance les timers : déclenche le reject de withTimeout.
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(geocodeAddressesBatchMock).not.toHaveBeenCalled();
      // H1 (E2E) : un hang NE DOIT PAS être réessayé par retryTransient
      // (`TimeoutError` exclu) — sinon 4×60s de hang masqué. Un seul appel RPC.
      expect(stub.rpcCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Draine tous les backoffs `retryTransient` (faux timers) jusqu'à ce que la
  // promesse du run soit réglée — handler attaché AVANT le drain (sinon
  // unhandledrejection pendant l'avance des timers). Sort dès que réglée ; la
  // borne 80×5s (= 400s virtuels) n'est qu'un filet anti-boucle-infinie, très
  // au-delà du pire cas (3 sites × maxRetries 3 × baseDelay 500ms→2s + jitter).
  async function settleWithRetryBackoffs<T>(
    p: Promise<T>,
  ): Promise<{ ok: true; r: T } | { ok: false; e: unknown }> {
    let settled = false;
    const tracked: Promise<{ ok: true; r: T } | { ok: false; e: unknown }> = p.then(
      (r) => {
        settled = true;
        return { ok: true as const, r };
      },
      (e) => {
        settled = true;
        return { ok: false as const, e };
      },
    );
    for (let i = 0; i < 80 && !settled; i++) await vi.advanceTimersByTimeAsync(5_000);
    return tracked;
  }

  it("T-retry-cache-read (incident G5) : un `fetch failed` transitoire sur la lecture cache est RÉESSAYÉ — le run NE meurt PAS, il géocode normalement", async () => {
    vi.useFakeTimers();
    try {
      const rows: DistinctRow[] = [distinctKeyRow(ROW_A), distinctKeyRow(ROW_B)];
      const keyA = rows[0].address_key;
      const keyB = rows[1].address_key;
      geocodeAddressesBatchMock.mockResolvedValue(
        banOutcome(
          [
            [
              keyA,
              { accepted: true, lat: 48.1, lon: 4.2, resultScore: 0.9, resultType: "housenumber" },
            ],
            [
              keyB,
              { accepted: true, lat: 48.8, lon: 2.3, resultScore: 0.95, resultType: "housenumber" },
            ],
          ],
          0,
          1,
        ),
      );
      // Les 2 premières invocations de la lecture cache REJETTENT (fetch failed).
      const stub = makeStub({ distinctRows: rows, cacheRows: [], cacheReadTransientFails: 2 });
      const out = await settleWithRetryBackoffs(runBanBackfill(stub.client, {}));
      expect(out).toEqual({ ok: true, r: expect.objectContaining({ accepted: 2, geocoded: 2 }) });
      expect(stub.upserts.flat()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("T-retry-cache-read-RESOLVED (le VRAI mode G5) : un `{error: fetch failed}` RÉSOLU (pas un reject) est RÉESSAYÉ — le run NE meurt PAS", async () => {
    vi.useFakeTimers();
    try {
      const rows: DistinctRow[] = [distinctKeyRow(ROW_A), distinctKeyRow(ROW_B)];
      const keyA = rows[0].address_key;
      const keyB = rows[1].address_key;
      geocodeAddressesBatchMock.mockResolvedValue(
        banOutcome(
          [
            [
              keyA,
              { accepted: true, lat: 48.1, lon: 4.2, resultScore: 0.9, resultType: "housenumber" },
            ],
            [
              keyB,
              { accepted: true, lat: 48.8, lon: 2.3, resultScore: 0.95, resultType: "housenumber" },
            ],
          ],
          0,
          1,
        ),
      );
      // 2 lectures cache RÉSOLVENT `{error:fetch failed}` (≠ reject) = G5 réel.
      const stub = makeStub({
        distinctRows: rows,
        cacheRows: [],
        cacheReadResolvedTransientFails: 2,
      });
      const out = await settleWithRetryBackoffs(runBanBackfill(stub.client, {}));
      expect(out).toEqual({ ok: true, r: expect.objectContaining({ accepted: 2, geocoded: 2 }) });
      expect(stub.upserts.flat()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("T-retry-rpc-enumeration : un `fetch failed` transitoire sur la RPC d'énumération est RÉESSAYÉ (même blip, énumération complète)", async () => {
    vi.useFakeTimers();
    try {
      const rows: DistinctRow[] = [distinctKeyRow(ROW_A), distinctKeyRow(ROW_B)];
      geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 0, 0));
      const stub = makeStub({ distinctRows: rows, cacheRows: [], rpcTransientFails: 2 });
      const out = await settleWithRetryBackoffs(runBanBackfill(stub.client, {}));
      expect(out).toMatchObject({ ok: true, r: { totalEligibleDistinct: 2 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("T-retry-upsert : un `fetch failed` transitoire sur l'upsert cache est RÉESSAYÉ (la tranche finit par être écrite)", async () => {
    vi.useFakeTimers();
    try {
      const rows: DistinctRow[] = [distinctKeyRow(ROW_A)];
      const keyA = rows[0].address_key;
      geocodeAddressesBatchMock.mockResolvedValue(
        banOutcome(
          [
            [
              keyA,
              { accepted: true, lat: 48.1, lon: 4.2, resultScore: 0.9, resultType: "housenumber" },
            ],
          ],
          0,
          1,
        ),
      );
      const stub = makeStub({ distinctRows: rows, cacheRows: [], upsertTransientFails: 2 });
      const out = await settleWithRetryBackoffs(runBanBackfill(stub.client, {}));
      expect(out).toMatchObject({ ok: true, r: { accepted: 1 } });
      expect(stub.upserts.flat()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("T-backstop-S1 : count>0 mais énumération 0 clé → THROW (pas de no-op success), BAN jamais appelé", async () => {
    geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 0, 0));
    // Énumération vide (distinctRows: []) MAIS le count dit qu'il EXISTE des
    // lignes éligibles → dérive prédicat/index = panne TOTALE silencieuse S-1.
    const stub = makeStub({ distinctRows: [], cacheRows: [], eligibleRowCount: 5 });
    await expect(runBanBackfill(stub.client, {})).rejects.toThrow(
      /returned ZERO distinct keys while rpps_count_ban_eligible_rows=5 > 0.*S-1 silent-failure backstop/,
    );
    expect(geocodeAddressesBatchMock).not.toHaveBeenCalled();
  });

  it("T-backstop-S1-OK : count=0 ET énumération 0 clé → no-op success légitime (slate vide, PAS S-1)", async () => {
    geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 0, 0));
    const stub = makeStub({ distinctRows: [], cacheRows: [], eligibleRowCount: 0 });
    const out = await runBanBackfill(stub.client, {});
    expect(out).toMatchObject({ totalEligibleDistinct: 0, geocoded: 0 });
    expect(geocodeAddressesBatchMock).not.toHaveBeenCalled();
  });

  it("T-non-transient-NOT-retried : une erreur LOGIQUE sur la lecture cache N'EST PAS réessayée → propage (fail-loud), BAN jamais appelé", async () => {
    const rows: DistinctRow[] = [distinctKeyRow(ROW_A)];
    geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 0, 0));
    const stub = makeStub({ distinctRows: rows, cacheRows: [], cacheReadNonTransientThrow: true });
    await expect(runBanBackfill(stub.client, {})).rejects.toThrow(/permission denied/);
    expect(geocodeAddressesBatchMock).not.toHaveBeenCalled();
  });

  it("--max N borne le nombre de NOUVELLES adresses soumises ce run (slice déterministe)", async () => {
    const rows: DistinctRow[] = Array.from({ length: 50 }, (_, i) => ({
      address_key: `KEY|${String(i).padStart(6, "0")}|75101`,
      adresse: `${i + 1} RUE DE LA PAIX`,
      code_postal: "75002",
      code_insee: "75102",
    }));
    let submittedCount = -1;
    geocodeAddressesBatchMock.mockImplementation(async (r) => {
      submittedCount = (r as unknown[]).length;
      return banOutcome([], 0, 1);
    });
    const stub = makeStub({ distinctRows: rows, cacheRows: [] });

    const res = await runBanBackfill(stub.client, { maxNew: 20 });

    expect(submittedCount).toBe(20);
    expect(res.remaining).toBe(30);
  });

  it("skip cache : accepted=true FIGÉ + accepted=false au-delà du cap d'attempts ne sont PAS re-soumis", async () => {
    const keyA = normalizeAddressKey(ROW_A.adresse, ROW_A.code_postal, ROW_A.code_insee);
    const keyB = normalizeAddressKey(ROW_B.adresse, ROW_B.code_postal, ROW_B.code_insee);
    let submitted: Array<{ key: string }> = [];
    geocodeAddressesBatchMock.mockImplementation(async (rows) => {
      submitted = rows as typeof submitted;
      return banOutcome([], 0, 0);
    });
    const stub = makeStub({
      distinctRows: [distinctKeyRow(ROW_A), distinctKeyRow(ROW_B)],
      cacheRows: [
        { address_key: keyA, accepted: true, ban_attempt_count: 1 }, // figé
        { address_key: keyB, accepted: false, ban_attempt_count: 3 }, // cap atteint
      ],
    });

    const res = await runBanBackfill(stub.client, {});

    // Les 2 clés sont skippées → geocodeAddressesBatch jamais appelé.
    expect(submitted.length).toBe(0);
    expect(geocodeAddressesBatchMock).not.toHaveBeenCalled();
    expect(res.geocoded).toBe(0);
    expect(res.skippedCached).toBe(2);
  });

  it("nothing-to-do : 0 clé éligible (RPC renvoie page vide d'emblée) → no-op idempotent, retour cohérent, BAN jamais appelé", async () => {
    geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 0, 0));
    const stub = makeStub({ distinctRows: [], cacheRows: [] });

    const res = await runBanBackfill(stub.client, {});

    expect(res.totalEligibleDistinct).toBe(0);
    expect(res.geocoded).toBe(0);
    expect(res.skippedCached).toBe(0);
    expect(geocodeAddressesBatchMock).not.toHaveBeenCalled();
    // Une seule page RPC : la page VIDE qui termine d'emblée.
    expect(stub.rpcCalls.length).toBe(1);
    expect(stub.rpcCalls[0]?.returned).toBe(0);
  });

  it("best-effort : apiFailures du client comptés et exposés, jamais d'arrêt silencieux", async () => {
    geocodeAddressesBatchMock.mockResolvedValue(banOutcome([], 4, 5));
    const stub = makeStub({ distinctRows: [distinctKeyRow(ROW_A)], cacheRows: [] });

    const res = await runBanBackfill(stub.client, {});

    expect(res.apiFailures).toBe(4);
  });

  it("S-3 parité : accepted=true à coords NULL ⇒ compté en contractBreached DÉDIÉ (PAS rejected), downgrade accepted=false, console.error, pas un apiFailure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const keyA = normalizeAddressKey(ROW_A.adresse, ROW_A.code_postal, ROW_A.code_insee);
    // RUPTURE DE CONTRAT client : accepted=true mais coords NULL. Le client
    // garantit l'inverse — on downgrade plutôt que laisser le CHECK throw.
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
    const stub = makeStub({ distinctRows: [distinctKeyRow(ROW_A)], cacheRows: [] });

    const res = await runBanBackfill(stub.client, {});

    // S-3 : le breach est dans SON bucket dédié, JAMAIS noyé dans `rejected`
    // (qui resterait un rejet d'adresse routinier) ni dans `unresolved`.
    expect(res.contractBreached).toBe(1);
    expect(res.rejected).toBe(0);
    expect(res.unresolved).toBe(0);
    expect(res.accepted).toBe(0);
    expect(res.apiFailures).toBe(0); // HTTP a réussi — pas une panne API.
    // Downgrade effectif : upsert accepted=false, coords NULL (jamais le CHECK).
    const u = (
      stub.upserts.flat() as Array<{ accepted: boolean; lat: number | null; lon: number | null }>
    )[0];
    expect(u?.accepted).toBe(false);
    expect(u?.lat).toBeNull();
    expect(u?.lon).toBeNull();
    // Catch jamais silencieux : le breach est console.error'd.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("BAN-client contract breach"));
    // Ligne DONE : bucket dédié comptabilisé, 0 rejected_low_score.
    const doneLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("[ban-backfill] DONE:"));
    expect(doneLine).toContain("1 contract_breach_downgrades");
    expect(doneLine).toContain("0 rejected_low_score");
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
