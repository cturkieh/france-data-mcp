import type { VercelRequest } from "@vercel/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetForTesting,
  __resetSaltWarningForTesting,
  checkRateLimit,
  extractIp,
  getRateLimitPerMinute,
  hashIp,
} from "./rate-limit.js";
import { captureMcpConfigWarning } from "./sentry.js";

vi.mock("./sentry.js", async () => {
  const actual = await vi.importActual<typeof import("./sentry.js")>("./sentry.js");
  return { ...actual, captureMcpConfigWarning: vi.fn() };
});

/** Build a minimal VercelRequest-compatible object for header tests. */
function fakeReq(headers: Record<string, string | string[] | undefined>, remoteAddress?: string) {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as VercelRequest;
}

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "RATE_LIMIT_PER_MINUTE",
  "RATE_LIMIT_ENABLED",
  "FRANCE_DATA_IP_SALT",
  "VERCEL_ENV",
  "NODE_ENV",
];

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  __resetForTesting();
  __resetSaltWarningForTesting();
  vi.mocked(captureMcpConfigWarning).mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  __resetForTesting();
  __resetSaltWarningForTesting();
});

describe("extractIp", () => {
  it("priorise x-real-ip (non-spoofable, posé par Vercel)", () => {
    // Même si XFF contient un IP spoofé, x-real-ip gagne.
    expect(
      extractIp(
        fakeReq({
          "x-real-ip": "198.51.100.5",
          "x-forwarded-for": "1.1.1.1, 198.51.100.5",
        }),
      ),
    ).toBe("198.51.100.5");
  });

  it("anti-spoofing : prend le DERNIER segment de x-forwarded-for, pas le premier", () => {
    // Vercel append la vraie IP en queue : `<spoofed>, <real-client>`.
    // Le client peut mettre n'importe quoi à gauche.
    expect(extractIp(fakeReq({ "x-forwarded-for": "1.1.1.1, 203.0.113.42" }))).toBe("203.0.113.42");
  });

  it("trim les espaces autour de l'IP", () => {
    expect(extractIp(fakeReq({ "x-forwarded-for": "  203.0.113.42  " }))).toBe("203.0.113.42");
  });

  it("retourne l'IP unique si XFF n'a qu'un segment", () => {
    expect(extractIp(fakeReq({ "x-forwarded-for": "203.0.113.99" }))).toBe("203.0.113.99");
  });

  it("ignore les segments vides dans XFF (virgules en trop)", () => {
    expect(extractIp(fakeReq({ "x-forwarded-for": "1.1.1.1, , 203.0.113.7, " }))).toBe(
      "203.0.113.7",
    );
  });

  it("fallback sur socket.remoteAddress en dernier recours", () => {
    expect(extractIp(fakeReq({}, "127.0.0.1"))).toBe("127.0.0.1");
  });

  it("retourne 'unknown' si aucune source dispo", () => {
    expect(extractIp(fakeReq({}))).toBe("unknown");
  });

  it("ignore x-forwarded-for vide", () => {
    expect(extractIp(fakeReq({ "x-forwarded-for": "" }, "10.0.0.1"))).toBe("10.0.0.1");
  });

  it("ignore x-forwarded-for ne contenant que des virgules / espaces", () => {
    expect(extractIp(fakeReq({ "x-forwarded-for": ", ,, " }, "10.0.0.1"))).toBe("10.0.0.1");
  });
});

describe("hashIp", () => {
  it("retourne un hash stable de 16 caractères", () => {
    const h1 = hashIp("203.0.113.1");
    expect(h1).toMatch(/^[a-f0-9]{16}$/);
    expect(hashIp("203.0.113.1")).toBe(h1);
  });

  it("hash différent pour IPs différentes", () => {
    expect(hashIp("203.0.113.1")).not.toBe(hashIp("203.0.113.2"));
  });

  it("salt env change le hash (rotation crypto)", () => {
    const hUnsalted = hashIp("203.0.113.1");
    process.env.FRANCE_DATA_IP_SALT = "salt-2026-05";
    const hSaltedA = hashIp("203.0.113.1");
    process.env.FRANCE_DATA_IP_SALT = "salt-2026-06";
    const hSaltedB = hashIp("203.0.113.1");
    expect(hSaltedA).not.toBe(hUnsalted);
    expect(hSaltedA).not.toBe(hSaltedB);
    expect(hSaltedA).toMatch(/^[a-f0-9]{16}$/);
  });

  it("salt vide string ≡ salt absent (même hash que le fallback)", () => {
    const hAbsent = hashIp("203.0.113.1");
    process.env.FRANCE_DATA_IP_SALT = "";
    expect(hashIp("203.0.113.1")).toBe(hAbsent);
  });

  it("salt whitespace seul ≡ salt absent (trim appliqué)", () => {
    const hAbsent = hashIp("203.0.113.1");
    process.env.FRANCE_DATA_IP_SALT = "   ";
    expect(hashIp("203.0.113.1")).toBe(hAbsent);
  });
});

describe("hashIp — silent-failure warn", () => {
  it("warn une fois en production si salt absent", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.VERCEL_ENV = "production";
    hashIp("1.2.3.4");
    hashIp("5.6.7.8");
    hashIp("9.10.11.12");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("FRANCE_DATA_IP_SALT");
    errSpy.mockRestore();
  });

  it("warn aussi en preview (V0.9.2 — staging Vercel sert du trafic réel, même promesse RGPD)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.VERCEL_ENV = "preview";
    hashIp("1.2.3.4");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("FRANCE_DATA_IP_SALT");
    errSpy.mockRestore();
  });

  it("ne warn pas en dev/test (CI, local) — silencieux par design", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.VERCEL_ENV = "development";
    hashIp("1.2.3.4");
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("ne warn pas en dev local", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    hashIp("1.2.3.4");
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("ne warn pas en production si salt présent", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.VERCEL_ENV = "production";
    process.env.FRANCE_DATA_IP_SALT = "valid-salt-string";
    hashIp("1.2.3.4");
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("warn en production si salt = whitespace seul (anti-empty trick)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.VERCEL_ENV = "production";
    process.env.FRANCE_DATA_IP_SALT = "   ";
    hashIp("1.2.3.4");
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("en production sans salt, émet aussi un Sentry config_warning (code 'missing_ip_salt')", () => {
    process.env.VERCEL_ENV = "production";
    hashIp("1.2.3.4");
    hashIp("5.6.7.8");
    // captureMcpConfigWarning suit la one-shot du warn console — pas de spam Sentry
    expect(captureMcpConfigWarning).toHaveBeenCalledTimes(1);
    expect(captureMcpConfigWarning).toHaveBeenCalledWith(
      "missing_ip_salt",
      expect.stringContaining("FRANCE_DATA_IP_SALT"),
    );
  });

  it("en preview aussi, Sentry config_warning émis (V0.9.2 — staging Vercel sert trafic réel)", () => {
    process.env.VERCEL_ENV = "preview";
    hashIp("1.2.3.4");
    expect(captureMcpConfigWarning).toHaveBeenCalledTimes(1);
    expect(captureMcpConfigWarning).toHaveBeenCalledWith(
      "missing_ip_salt",
      expect.stringContaining("FRANCE_DATA_IP_SALT"),
    );
  });

  it("hors prod/preview (dev/test), pas de Sentry config_warning", () => {
    process.env.VERCEL_ENV = "development";
    hashIp("1.2.3.4");
    expect(captureMcpConfigWarning).not.toHaveBeenCalled();
  });
});

describe("getRateLimitPerMinute", () => {
  it("default 60 si env absente", () => {
    expect(getRateLimitPerMinute()).toBe(60);
  });

  it("respecte la valeur env", () => {
    process.env.RATE_LIMIT_PER_MINUTE = "120";
    expect(getRateLimitPerMinute()).toBe(120);
  });

  it("retombe sur le default si parse échoue", () => {
    process.env.RATE_LIMIT_PER_MINUTE = "not-a-number";
    expect(getRateLimitPerMinute()).toBe(60);
  });

  it("retombe sur le default si valeur <= 0", () => {
    process.env.RATE_LIMIT_PER_MINUTE = "-5";
    expect(getRateLimitPerMinute()).toBe(60);
    process.env.RATE_LIMIT_PER_MINUTE = "0";
    expect(getRateLimitPerMinute()).toBe(60);
  });
});

describe("checkRateLimit — désactivé", () => {
  it("retourne success=true et backend='disabled' quand RATE_LIMIT_ENABLED=false", async () => {
    process.env.RATE_LIMIT_ENABLED = "false";
    const res = await checkRateLimit("any-hash");
    expect(res.success).toBe(true);
    expect(res.backend).toBe("disabled");
    expect(res.retryAfterSeconds).toBe(0);
  });
});

describe("checkRateLimit — fallback in-memory", () => {
  it("laisse passer sous la limite", async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "3";
    const ip = "abc123";
    const r1 = await checkRateLimit(ip);
    expect(r1.success).toBe(true);
    expect(r1.backend).toBe("memory");
    expect(r1.limit).toBe(3);
    expect(r1.remaining).toBe(2);
    const r2 = await checkRateLimit(ip);
    expect(r2.success).toBe(true);
    expect(r2.remaining).toBe(1);
    const r3 = await checkRateLimit(ip);
    expect(r3.success).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("bloque au-delà de la limite avec Retry-After >= 1s", async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "2";
    const ip = "burst-client";
    await checkRateLimit(ip);
    await checkRateLimit(ip);
    const r3 = await checkRateLimit(ip);
    expect(r3.success).toBe(false);
    expect(r3.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(r3.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(r3.remaining).toBe(0);
  });

  it("isole les buckets par hash IP", async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "1";
    const r1 = await checkRateLimit("client-a");
    const r2 = await checkRateLimit("client-b");
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });
});
