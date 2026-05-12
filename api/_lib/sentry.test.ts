import * as Sentry from "@sentry/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __ensureInitForTesting,
  __resetSentryForTesting,
  captureMcpError,
  flushSentry,
  isSentryEnabled,
} from "./sentry.js";

vi.mock("@sentry/node", () => {
  const scope = {
    setTag: vi.fn(),
    setContext: vi.fn(),
  };
  return {
    init: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn().mockResolvedValue(true),
    withScope: vi.fn((cb: (s: typeof scope) => void) => cb(scope)),
    __scope: scope,
  };
});

const ctx = {
  method: "tools/call",
  tool: "etablissements_finess_in_radius",
  outcome: "internal_error" as const,
  ipHash: "deadbeef",
  userAgent: "Claude/1.0",
};

function mockedScope() {
  return (
    Sentry as unknown as {
      __scope: { setTag: ReturnType<typeof vi.fn>; setContext: ReturnType<typeof vi.fn> };
    }
  ).__scope;
}

describe("Sentry integration", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    __resetSentryForTesting();
    vi.mocked(Sentry.init).mockClear();
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(Sentry.flush).mockClear();
    vi.mocked(Sentry.withScope).mockClear();
    mockedScope().setTag.mockClear();
    mockedScope().setContext.mockClear();
    // vi.stubEnv auto-restore via afterEach() unstubAllEnvs — pas de pollution
    // entre tests / suites parallèles.
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("SENTRY_ENVIRONMENT", "");
    vi.stubEnv("SENTRY_RELEASE", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("sans DSN", () => {
    it("isSentryEnabled retourne false sans déclencher d'init (passif)", () => {
      expect(isSentryEnabled()).toBe(false);
      expect(Sentry.init).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("captureMcpError déclenche l'init lazy et logge le warn 'désactivé'", () => {
      captureMcpError(new Error("boom"), ctx);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Sentry désactivé"));
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it("captureMcpError ne crash pas", () => {
      expect(() => captureMcpError(new Error("boom"), ctx)).not.toThrow();
    });

    it("flushSentry ne crash pas et n'appelle pas Sentry.flush", async () => {
      await expect(flushSentry()).resolves.toBeUndefined();
      expect(Sentry.flush).not.toHaveBeenCalled();
    });

    it("ne logge le warn 'désactivé' qu'une seule fois (idempotence)", () => {
      captureMcpError(new Error("a"), ctx);
      captureMcpError(new Error("b"), ctx);
      const warns = warnSpy.mock.calls.filter((c) =>
        String(c[0] ?? "").includes("Sentry désactivé"),
      );
      expect(warns).toHaveLength(1);
    });
  });

  describe("avec DSN", () => {
    beforeEach(() => {
      vi.stubEnv("SENTRY_DSN", "https://abc@o1.ingest.de.sentry.io/123");
    });

    it("init Sentry au 1er captureMcpError et flag enabled", () => {
      expect(isSentryEnabled()).toBe(false);
      captureMcpError(new Error("first"), ctx);
      expect(Sentry.init).toHaveBeenCalledTimes(1);
      expect(isSentryEnabled()).toBe(true);
    });

    it("init est idempotente — un seul appel même après plusieurs captures", () => {
      captureMcpError(new Error("a"), ctx);
      captureMcpError(new Error("b"), ctx);
      __ensureInitForTesting();
      expect(Sentry.init).toHaveBeenCalledTimes(1);
    });

    it("captureMcpError envoie l'exception avec tags et context MCP", () => {
      const err = new Error("tool exploded");
      captureMcpError(err, ctx);
      expect(Sentry.captureException).toHaveBeenCalledWith(err);
      const scope = mockedScope();
      expect(scope.setTag).toHaveBeenCalledWith("mcp.method", "tools/call");
      expect(scope.setTag).toHaveBeenCalledWith("mcp.tool", "etablissements_finess_in_radius");
      expect(scope.setTag).toHaveBeenCalledWith("mcp.outcome", "internal_error");
      expect(scope.setContext).toHaveBeenCalledWith(
        "mcp_request",
        expect.objectContaining({
          ip_hash: "deadbeef",
          user_agent: "Claude/1.0",
        }),
      );
    });

    it("captureMcpError omet le tag tool quand tool est absent", () => {
      captureMcpError(new Error("meta error"), { ...ctx, tool: undefined });
      const scope = mockedScope();
      const toolCalls = scope.setTag.mock.calls.filter((c: unknown[]) => c[0] === "mcp.tool");
      expect(toolCalls).toHaveLength(0);
    });

    it("captureMcpError omet le tag tool si tool est une string vide", () => {
      captureMcpError(new Error("empty"), { ...ctx, tool: "" });
      const scope = mockedScope();
      const toolCalls = scope.setTag.mock.calls.filter((c: unknown[]) => c[0] === "mcp.tool");
      expect(toolCalls).toHaveLength(0);
    });

    it("captureMcpError omet le tag tool si tool est non-string (defense-in-depth)", () => {
      captureMcpError(new Error("bad type"), {
        ...ctx,
        tool: 42 as unknown as string,
      });
      const scope = mockedScope();
      const toolCalls = scope.setTag.mock.calls.filter((c: unknown[]) => c[0] === "mcp.tool");
      expect(toolCalls).toHaveLength(0);
    });

    it("captureMcpError merge le extra dans le context MCP", () => {
      captureMcpError(new Error("layered"), { ...ctx, extra: { layer: "json_stringify" } });
      const scope = mockedScope();
      expect(scope.setContext).toHaveBeenCalledWith(
        "mcp_request",
        expect.objectContaining({
          layer: "json_stringify",
        }),
      );
    });

    it("flushSentry appelle Sentry.flush avec timeout par défaut 2000ms", async () => {
      __ensureInitForTesting();
      await flushSentry();
      expect(Sentry.flush).toHaveBeenCalledWith(2000);
    });

    it("flushSentry propage le timeout custom", async () => {
      __ensureInitForTesting();
      await flushSentry(500);
      expect(Sentry.flush).toHaveBeenCalledWith(500);
    });

    it("captureMcpError ne throw pas si Sentry.captureException throw", () => {
      vi.mocked(Sentry.captureException).mockImplementationOnce(() => {
        throw new Error("Sentry HTTP down");
      });
      expect(() => captureMcpError(new Error("x"), ctx)).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Sentry captureException failed"),
      );
    });

    it("flushSentry ne throw pas si Sentry.flush reject", async () => {
      __ensureInitForTesting();
      vi.mocked(Sentry.flush).mockRejectedValueOnce(new Error("flush timeout"));
      await expect(flushSentry()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Sentry flush failed"));
    });

    it("dégrade en no-op si Sentry.init throw (DSN malformé)", () => {
      vi.mocked(Sentry.init).mockImplementationOnce(() => {
        throw new Error("Invalid DSN");
      });
      captureMcpError(new Error("x"), ctx);
      expect(isSentryEnabled()).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Sentry init failed"));
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it("propage VERCEL_GIT_COMMIT_SHA comme release par défaut", () => {
      vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc1234");
      __ensureInitForTesting();
      expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ release: "abc1234" }));
    });

    it("propage VERCEL_ENV comme environment par défaut", () => {
      vi.stubEnv("VERCEL_ENV", "preview");
      __ensureInitForTesting();
      expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ environment: "preview" }));
    });

    it("override SENTRY_ENVIRONMENT a priorité sur VERCEL_ENV", () => {
      vi.stubEnv("VERCEL_ENV", "preview");
      vi.stubEnv("SENTRY_ENVIRONMENT", "staging");
      __ensureInitForTesting();
      expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ environment: "staging" }));
    });
  });
});
