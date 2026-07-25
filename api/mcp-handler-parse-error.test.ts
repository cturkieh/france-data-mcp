import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockVercelRes } from "./_lib/test-helpers.js";

// vi.hoisted() : les factories de vi.mock sont hoistées au top du fichier,
// donc elles ne peuvent pas référencer des variables `const` du module-level
// (ReferenceError 'Cannot access ... before initialization'). hoisted() colle
// les mocks au même niveau que les factories.
//
// On mock SEULEMENT `captureMcpError` (seul mock asserté). `flushSentry` et
// `flushMcpEventsToAxiom` sont stubés par factory inline (no-op) pour éviter
// l'I/O réel du `finally` root sans pollution du namespace de test.
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

describe("handler — JSON parse error (P2 backlog cleanup)", () => {
  beforeEach(() => {
    mocks.captureMcpError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POST avec body access throwing SyntaxError → 400 JSON-RPC -32700 propre, SANS captureMcpError", async () => {
    // Simule le comportement @vercel/node quand le body parse échoue : le
    // getter `body` throw SyntaxError au moment où le handler y accède
    // (ligne `const body = req.body` dans mcp.ts). Pattern documenté dans
    // le commentaire du catch root.
    const req = {
      method: "POST",
      headers: { "content-type": "application/json" },
      get body() {
        throw new SyntaxError("Unexpected token i in JSON at position 0");
      },
    };
    const { res, captured } = makeMockVercelRes();

    // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat Vercel
    await handler(req as any, res);

    expect(captured.status).toBe(400);
    expect(captured.json).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });
    // Message d'erreur doit mentionner "Parse error" (spec JSON-RPC 2.0 §5.1).
    const json = captured.json as { error: { message: string } };
    expect(json.error.message).toMatch(/Parse error/i);
    // Aucun captureMcpError : un JSON malformé caller-side n'est PAS une erreur
    // serveur (réduit le bruit Sentry, complète le drop bot-noise existant).
    expect(mocks.captureMcpError).not.toHaveBeenCalled();
  });

  it("POST avec body access throwing Error nu « Invalid JSON » (FORME RÉELLE PROD) → 400 -32700, SANS captureMcpError", async () => {
    // Régression FRANCE-DATA-MCP-1, prouvée prod (7 events, reproduction
    // déterministe 2026-07-25) : le runtime Vercel `/opt/rust/nodejs.js` NE
    // throw PAS un `SyntaxError` mais un `Error` NU de message "Invalid JSON"
    // depuis `IncomingMessage.get [as body]`. La discrimination historique
    // `err instanceof SyntaxError` ne matchait donc JAMAIS en prod → chaque
    // POST malformé partait en `captureMcpError` (bruit Sentry, outcome
    // `internal_error` = faute caller comptée comme bug serveur) et le caller
    // recevait un 400 à CORPS VIDE au lieu d'un JSON-RPC -32700.
    //
    // La classification ne doit donc PAS dépendre de la CLASSE de l'exception
    // (couplage au runtime, non testable localement) mais de son SITE : toute
    // exception levée par l'accès à `req.body` est un échec de parse caller.
    const req = {
      method: "POST",
      headers: { "content-type": "application/json" },
      get body(): unknown {
        throw new Error("Invalid JSON");
      },
    };
    const { res, captured } = makeMockVercelRes();

    // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat Vercel
    await handler(req as any, res);

    expect(captured.status).toBe(400);
    expect(captured.json).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });
    expect(mocks.captureMcpError).not.toHaveBeenCalled();
  });

  it("POST avec exception HORS accès body (headers throw) → captureMcpError appelé (path Sentry préservé)", async () => {
    // Garde-fou anti-régression : un genuine bug serveur doit toujours être
    // capturé Sentry. Le véhicule est `req.headers` (lu par `extractIp` /
    // `extractUserAgent`, AVANT l'accès body) et non plus le getter `body` —
    // depuis le fix FRANCE-DATA-MCP-1, TOUTE exception au site `req.body` est
    // classée faute caller ; utiliser ce getter comme véhicule testerait
    // l'inverse de la règle.
    const req = {
      method: "POST",
      get headers(): unknown {
        throw new TypeError("genuine server bug: undefined.foo");
      },
      body: { jsonrpc: "2.0", method: "ping", id: 1 },
    };
    const { res } = makeMockVercelRes();

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat Vercel
      handler(req as any, res),
    ).rejects.toThrow(/genuine server bug/);
    expect(mocks.captureMcpError).toHaveBeenCalledTimes(1);
  });
});
