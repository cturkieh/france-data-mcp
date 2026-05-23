/**
 * Garde-fou V0.19.0 : propagation `err.cause` → JSON-RPC `error.data`.
 *
 * Source : `docs/plans/nom-commune-resolver-v019.md` §2 décision 5.
 *
 * Le patch `api/mcp.ts:384-393` ajoute `const data = err.cause; return
 * error(id, -32602, message, data);`. Sans ce test, une régression future
 * (suppression du 4ème arg) briserait silencieusement le contrat Geo Intel —
 * le caller perdrait le payload structuré (`kind`, `candidates`, etc.) et
 * tomberait sur le seul message texte.
 *
 * Setup similaire à `api/mcp-handler-parse-error.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureMcpError: vi.fn(),
}));

vi.mock("./_lib/sentry.js", () => ({
  captureMcpError: mocks.captureMcpError,
  captureMcpConfigWarning: vi.fn(),
  flushSentry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./_lib/observability.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    flushMcpEventsToAxiom: vi.fn().mockResolvedValue(undefined),
  };
});

import handler from "./mcp.js";

function makeMockRes() {
  const captured: { status?: number; json?: unknown; ended: boolean } = { ended: false };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: unknown) {
      captured.json = payload;
      return res;
    },
    end() {
      captured.ended = true;
      return res;
    },
    setHeader() {
      return res;
    },
  };
  return { res, captured };
}

describe("api/mcp.ts — propagation RangeError.cause → JSON-RPC error.data", () => {
  beforeEach(() => mocks.captureMcpError.mockClear());
  afterEach(() => vi.restoreAllMocks());

  it("nom_commune + code_insee simultanés → error.data = { kind: redundant_commune_params, input: ... }", async () => {
    // On déclenche le path RangeError({cause}) via le boundary by_categorie
    // V0.19.0 : nom_commune + code_insee → throw redundant_commune_params.
    // Le test valide bout-en-bout : RangeError(msg, {cause}) → catch root
    // api/mcp.ts → propagation au 4ème arg de error() → error.data peuplé.
    const req = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: {
          name: "etablissements_finess_by_categorie",
          arguments: { categorie: "labo", nom_commune: "Lille", code_insee: "59350" },
        },
      },
    };
    const { res, captured } = makeMockRes();

    // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat Vercel
    await handler(req as any, res as any);

    // JSON-RPC encapsule les erreurs dans le payload (HTTP 200 toujours, sauf parse error 400).
    // L'erreur est portée par error.code = -32602, pas le HTTP status.
    expect(captured.status).toBe(200);
    const json = captured.json as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string; data?: unknown };
    };
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toMatch(/redondants|SOIT/i);
    // Critique : error.data doit contenir le payload structuré (V0.19 patch).
    expect(json.error.data).toMatchObject({
      kind: "redundant_commune_params",
      input: expect.objectContaining({ nom_commune: "Lille", code_insee: "59350" }),
    });
    // Pas de Sentry capture : RangeError = faute caller (-32602), pas erreur serveur.
    expect(mocks.captureMcpError).not.toHaveBeenCalled();
  });

  it("RangeError sans cause (ex requireString classique) → error.data undefined, pas de crash", async () => {
    // Garde-fou anti-régression : pour TOUS les autres RangeError sans cause
    // (validators existants requireString/requireOneOf/etc.), `err.cause` est
    // undefined → on passe undefined comme 4ème arg → error.data absent du JSON
    // (cohérent JSON-RPC 2.0 §5.1, "data" est optionnel).
    const req = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          // Tool qui throw RangeError SANS cause (cas hyper classique : requireString).
          // panorama_sante_territoire sans aucun param → RangeError "scope requis"
          // (message-only, pas de cause structurée — branch 6 applyCommuneResolver).
          name: "panorama_sante_territoire",
          arguments: {},
        },
      },
    };
    const { res, captured } = makeMockRes();

    // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat Vercel
    await handler(req as any, res as any);

    // JSON-RPC encapsule les erreurs dans le payload (HTTP 200, sauf parse error).
    expect(captured.status).toBe(200);
    const json = captured.json as { error: { code: number; data?: unknown } };
    expect(json.error.code).toBe(-32602);
    // error.data devrait être undefined (RangeError sans cause).
    expect(json.error.data).toBeUndefined();
  });
});
