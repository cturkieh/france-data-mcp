/**
 * Tests endpoint `/healthz` — état config sans secret exposé.
 *
 * Le contrat couvert :
 *  - GET et HEAD retournent toujours 200 (config dégradée ≠ service down)
 *  - autres méthodes → 405
 *  - aucune valeur d'env var n'est exposée dans le body, uniquement des booléens
 *  - les sous-objets `config.*` suivent une shape stable consommable par
 *    un monitor externe (Uptime Kuma, Better Stack, etc.)
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "./healthz.js";

type MockedResponse = VercelResponse & {
  statusCode: number;
  body: unknown;
  ended: boolean;
};

function makeReq(method: string, headers: Record<string, string> = {}): VercelRequest {
  return { method, headers, socket: {} } as unknown as VercelRequest;
}

function makeRes(): MockedResponse {
  const res: Partial<MockedResponse> = {
    statusCode: 0,
    body: undefined,
    ended: false,
  };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as MockedResponse;
  });
  res.json = vi.fn((data: unknown) => {
    res.body = data;
    res.ended = true;
    return res as MockedResponse;
  });
  res.end = vi.fn(() => {
    res.ended = true;
    return res as MockedResponse;
  });
  return res as MockedResponse;
}

const ENV_KEYS = [
  "AXIOM_TOKEN",
  "AXIOM_DATASET",
  "AXIOM_HOST",
  "FRANCE_DATA_IP_SALT",
  "SENTRY_DSN",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "INSEE_SIRENE_API_KEY",
  "ANS_FHIR_API_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];

describe("api/healthz", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("GET returns 200 + status degraded (Supabase + IP salt absents) + version + config shape", async () => {
    const req = makeReq("GET");
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    // HTTP 200 préservé (Smithery / registries OK) mais status signale dégradation
    expect(body.status).toBe("degraded");
    expect(typeof body.version).toBe("string");
    expect(typeof body.timestamp).toBe("string");

    const config = body.config as Record<string, { configured: boolean }>;
    expect(config.axiom.configured).toBe(false);
    expect(config.ip_salt.configured).toBe(false);
    expect(config.sentry.configured).toBe(false);
    expect(config.supabase.configured).toBe(false);
    expect(config.insee_sirene.configured).toBe(false);
    expect(config.ans_fhir.configured).toBe(false);
    expect(config.upstash.configured).toBe(false);
  });

  it("status ok quand Supabase + IP salt configurés, même si autres deps absentes", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.FRANCE_DATA_IP_SALT = "deadbeef".repeat(8);

    const res = makeRes();
    await handler(makeReq("GET"), res);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("ok");
  });

  it("status degraded si Supabase OK mais IP salt absent (RGPD non tenu)", async () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";

    const res = makeRes();
    await handler(makeReq("GET"), res);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("degraded");
  });

  it("status degraded si IP salt OK mais Supabase absent (tools santé KO)", async () => {
    process.env.FRANCE_DATA_IP_SALT = "deadbeef".repeat(8);

    const res = makeRes();
    await handler(makeReq("GET"), res);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("degraded");
  });

  it("GET reflects configured env vars as true (booléens, jamais la valeur)", async () => {
    process.env.AXIOM_TOKEN = "xaat-secret";
    process.env.AXIOM_DATASET = "france-data-mcp";
    process.env.FRANCE_DATA_IP_SALT = "deadbeef".repeat(8);
    process.env.SENTRY_DSN = "https://abc@sentry.io/1";
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    process.env.INSEE_SIRENE_API_KEY = "uuid";
    process.env.ANS_FHIR_API_KEY = "uuid";
    process.env.UPSTASH_REDIS_REST_URL = "https://x.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "tok";

    const res = makeRes();
    await handler(makeReq("GET"), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    const config = body.config as Record<string, { configured: boolean }>;
    expect(config.axiom.configured).toBe(true);
    expect(config.ip_salt.configured).toBe(true);
    expect(config.sentry.configured).toBe(true);
    expect(config.supabase.configured).toBe(true);
    expect(config.insee_sirene.configured).toBe(true);
    expect(config.ans_fhir.configured).toBe(true);
    expect(config.upstash.configured).toBe(true);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("xaat-secret");
    expect(serialized).not.toContain("deadbeef");
    expect(serialized).not.toContain("anon-key");
    expect(serialized).not.toContain("sentry.io/1");
  });

  it("expose axiom.host (default US ou EU override) — info publique utile", async () => {
    process.env.AXIOM_TOKEN = "tok";
    process.env.AXIOM_DATASET = "ds";

    const res1 = makeRes();
    await handler(makeReq("GET"), res1);
    const body1 = res1.body as Record<string, unknown>;
    const axiom1 = (body1.config as Record<string, unknown>).axiom as { host: string };
    expect(axiom1.host).toBe("api.axiom.co");

    process.env.AXIOM_HOST = "api.eu.axiom.co";
    const res2 = makeRes();
    await handler(makeReq("GET"), res2);
    const body2 = res2.body as Record<string, unknown>;
    const axiom2 = (body2.config as Record<string, unknown>).axiom as { host: string };
    expect(axiom2.host).toBe("api.eu.axiom.co");
  });

  it("env var set but empty string compte comme non configurée", async () => {
    process.env.SENTRY_DSN = "";
    process.env.FRANCE_DATA_IP_SALT = "   ";

    const res = makeRes();
    await handler(makeReq("GET"), res);
    const body = res.body as Record<string, unknown>;
    const config = body.config as Record<string, { configured: boolean }>;
    expect(config.sentry.configured).toBe(false);
    expect(config.ip_salt.configured).toBe(false);
  });

  it("HEAD returns 200 with no body (cheap monitor ping)", async () => {
    const res = makeRes();
    await handler(makeReq("HEAD"), res);

    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
    expect(res.body).toBeUndefined();
  });

  it("non-GET/HEAD method returns 405", async () => {
    const res = makeRes();
    await handler(makeReq("POST"), res);

    expect(res.statusCode).toBe(405);
  });
});
