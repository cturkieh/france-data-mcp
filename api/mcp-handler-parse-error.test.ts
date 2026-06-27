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

  it("POST avec exception non-SyntaxError dans le catch root → captureMcpError appelé (path Sentry préservé)", async () => {
    // Garde-fou anti-régression : un genuine bug serveur (ex: extractIp throw)
    // doit toujours être capturé Sentry. La détection SyntaxError ne doit pas
    // élargir le silence.
    const req = {
      method: "POST",
      headers: { "content-type": "application/json" },
      get body() {
        throw new TypeError("genuine server bug: undefined.foo");
      },
    };
    const { res } = makeMockVercelRes();

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: mock minimal du contrat Vercel
      handler(req as any, res),
    ).rejects.toThrow(/genuine server bug/);
    expect(mocks.captureMcpError).toHaveBeenCalledTimes(1);
  });
});
