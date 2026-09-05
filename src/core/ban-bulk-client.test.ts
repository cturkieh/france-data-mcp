import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCEPTED_PRECISION_TYPES,
  BAN_BULK_HOSTS,
  _resetBanBulkHostForTesting,
  geocodeAddressesBatch,
  normalizeAddressForBan,
} from "./ban-bulk-client.js";
import { runWithFakeTimers } from "./test-helpers.js";

// En-tête CSV tel que la BAN l'écho (colonnes d'entrée puis result_*) — une seule copie.
const BAN_CSV_HEADER =
  "key,adresse,code_postal,citycode,latitude,longitude,result_score,result_type,result_label";

// L'hôte préféré est un état MODULE (sticky) : chaque test repart de l'hôte [0],
// sinon une séquence 5xx → 200 d'un test précédent fuit dans le suivant.
beforeEach(() => _resetBanBulkHostForTesting());

// Retour sous forme d'objet (pas bare Map) : P5 exige que apiFailures soit
// observable même quand results est vide (ex : BAN-down total). Un bare Map
// ne peut pas porter ce compteur de première classe.
describe("geocodeAddressesBatch", () => {
  it("géocode un lot et mappe score/type, chunké", async () => {
    // BAN bulk CSV response : la BAN préfixe avec les colonnes d'entrée, puis ajoute result_*
    // Ici on passe un passthrough column "key" → la BAN l'écho en première position
    const chunk1Csv = [
      BAN_CSV_HEADER,
      "key-good,1 Rue de Rivoli,75001,75101,48.8600,2.3530,0.92,housenumber,1 Rue de Rivoli 75001 Paris",
    ].join("\n");

    const chunk2Csv = [BAN_CSV_HEADER, "key-bad,99 Lieu Inexistant,99999,99999,,,-1,,"].join("\n");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(chunk1Csv, { status: 200 }))
      .mockResolvedValueOnce(new Response(chunk2Csv, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    try {
      const out = await geocodeAddressesBatch(
        [
          { key: "key-good", adresse: "1 Rue de Rivoli", codePostal: "75001", codeInsee: "75101" },
          {
            key: "key-bad",
            adresse: "99 Lieu Inexistant",
            codePostal: "99999",
            codeInsee: "99999",
          },
        ],
        { chunkSize: 1, scoreThreshold: 0.5 },
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(out.results.size).toBe(2);

      const good = out.results.get("key-good");
      expect(good).toBeDefined();
      expect(good?.accepted).toBe(true);
      expect(good?.resultType).toBe("housenumber");
      expect(good?.resultScore).toBeCloseTo(0.92);
      expect(good?.lat).toBeCloseTo(48.86);
      expect(good?.lon).toBeCloseTo(2.353);

      const bad = out.results.get("key-bad");
      expect(bad).toBeDefined();
      expect(bad?.accepted).toBe(false);
      expect(bad?.lat).toBeNull();
      expect(bad?.lon).toBeNull();

      expect(out.apiFailures).toBe(0);
      expect(out.chunksTotal).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("BAN-down → results vide, apiFailures===chunksTotal, pas d'exception", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockResolvedValue(new Response("err", { status: 503 }));

    vi.stubGlobal("fetch", fetchMock);

    try {
      // Lancer la promesse puis avancer les faux timers pour court-circuiter les sleeps
      const promise = geocodeAddressesBatch(
        [
          { key: "k1", adresse: "1 Rue A", codePostal: "75001", codeInsee: "75101" },
          { key: "k2", adresse: "2 Rue B", codePostal: "75002", codeInsee: "75102" },
        ],
        { chunkSize: 1, scoreThreshold: 0.5 },
      );

      // Avancer les timers jusqu'à épuisement (retries + sleeps)
      await vi.runAllTimersAsync();

      const out = await promise;

      expect(out.results.size).toBe(0);
      expect(out.apiFailures).toBe(out.chunksTotal);
      expect(out.apiFailures).toBeGreaterThan(0);
      // La fonction ne doit pas lever d'exception (best-effort)
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("score sous le seuil → accepted:false même si housenumber", async () => {
    const csvBody = [
      BAN_CSV_HEADER,
      "key-low,5 Rue du Faubourg,75011,75111,48.8540,2.3770,0.35,housenumber,5 Rue du Faubourg 75011 Paris",
    ].join("\n");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(csvBody, { status: 200 })));

    try {
      const out = await geocodeAddressesBatch(
        [{ key: "key-low", adresse: "5 Rue du Faubourg", codePostal: "75011", codeInsee: "75111" }],
        { chunkSize: 10, scoreThreshold: 0.5 },
      );

      const row = out.results.get("key-low");
      expect(row).toBeDefined();
      expect(row?.accepted).toBe(false);
      expect(row?.resultType).toBe("housenumber");
      expect(row?.resultScore).toBeCloseTo(0.35);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Helper : 1 résultat BAN simulé, mock fetch, retourne le BanGeocodeResult.
  async function runOneBanResult(opts: {
    type: string;
    score: string;
    lat?: string;
    lon?: string;
  }) {
    const lat = opts.lat ?? "48.86";
    const lon = opts.lon ?? "2.35";
    const csvBody = [
      BAN_CSV_HEADER,
      `k,X,75001,75101,${lat},${lon},${opts.score},${opts.type},X`,
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(csvBody, { status: 200 })));
    try {
      const out = await geocodeAddressesBatch(
        [{ key: "k", adresse: "X", codePostal: "75001", codeInsee: "75101" }],
        { chunkSize: 10, scoreThreshold: 0.5 },
      );
      return out.results.get("k");
    } finally {
      vi.unstubAllGlobals();
    }
  }

  // Matrice exhaustive de la politique d'acceptation par PRÉCISION
  // (`docs/plans/ban-join.md`). Toute modif intentionnelle de la règle DOIT
  // toucher cette table → revue forcée. Cas couverts : 3 axes (type × score ×
  // robustesse forme), incluant les pannes silencieuses traquées en /review P1.
  it.each([
    // Acceptés : 3 types plus précis que la commune ≥ seuil
    { type: "housenumber", score: "0.55", expected: true, why: "housenumber ≥ seuil" },
    { type: "street", score: "0.55", expected: true, why: "street résolue ≥ seuil" },
    { type: "locality", score: "0.55", expected: true, why: "locality (lieu-dit) ≥ seuil" },
    // Rejetés : municipality = aucun gain vs centroïde, peu importe le score
    { type: "municipality", score: "0.95", expected: false, why: "municipality = niveau commune" },
    { type: "municipality", score: "0.30", expected: false, why: "municipality + score bas" },
    // Rejetés : type accepté mais score sous le seuil
    { type: "housenumber", score: "0.30", expected: false, why: "type ok mais score < seuil" },
    { type: "street", score: "0.30", expected: false, why: "type ok mais score < seuil" },
    // Rejetés : type vide / inconnu (ne pas avaler silencieusement)
    { type: "", score: "0.95", expected: false, why: "type vide" },
    { type: "unknown_xyz", score: "0.95", expected: false, why: "type inconnu" },
    // Robustesse normalisation : casse/espaces ne doivent PAS rejeter en silence
    { type: "Housenumber", score: "0.55", expected: true, why: "casse exotique normalisée" },
    { type: " street ", score: "0.55", expected: true, why: "espaces normalisés" },
  ])(
    "accept matrix: $type @ $score → accepted=$expected ($why)",
    async ({ type, score, expected }) => {
      const r = await runOneBanResult({ type, score });
      expect(r?.accepted).toBe(expected);
      if (expected) {
        // Contrat : un accepted=true porte TOUJOURS des coords finies.
        expect(r?.lat).toBeCloseTo(48.86);
        expect(r?.lon).toBeCloseTo(2.35);
        // Contrat : `resultType` persisté est la forme NORMALISÉE (lowercase,
        // trim). Sinon un `"Housenumber"` accepté ici serait jeté en aval par
        // tout filtre lowercase = panne silencieuse aval.
        expect(r?.resultType).toBe(type.trim().toLowerCase());
      }
    },
  );

  it("contrat coords : NaN BAN ⇒ accepted=false (jamais accepted+lat=null)", async () => {
    // Si BAN renvoie un nombre corrompu (`Number('abc')=NaN`), `Number.isFinite`
    // doit rejeter : sans ce garde, `accepted=true && lat=null` = rupture de contrat
    // (le caller `ban-backfill.mjs` la rattrape en aval, mais le client doit déjà l'empêcher).
    const r = await runOneBanResult({ type: "housenumber", score: "0.95", lat: "not-a-number" });
    expect(r?.accepted).toBe(false);
    expect(r?.lat).toBeNull();
  });

  it.each([
    { lat: "999", lon: "2.35", axis: "lat" },
    { lat: "48.86", lon: "400", axis: "lon" },
    { lat: "-91", lon: "2.35", axis: "lat" },
    { lat: "48.86", lon: "-181", axis: "lon" },
  ])(
    "contrat plage : coords hors [-90,90]×[-180,180] ⇒ accepted=false ($axis)",
    async ({ lat, lon }) => {
      // BAN ne devrait jamais sortir hors plage géographique ; le client refuse
      // pour ne pas polluer le cache (PostGIS aval, KNN…).
      const r = await runOneBanResult({ type: "housenumber", score: "0.95", lat, lon });
      expect(r?.accepted).toBe(false);
    },
  );

  it("ACCEPTED_PRECISION_TYPES : contenu figé (anti-régression silencieuse)", () => {
    // Pin direct : tout ajout/retrait force à toucher ce test → revue.
    // `municipality` doit RESTER absent (= aucun gain vs centroïde commune).
    expect([...ACCEPTED_PRECISION_TYPES].sort()).toEqual(["housenumber", "locality", "street"]);
    expect(ACCEPTED_PRECISION_TYPES.has("municipality")).toBe(false);
  });

  it("réponse 200 sans colonne `key` → échec dur, pas de perte silencieuse", async () => {
    // La BAN renvoie 200 avec les colonnes result_* MAIS sans le passthrough `key`.
    // Sans `key`, impossible de remapper les lignes : ce DOIT être un échec de
    // chunk (apiFailures++) et un warn [france-data-mcp], jamais un Map vide
    // silencieux (0 résultat / 0 échec).
    const csvNoKey = [
      "adresse,code_postal,citycode,latitude,longitude,result_score,result_type,result_label",
      "1 Rue X,75001,75101,48.8600,2.3530,0.92,housenumber,1 Rue X 75001 Paris",
    ].join("\n");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(csvNoKey, { status: 200 })));

    try {
      const out = await geocodeAddressesBatch(
        [{ key: "k1", adresse: "1 Rue X", codePostal: "75001", codeInsee: "75101" }],
        { chunkSize: 10, scoreThreshold: 0.5 },
      );

      expect(out.results.size).toBe(0);
      expect(out.apiFailures).toBe(out.chunksTotal);
      expect(out.apiFailures).toBeGreaterThan(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[france-data-mcp]"));
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  // S1 — corps 200 trop court (<2 lignes : proxy tronqué, body vide). On
  // n'envoie jamais de chunk vide → un corps <2 lignes pour un chunk non vide
  // est TOUJOURS une erreur, jamais un résultat vide légitime. Doit compter
  // comme un échec de chunk (apiFailures++) + warn, pas un succès vide silencieux.
  it("S1 — réponse 200 body vide → échec de chunk compté + warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    try {
      const out = await geocodeAddressesBatch(
        [{ key: "k1", adresse: "1 Rue X", codePostal: "75001", codeInsee: "75101" }],
        { chunkSize: 10, scoreThreshold: 0.5 },
      );

      expect(out.results.size).toBe(0);
      expect(out.apiFailures).toBe(out.chunksTotal);
      expect(out.apiFailures).toBeGreaterThan(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[france-data-mcp]"));
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("S1 — réponse 200 header seul (1 ligne) → échec de chunk compté + warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            "key,adresse,code_postal,citycode,latitude,longitude,result_score,result_type",
            { status: 200 },
          ),
        ),
    );

    try {
      const out = await geocodeAddressesBatch(
        [{ key: "k1", adresse: "1 Rue X", codePostal: "75001", codeInsee: "75101" }],
        { chunkSize: 10, scoreThreshold: 0.5 },
      );

      expect(out.results.size).toBe(0);
      expect(out.apiFailures).toBe(out.chunksTotal);
      expect(out.apiFailures).toBeGreaterThan(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[france-data-mcp]"));
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  // S2 — la BAN n'écho QUE certaines des lignes envoyées. Les clés absentes
  // doivent recevoir une entrée explicite « non résolu » (jamais disparaître
  // sans signal). L'appel HTTP a réussi → apiFailures reste 0 (qualité de
  // donnée, pas échec d'API).
  it("S2 — BAN écho 1 ligne sur 2 → clé absente = entrée unresolved explicite, apiFailures=0", async () => {
    const csvBody = [
      BAN_CSV_HEADER,
      "k-echoed,1 Rue A,75001,75101,48.8600,2.3530,0.92,housenumber,1 Rue A 75001 Paris",
    ].join("\n");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(csvBody, { status: 200 })));

    try {
      const out = await geocodeAddressesBatch(
        [
          { key: "k-echoed", adresse: "1 Rue A", codePostal: "75001", codeInsee: "75101" },
          { key: "k-missing", adresse: "2 Rue B", codePostal: "75002", codeInsee: "75102" },
        ],
        { chunkSize: 10, scoreThreshold: 0.5 },
      );

      const echoed = out.results.get("k-echoed");
      expect(echoed).toBeDefined();
      expect(echoed?.accepted).toBe(true);
      expect(echoed?.resultType).toBe("housenumber");
      expect(echoed?.lat).toBeCloseTo(48.86);

      const missing = out.results.get("k-missing");
      expect(missing).toBeDefined();
      expect(missing).toEqual({
        accepted: false,
        lat: null,
        lon: null,
        resultScore: null,
        resultType: null,
      });

      expect(out.results.size).toBe(2);
      expect(out.apiFailures).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("S2 — BAN écho des lignes mais 0 clé envoyée mappée (2 envoyées) → 2 unresolved + warn '0 mapped rows', apiFailures=0", async () => {
    // Body valide (header + data) MAIS la BAN renvoie une clé qui ne correspond
    // à AUCUNE clé envoyée (mis-mapping systémique). parseBanCsvResponse n'est
    // pas null (header OK, ≥2 lignes) → ce n'est PAS S1. Aucune de nos clés
    // n'est mappée ⇒ les 2 deviennent unresolved + 1 warn "0 mapped rows".
    const csvBody = [BAN_CSV_HEADER, "k-not-sent,X,75000,75100,48.8,2.3,0.9,housenumber,X"].join(
      "\n",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(csvBody, { status: 200 })));

    try {
      const out = await geocodeAddressesBatch(
        [
          { key: "z1", adresse: "1 Rue A", codePostal: "75001", codeInsee: "75101" },
          { key: "z2", adresse: "2 Rue B", codePostal: "75002", codeInsee: "75102" },
        ],
        { chunkSize: 10, scoreThreshold: 0.5 },
      );

      // 2 clés envoyées, toutes 2 absentes du mapping réel ⇒ toutes 2 unresolved.
      // (la ligne "k-not-sent" est ignorée : ce n'est pas une clé qu'on a envoyée)
      expect(out.results.size).toBe(2);
      const z1 = out.results.get("z1");
      const z2 = out.results.get("z2");
      expect(z1).toEqual({
        accepted: false,
        lat: null,
        lon: null,
        resultScore: null,
        resultType: null,
      });
      expect(z2).toEqual({
        accepted: false,
        lat: null,
        lon: null,
        resultScore: null,
        resultType: null,
      });
      expect(out.apiFailures).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("0 mapped rows"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[france-data-mcp]"));
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  // F2 — un fetch qui ne se résout JAMAIS (socket BAN figé) DOIT être borné
  // par `requestTimeoutMs` : le chunk avorte, est compté en apiFailures, un
  // log timeout [france-data-mcp] est émis, l'appel RÉSOUT (ne hang pas) et
  // les autres chunks sont quand même traités. Sans la borne, un job 339k
  // rows resterait bloqué indéfiniment.
  it("F2 — fetch qui ne résout jamais → requestTimeoutMs borne le chunk, apiFailures++, autres chunks traités, pas de hang", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const okCsv = [
      BAN_CSV_HEADER,
      "k-ok,1 Rue OK,75001,75101,48.8600,2.3530,0.92,housenumber,1 Rue OK 75001 Paris",
    ].join("\n");

    // Chunk 1 (1ère clé) : fetch dont la promesse ne se résout jamais SAUF si
    // le signal passé abort (rejette alors avec une AbortError, comme fetch).
    // Toutes ses re-tentatives (retry timeout) restent figées de la même
    // façon. Chunk 2 (2e clé) : réponse OK normale.
    let firstKeyCalls = 0;
    const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      // Le corps multipart contient la clé ; on route par clé pour ne pas
      // dépendre de l'ordre/compteur d'appels (retries inclus).
      // 4 = MAX_RETRIES+1 tentatives toutes figées pour la 1ère clé (chunk 0,
      // chunkSize=1). Les appels 1..4 = chunk figé ; le 5e = chunk OK.
      const isHangChunk = firstKeyCalls < 4;
      if (isHangChunk) {
        firstKeyCalls++;
        return new Promise((_resolve, reject) => {
          const sig = init?.signal;
          if (sig) {
            if (sig.aborted) {
              const e = new Error("The operation was aborted");
              e.name = "AbortError";
              reject(e);
              return;
            }
            sig.addEventListener("abort", () => {
              const e = new Error("The operation was aborted");
              e.name = "AbortError";
              reject(e);
            });
          }
        });
      }
      return Promise.resolve(new Response(okCsv, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const promise = geocodeAddressesBatch(
        [
          { key: "k-hang", adresse: "1 Rue Hang", codePostal: "75001", codeInsee: "75101" },
          { key: "k-ok", adresse: "1 Rue OK", codePostal: "75001", codeInsee: "75101" },
        ],
        { chunkSize: 1, scoreThreshold: 0.7, requestTimeoutMs: 50 },
      );

      // Avance les faux timers : déclenche le timeout du 1er chunk + ses
      // retries (chaque tentative re-timeout) puis laisse passer le 2e chunk.
      await vi.runAllTimersAsync();

      const out = await promise;

      // Le chunk figé est compté en échec (timeout = échec de chunk).
      expect(out.apiFailures).toBe(1);
      expect(out.chunksTotal).toBe(2);
      // Le 2e chunk a quand même été traité (best-effort préservé).
      const ok = out.results.get("k-ok");
      expect(ok).toBeDefined();
      expect(ok?.accepted).toBe(true);
      // Un log timeout [france-data-mcp] distinct d'une erreur réseau.
      const allLogs = [...warnSpy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0]));
      expect(allLogs.some((m) => m.includes("[france-data-mcp]"))).toBe(true);
      expect(allLogs.some((m) => /time.?d?.?out|timeout/i.test(m))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  // F2 — un `signal` caller déjà aborté AVANT l'appel : aucun chunk ne doit
  // partir, tous les chunks non traités comptent en apiFailures, pas de throw,
  // pas de hang. Jamais un "succès partiel silencieux".
  it("F2 — caller signal déjà aborté → aucun chunk lancé, tous comptés en apiFailures, pas de throw", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const ac = new AbortController();
      ac.abort();

      const out = await geocodeAddressesBatch(
        [
          { key: "a1", adresse: "1 Rue A", codePostal: "75001", codeInsee: "75101" },
          { key: "a2", adresse: "2 Rue B", codePostal: "75002", codeInsee: "75102" },
        ],
        { chunkSize: 1, scoreThreshold: 0.7, signal: ac.signal },
      );

      // Aucun fetch lancé (abort vérifié AVANT chaque chunk).
      expect(fetchMock).not.toHaveBeenCalled();
      expect(out.chunksTotal).toBe(2);
      // Les 2 chunks non traités → apiFailures (jamais un succès partiel muet).
      expect(out.apiFailures).toBe(2);
      expect(out.results.size).toBe(0);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[france-data-mcp]"));
    } finally {
      errSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  // F2 — caller signal aborté EN COURS de route : le chunk déjà parti peut
  // réussir, mais aucun NOUVEAU chunk ne démarre après l'abort ; les chunks
  // restants comptent en apiFailures. Pas de throw, pas de hang.
  it("F2 — caller signal aborté mid-flight → pas de nouveau chunk, restants en apiFailures", async () => {
    const okCsv = [
      BAN_CSV_HEADER,
      "k1,1 Rue A,75001,75101,48.8600,2.3530,0.92,housenumber,1 Rue A 75001 Paris",
    ].join("\n");
    const ac = new AbortController();
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls++;
      // Après le 1er chunk traité, le caller abort : le 2e ne doit pas partir.
      if (calls === 1) ac.abort();
      return Promise.resolve(new Response(okCsv, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const out = await geocodeAddressesBatch(
        [
          { key: "k1", adresse: "1 Rue A", codePostal: "75001", codeInsee: "75101" },
          { key: "k2", adresse: "2 Rue B", codePostal: "75002", codeInsee: "75102" },
          { key: "k3", adresse: "3 Rue C", codePostal: "75003", codeInsee: "75103" },
        ],
        { chunkSize: 1, scoreThreshold: 0.7, signal: ac.signal },
      );

      // Exactement 1 fetch (le 1er) ; les 2 suivants jamais lancés.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(out.chunksTotal).toBe(3);
      // 1 traité, 2 restants comptés en apiFailures (jamais un succès muet).
      expect(out.apiFailures).toBe(2);
      expect(out.results.get("k1")?.accepted).toBe(true);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[france-data-mcp]"));
    } finally {
      errSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  // Garde-fou de régression : deux lignes d'un MÊME chunk partageant la clé
  // normalisée "K" (adresses distinctes — collision attendue après
  // normalizeAddressKey). Contrat documenté : last-write-wins dans le Map, la
  // clé partagée reçoit un VRAI résultat, jamais un UNRESOLVED, et la
  // déduplication ne doit pas être prise pour un chunk « 0 mapped rows ».
  // Échouerait si la réconciliation marquait à tort une clé collisionnée
  // UNRESOLVED ou émettait le warn « 0 mapped rows » sur un chunk dédupliqué.
  it("clé dupliquée dans un chunk → 1 entrée réelle (last-write-wins), pas d'UNRESOLVED ni warn 0-mapped", async () => {
    const csvBody = [
      BAN_CSV_HEADER,
      "K,1 Rue Alpha,75001,75101,48.8600,2.3530,0.91,housenumber,1 Rue Alpha 75001 Paris",
      "K,9 Rue Omega,75001,75101,48.8700,2.3600,0.95,housenumber,9 Rue Omega 75001 Paris",
    ].join("\n");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(csvBody, { status: 200 })));

    try {
      const out = await geocodeAddressesBatch(
        [
          { key: "K", adresse: "1 Rue Alpha", codePostal: "75001", codeInsee: "75101" },
          { key: "K", adresse: "9 Rue Omega", codePostal: "75001", codeInsee: "75101" },
        ],
        // chunkSize large → les 2 lignes tiennent dans UN seul chunk
        { chunkSize: 10, scoreThreshold: 0.5 },
      );

      // Les 2 clés "K" s'effondrent en une seule entrée (Map last-write-wins)
      expect(out.results.size).toBe(1);

      const collided = out.results.get("K");
      expect(collided).toBeDefined();
      // VRAI résultat géocodé, JAMAIS l'entrée UNRESOLVED
      expect(collided?.accepted).toBe(true);
      expect(collided?.resultType).toBe("housenumber");
      expect(collided?.lat).not.toBeNull();
      expect(collided?.lon).not.toBeNull();
      expect(collided?.resultScore).not.toBeNull();

      expect(out.apiFailures).toBe(0);

      // La déduplication ne doit PAS être confondue avec un chunk 0-mappé :
      // aucun warn « 0 mapped rows » ne doit avoir été émis.
      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((m) => m.includes("0 mapped rows"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("normalizeAddressForBan", () => {
  it("retire les zéros de tête d'un numéro de voie réel", () => {
    expect(normalizeAddressForBan("03 RUE RAPHAEL ELIZE")).toBe("3 RUE RAPHAEL ELIZE");
    expect(normalizeAddressForBan("007 AVENUE DE LA GARE")).toBe("7 AVENUE DE LA GARE");
  });

  it("tronque au 1er virgule (nom de structure) — levier dominant prouvé prod BAN 4/4", () => {
    // BAN géocode toute la chaîne ; le nom de structure post-virgule fait chuter
    // le score sous le seuil voire renvoie 0 résultat. Cas réels mesurés contre
    // l'API BAN : tous NONE/rejeté en brut → 0,76-0,98 après troncature.
    expect(normalizeAddressForBan("116 RUE JEAN MERMOZ, CLINIQUE JUGE SELARL")).toBe(
      "116 RUE JEAN MERMOZ",
    );
    expect(normalizeAddressForBan("38 RUE ANDRE RIDDERS, MSP  LES HIRONDELLES")).toBe(
      "38 RUE ANDRE RIDDERS",
    );
    expect(normalizeAddressForBan("65 RUE DES CONTAMINES, POLYCLINIQUE LYON NORD")).toBe(
      "65 RUE DES CONTAMINES",
    );
    // Troncature + dézérotage combinés (résidence + zéro de tête).
    expect(normalizeAddressForBan("0002 BD MARIN, RES VILLA STE ANNE BT A")).toBe("2 BD MARIN");
  });

  it("HAZARD: structure-en-tête (ne commence PAS par un n°) → JAMAIS tronqué (gate)", () => {
    // Garde-fou anti-faux-positif (silent-failure-hunter HIGH, 15 % du corpus) :
    // tronquer `CLINIQUE SAINT-JEAN, 5 RUE DURAND` donnerait `CLINIQUE SAINT-JEAN`
    // → BAN matcherait un POI/locality FAUX. Le gate `/^\s*\d/` l'en empêche :
    // l'adresse entière est envoyée (pas d'amélioration > faux positif).
    expect(normalizeAddressForBan("CLINIQUE SAINT-JEAN, 5 RUE DURAND")).toBe(
      "CLINIQUE SAINT-JEAN, 5 RUE DURAND",
    );
    expect(normalizeAddressForBan("RESIDENCE LES TILLEULS, AVENUE DES FLEURS")).toBe(
      "RESIDENCE LES TILLEULS, AVENUE DES FLEURS",
    );
    // Voie SANS numéro suffixée d'un hameau : non tronquée non plus (pas de n° de tête).
    expect(normalizeAddressForBan("RUE DE L'EGLISE, HAMEAU DE X")).toBe(
      "RUE DE L'EGLISE, HAMEAU DE X",
    );
  });

  it("retire un numéro TOUT-À-ZÉRO (pas de numéro civique réel) → voie seule", () => {
    expect(normalizeAddressForBan("0 GRAND RUE")).toBe("GRAND RUE");
    expect(normalizeAddressForBan("00 RUE DU CENTRE")).toBe("RUE DU CENTRE");
  });

  it("suffixe accolé (sans séparateur) NON géré = laissé intact (jamais de corruption)", () => {
    // Le n° doit être suivi d'un séparateur ; un suffixe bis/ter accolé bloque le
    // match → on préfère « pas d'amélioration » à une corruption de rue collée.
    expect(normalizeAddressForBan("0002B BD MARIN")).toBe("0002B BD MARIN");
    expect(normalizeAddressForBan("02TER RUE NEUVE")).toBe("02TER RUE NEUVE");
  });

  it("HAZARD: un mot de rue collé au numéro (0RUE) n'est JAMAIS avalé", () => {
    // Garde-fou anti-corruption (silent-failure-hunter MEDIUM) : sans le groupe
    // suffixe, `0RUE` ne matche pas (pas de séparateur après le 0) → intact.
    expect(normalizeAddressForBan("0RUE DE PARIS")).toBe("0RUE DE PARIS");
  });

  it("HAZARD: fragment dégénéré sans token de voie → renvoie l'ORIGINAL (jamais un faux positif)", () => {
    // Garde-fou anti-faux-positif (silent-failure-hunter HIGH) : un fragment
    // numérique seul géocoderait en street/locality confidemment FAUX. On renvoie
    // l'original → BAN le classe municipality/unresolved → rejeté proprement.
    expect(normalizeAddressForBan("0")).toBe("0");
    expect(normalizeAddressForBan("00")).toBe("00");
    expect(normalizeAddressForBan("0,13008")).toBe("0,13008");
  });

  it("laisse intactes les adresses déjà propres ou sans numéro de tête", () => {
    expect(normalizeAddressForBan("12 RUE DE PARIS")).toBe("12 RUE DE PARIS");
    expect(normalizeAddressForBan("LE BOURG")).toBe("LE BOURG");
    expect(normalizeAddressForBan("RUE DU 8 MAI 1945")).toBe("RUE DU 8 MAI 1945");
    expect(normalizeAddressForBan('"LE BOURG"')).toBe('"LE BOURG"');
  });

  it("ne touche JAMAIS un chiffre interne (numéro de tête uniquement)", () => {
    // Le "8" interne reste ; aucun token de tête numérique → chaîne intacte.
    expect(normalizeAddressForBan("PLACE DU 11 NOVEMBRE")).toBe("PLACE DU 11 NOVEMBRE");
  });

  it("buildFormData : envoie l'adresse NORMALISÉE à BAN mais garde la clé de cache INTACTE", async () => {
    const csv = [
      BAN_CSV_HEADER,
      '"0002 BD MARIN|13008|13055",2 BD MARIN,13008,13055,43.27,5.39,0.74,housenumber,2 Bd Marin 13008 Marseille',
    ].join("\n");
    const fetchMock = vi.fn().mockResolvedValue(new Response(csv, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await geocodeAddressesBatch(
        // La clé de cache porte les zéros de tête (byte-identique au ban_join) ;
        // l'adresse envoyée à BAN doit en être expurgée.
        [
          {
            key: "0002 BD MARIN|13008|13055",
            adresse: "0002 BD MARIN",
            codePostal: "13008",
            codeInsee: "13055",
          },
        ],
        { chunkSize: 1, scoreThreshold: 0.5 },
      );

      const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
      const blob = body.get("data") as Blob;
      const sent = await blob.text();

      // L'adresse envoyée est normalisée (numéro sans zéros de tête)…
      expect(sent).toContain("2 BD MARIN");
      // …tandis que la clé de cache (1ère colonne) conserve ses zéros de tête.
      expect(sent).toContain("0002 BD MARIN|13008|13055");
      // Le numéro brut à zéros de tête ne doit PAS apparaître dans la colonne adresse
      // (séquence "0002 BD MARIN," sans pipe = colonne adresse, jamais émise telle quelle).
      expect(sent).not.toContain(",0002 BD MARIN,");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// Repli d'hôte (Géoplateforme IGN ↔ api-adresse) + 429 — emprunts 1001 feuilles,
// mesurés prod 2026-09-05 (docs/plans/ban-emprunts-1001-feuilles-mesure.md) :
// parité 1 000/1 000 entre les deux hôtes sur des adresses RPPS réelles.
describe("repli d'hôte BAN bulk + barème 429", () => {
  const ok = (key: string) =>
    new Response(
      [
        BAN_CSV_HEADER,
        `${key},1 Rue OK,75001,75101,48.8600,2.3530,0.92,housenumber,1 Rue OK 75001 Paris`,
      ].join("\n"),
      { status: 200 },
    );
  const row = (key: string) => ({
    key,
    adresse: "1 Rue OK",
    codePostal: "75001",
    codeInsee: "75101",
  });
  const isGeopf = (u: string) => u.includes("data.geopf.fr");
  /** Stub `fetch` traçant les URL appelées ; `handler(url, n)` reçoit le rang (1-based) de l'appel. */
  function stubFetch(handler: (url: string, n: number) => Promise<Response>) {
    const calls: string[] = [];
    const urlOf = (input: RequestInfo | URL): string =>
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = urlOf(input);
      return handler(url, calls.push(url));
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, hosts: () => calls.map((u) => (isGeopf(u) ? "geopf" : "gouv")) };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("BAN_BULK_HOSTS : Géoplateforme IGN en tête (successeur officiel), api-adresse (déprécié) en repli — ordre FIGÉ, même endpoint bulk CSV", () => {
    expect(BAN_BULK_HOSTS.length).toBe(2);
    expect(isGeopf(BAN_BULK_HOSTS[0])).toBe(true);
    expect(BAN_BULK_HOSTS[1].includes("api-adresse.data.gouv.fr")).toBe(true);
    for (const h of BAN_BULK_HOSTS) expect(h.endsWith("/search/csv/")).toBe(true);
  });

  it("hôte primaire injoignable (erreur réseau) → tentative suivante sur l'AUTRE hôte, chunk OK, apiFailures=0 ; le chunk suivant part DIRECTEMENT sur l'hôte qui a répondu (sticky)", async () => {
    // Panne réelle 26/08/2026 : connexion refusée (pas un 5xx) sur un hôte.
    const { hosts } = stubFetch(async (url, n) => {
      if (isGeopf(url)) throw new TypeError("fetch failed: ECONNREFUSED");
      return ok(n === 2 ? "k1" : "k2");
    });

    const out = await runWithFakeTimers(
      geocodeAddressesBatch([row("k1"), row("k2")], { chunkSize: 1, scoreThreshold: 0.5 }),
    );

    // chunk 0 : geopf KO → gouv OK ; chunk 1 : gouv direct (sticky) — 3 appels, pas 4.
    expect(hosts()).toEqual(["geopf", "gouv", "gouv"]);
    expect(out.apiFailures).toBe(0);
    expect(out.results.get("k1")?.accepted).toBe(true);
    expect(out.results.get("k2")?.accepted).toBe(true);
    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(
      warns.some(
        (m) => m.includes("data.geopf.fr") && m.includes("retrying on api-adresse.data.gouv.fr"),
      ),
    ).toBe(true);
  });

  it("5xx sur un hôte → bascule sur l'autre (le repli couvre la panne serveur, pas seulement le réseau)", async () => {
    const { hosts } = stubFetch(async (url) =>
      isGeopf(url) ? new Response("upstream error", { status: 502 }) : ok("k1"),
    );

    const out = await runWithFakeTimers(
      geocodeAddressesBatch([row("k1")], { chunkSize: 1, scoreThreshold: 0.5 }),
    );

    expect(hosts()).toEqual(["geopf", "gouv"]);
    expect(out.apiFailures).toBe(0);
  });

  it("les deux hôtes en panne → alternance sur les 4 tentatives, chunk compté en apiFailure (best-effort inchangé)", async () => {
    const { hosts } = stubFetch(async () => new Response("down", { status: 503 }));

    const out = await runWithFakeTimers(
      geocodeAddressesBatch([row("k1")], { chunkSize: 1, scoreThreshold: 0.5 }),
    );

    expect(hosts()).toEqual(["geopf", "gouv", "geopf", "gouv"]);
    expect(out.apiFailures).toBe(1);
    expect(out.results.size).toBe(0);
  });

  it("404 sur l'hôte primaire (chemin changé / décommission) → l'autre hôte UNE fois, chunk OK ; l'hôte cassé ne devient PAS sticky", async () => {
    const { hosts } = stubFetch(async (url) =>
      isGeopf(url) ? new Response("not found", { status: 404 }) : ok("k1"),
    );

    const out = await runWithFakeTimers(
      geocodeAddressesBatch([row("k1"), row("k2")], { chunkSize: 1, scoreThreshold: 0.5 }),
    );

    // chunk 0 : geopf 404 → gouv OK ; chunk 1 : gouv direct (sticky = hôte dont le corps a été LU).
    expect(hosts()).toEqual(["geopf", "gouv", "gouv"]);
    expect(out.apiFailures).toBe(0);
    expect(out.hostSwitches).toBe(1);
    expect(out.chunksByHost).toEqual({ "api-adresse.data.gouv.fr": 2 });
  });

  it("corps 200 ILLISIBLE sur l'hôte primaire (page de maintenance) → l'autre hôte, chunk OK ; l'hôte malade n'est pas promu sticky", async () => {
    const { hosts } = stubFetch(async (url) =>
      isGeopf(url) ? new Response("<html>maintenance</html>", { status: 200 }) : ok("k1"),
    );

    const out = await runWithFakeTimers(
      geocodeAddressesBatch([row("k1"), row("k2")], { chunkSize: 1, scoreThreshold: 0.5 }),
    );

    expect(hosts()).toEqual(["geopf", "gouv", "gouv"]);
    expect(out.apiFailures).toBe(0);
    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warns.some((m) => m.includes("chunk 0") && m.includes("data.geopf.fr"))).toBe(true);
    expect(
      warns.some((m) => m.includes("preferred BAN host data.geopf.fr → api-adresse.data.gouv.fr")),
    ).toBe(true);
  });

  it("404 sur les DEUX hôtes → exactement 2 appels (la requête est fautive, pas l'hôte), apiFailure, ligne d'abandon nommant les deux hôtes", async () => {
    const { fetchMock } = stubFetch(async () => new Response("not found", { status: 404 }));

    const out = await runWithFakeTimers(
      geocodeAddressesBatch([row("k1")], { chunkSize: 1, scoreThreshold: 0.5 }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.apiFailures).toBe(1);
    const errs = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(
      errs.some(
        (m) =>
          m.includes("data.geopf.fr: HTTP 404") && m.includes("api-adresse.data.gouv.fr: HTTP 404"),
      ),
    ).toBe(true);
  });

  it("abort caller PENDANT l'attente 429 (retry-after 60 s) → arrêt net, pas d'attente jusqu'au réveil", async () => {
    const controller = new AbortController();
    const queue = [new Response("rate limited", { status: 429, headers: { "retry-after": "60" } })];
    const { fetchMock } = stubFetch(async () => queue.shift() ?? ok("k1"));

    const promise = geocodeAddressesBatch([row("k1"), row("k2")], {
      chunkSize: 1,
      scoreThreshold: 0.5,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1_000); // 1er appel fait, attente 60 s en cours
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10); // bien avant les 60 s
    const out = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.apiFailures).toBe(2);
  });

  it("429 avec `retry-after: 7` → attend 7 s (le header prime) sur le MÊME hôte (pas de bascule sur un quota), puis succès", async () => {
    const queue = [new Response("rate limited", { status: 429, headers: { "retry-after": "7" } })];
    const { fetchMock, hosts } = stubFetch(async () => queue.shift() ?? ok("k1"));

    const promise = geocodeAddressesBatch([row("k1")], { chunkSize: 1, scoreThreshold: 0.5 });
    await vi.advanceTimersByTimeAsync(6_000); // l'ancien backoff 0,5 s aurait déjà re-tapé
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500); // 7 s + jitter (< 250 ms)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const out = await promise;

    expect(hosts()).toEqual(["geopf", "geopf"]);
    expect(out.apiFailures).toBe(0);
    expect(out.rateLimitRetries).toBe(1);
    expect(out.hostSwitches).toBe(0);
    expect(out.results.get("k1")?.accepted).toBe(true);
  });

  it("429 SANS retry-after → barème 2 s puis 4 s (jamais le backoff 0,5 s), même hôte", async () => {
    const queue = [
      new Response("rate limited", { status: 429 }),
      new Response("rate limited", { status: 429 }),
    ];
    const { fetchMock, hosts } = stubFetch(async () => queue.shift() ?? ok("k1"));

    const promise = geocodeAddressesBatch([row("k1")], { chunkSize: 1, scoreThreshold: 0.5 });
    await vi.advanceTimersByTimeAsync(1_500); // t=1,5 s : 1er 429 attend 2 s
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000); // t=2,5 s : 2e tentative partie (2 s + jitter)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000); // t=5,5 s : 2e 429 attend 4 s → pas encore
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_500); // t=7 s : 3e tentative partie (≥ 6,25 s)
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const out = await promise;

    expect(hosts()).toEqual(["geopf", "geopf", "geopf"]);
    expect(out.apiFailures).toBe(0);
    expect(out.rateLimitRetries).toBe(2);
    expect(out.results.get("k1")?.accepted).toBe(true);
  });
});
