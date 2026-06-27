import type { VercelResponse } from "@vercel/node";

/** Champs capturés par le mock de réponse Vercel pour les assertions. */
export type CapturedRes = { status?: number; json?: unknown; ended: boolean };

/**
 * Mock minimal d'un `VercelResponse` qui capture `status()` / `json()` /
 * `end()` et chaîne comme l'API réelle (`res.status(x).json(y)`). Source UNIQUE
 * du mock, partagée par les tests du handler MCP (`api/mcp*.test.ts`) — évite la
 * triplication byte-identique relevée en revue.
 */
export function makeMockVercelRes(): { res: VercelResponse; captured: CapturedRes } {
  const captured: CapturedRes = { ended: false };
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
  return { res: res as unknown as VercelResponse, captured };
}
