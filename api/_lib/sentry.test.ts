import * as Sentry from "@sentry/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __ensureInitForTesting,
  __resetSentryForTesting,
  beforeSendEvent,
  captureMcpConfigWarning,
  captureMcpError,
  flushSentry,
  isBotNoiseEvent,
  isSentryEnabled,
} from "./sentry.js";

vi.mock("@sentry/node", () => {
  const scope = {
    setTag: vi.fn(),
    setContext: vi.fn(),
    setLevel: vi.fn(),
    setFingerprint: vi.fn(),
  };
  return {
    init: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
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
      __scope: {
        setTag: ReturnType<typeof vi.fn>;
        setContext: ReturnType<typeof vi.fn>;
        setLevel: ReturnType<typeof vi.fn>;
        setFingerprint: ReturnType<typeof vi.fn>;
      };
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
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(Sentry.flush).mockClear();
    vi.mocked(Sentry.withScope).mockClear();
    mockedScope().setTag.mockClear();
    mockedScope().setContext.mockClear();
    mockedScope().setLevel.mockClear();
    mockedScope().setFingerprint.mockClear();
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

    it("Postgres timeout 57014 : tags + level warning + fingerprint stable pour grouper", () => {
      const err = new Error(
        "[france-data-mcp] ameli_by_specialite_dept (57014): canceling statement due to statement timeout",
      );
      captureMcpError(err, { ...ctx, tool: "professionnels_par_specialite_dept" });
      const scope = mockedScope();
      expect(scope.setTag).toHaveBeenCalledWith("mcp.postgres_code", "57014");
      expect(scope.setLevel).toHaveBeenCalledWith("warning");
      expect(scope.setFingerprint).toHaveBeenCalledWith([
        "mcp_postgres_timeout",
        "tools/call",
        "professionnels_par_specialite_dept",
      ]);
      expect(Sentry.captureException).toHaveBeenCalledWith(err);
    });

    it("Postgres timeout 57014 sans tool : fingerprint utilise 'unknown'", () => {
      const err = new Error("rpc_xxx (57014): canceling statement");
      captureMcpError(err, { ...ctx, tool: undefined });
      const scope = mockedScope();
      expect(scope.setFingerprint).toHaveBeenCalledWith([
        "mcp_postgres_timeout",
        "tools/call",
        "unknown",
      ]);
    });

    it("erreur classique non-timeout : pas de tag postgres_code, pas de fingerprint", () => {
      captureMcpError(new Error("TypeError: Cannot read property 'x' of null"), ctx);
      const scope = mockedScope();
      const pgCalls = scope.setTag.mock.calls.filter(
        (c: unknown[]) => c[0] === "mcp.postgres_code",
      );
      expect(pgCalls).toHaveLength(0);
      expect(scope.setFingerprint).not.toHaveBeenCalled();
      expect(scope.setLevel).not.toHaveBeenCalled();
    });

    it("err null/undefined ne crash pas et ne match pas le pattern timeout", () => {
      expect(() => captureMcpError(null, ctx)).not.toThrow();
      expect(() => captureMcpError(undefined, ctx)).not.toThrow();
      const scope = mockedScope();
      expect(scope.setFingerprint).not.toHaveBeenCalled();
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

describe("captureMcpConfigWarning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    __resetSentryForTesting();
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(Sentry.withScope).mockClear();
    mockedScope().setTag.mockClear();
    mockedScope().setLevel.mockClear();
    mockedScope().setFingerprint.mockClear();
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("VERCEL_ENV", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sans DSN : no-op, n'appelle pas Sentry.captureMessage", () => {
    captureMcpConfigWarning("missing_ip_salt", "salt absent");
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    void errorSpy;
  });

  it("avec DSN : tag mcp.config_warning + fingerprint stable + captureMessage warning", () => {
    vi.stubEnv("SENTRY_DSN", "https://k@sentry.io/1");
    captureMcpConfigWarning("missing_ip_salt", "salt absent en prod");

    const scope = mockedScope();
    expect(scope.setTag).toHaveBeenCalledWith("mcp.config_warning", "missing_ip_salt");
    expect(scope.setFingerprint).toHaveBeenCalledWith(["mcp_config_warning", "missing_ip_salt"]);
    // Level passé via le 2e arg captureMessage (pas via scope.setLevel — doublon évité)
    expect(Sentry.captureMessage).toHaveBeenCalledWith("salt absent en prod", "warning");
  });

  it("Sentry.captureMessage qui throw → catch + console.error, ne propage pas", () => {
    vi.stubEnv("SENTRY_DSN", "https://k@sentry.io/1");
    vi.mocked(Sentry.captureMessage).mockImplementationOnce(() => {
      throw new Error("network down");
    });

    expect(() => captureMcpConfigWarning("missing_axiom_config", "axiom absent")).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Sentry captureMessage failed"),
    );
    void warnSpy;
  });

  it("init failed (DSN malformé) : pas de captureMessage", () => {
    vi.stubEnv("SENTRY_DSN", "https://k@sentry.io/1");
    vi.mocked(Sentry.init).mockImplementationOnce(() => {
      throw new Error("dsn malformé");
    });

    captureMcpConfigWarning("missing_ip_salt", "x");
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});

describe("beforeSendEvent (FRANCE-DATA-MCP-1 bot noise filter)", () => {
  function makeEvent(opts: {
    method?: string;
    exMessage?: string;
    headers?: Record<string, string>;
  }): Sentry.ErrorEvent {
    const tags: Record<string, string> = {};
    if (opts.method) tags["mcp.method"] = opts.method;
    // `type: undefined` est la signature `ErrorEvent` (vs `TransactionEvent`).
    const event: Sentry.ErrorEvent = { tags, type: undefined };
    if (opts.exMessage !== undefined) {
      event.exception = { values: [{ type: "TypeError", value: opts.exMessage }] };
    }
    if (opts.headers) {
      event.request = { headers: opts.headers };
    }
    return event;
  }

  describe("isBotNoiseEvent", () => {
    it("drop si handler_root + 'Cannot read prop'", () => {
      expect(
        isBotNoiseEvent(
          makeEvent({
            method: "handler_root",
            exMessage: "Cannot read properties of undefined (reading 'method')",
          }),
        ),
      ).toBe(true);
    });

    it("drop si handler_root + 'is not iterable'", () => {
      expect(
        isBotNoiseEvent(makeEvent({ method: "handler_root", exMessage: "x is not iterable" })),
      ).toBe(true);
    });

    it("drop si handler_root + 'Unexpected token'", () => {
      expect(
        isBotNoiseEvent(
          makeEvent({ method: "handler_root", exMessage: "Unexpected token { in JSON" }),
        ),
      ).toBe(true);
    });

    it("drop si handler_root + 'Cannot destructure'", () => {
      expect(
        isBotNoiseEvent(
          makeEvent({
            method: "handler_root",
            exMessage: "Cannot destructure property 'method' of 'request' as it is undefined",
          }),
        ),
      ).toBe(true);
    });

    it("drop si handler_root + 'Cannot convert undefined or null'", () => {
      expect(
        isBotNoiseEvent(
          makeEvent({
            method: "handler_root",
            exMessage: "Cannot convert undefined or null to object",
          }),
        ),
      ).toBe(true);
    });

    it("drop si handler_root + 'is not a function'", () => {
      expect(
        isBotNoiseEvent(
          makeEvent({
            method: "handler_root",
            exMessage: "body.method.toLowerCase is not a function",
          }),
        ),
      ).toBe(true);
    });

    it("garde si handler_root mais message non-noise (genuine bug invariant V0.7.2)", () => {
      expect(
        isBotNoiseEvent(
          makeEvent({
            method: "handler_root",
            exMessage: "extractIp: unexpected header shape",
          }),
        ),
      ).toBe(false);
    });

    it("garde si pattern noise mais mcp.method ≠ handler_root", () => {
      expect(
        isBotNoiseEvent(
          makeEvent({
            method: "tools/call",
            exMessage: "Cannot read properties of undefined",
          }),
        ),
      ).toBe(false);
    });

    it("garde si event sans exception (rien à matcher)", () => {
      expect(isBotNoiseEvent(makeEvent({ method: "handler_root" }))).toBe(false);
    });
  });

  describe("beforeSendEvent pipeline", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("retourne null sur bot noise (drop)", () => {
      const event = makeEvent({
        method: "handler_root",
        exMessage: "Cannot read properties of null",
      });
      expect(beforeSendEvent(event)).toBeNull();
    });

    it("logge un console.warn distinctif lors du drop (observabilité Vercel)", () => {
      const event = makeEvent({
        method: "handler_root",
        exMessage: "Cannot read properties of undefined",
      });
      beforeSendEvent(event);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropping bot-noise event"));
    });

    it("retourne l'event sanitizé sur genuine error", () => {
      const event = makeEvent({
        method: "tools/call",
        exMessage: "tool exploded",
        headers: { authorization: "Bearer x", "x-api-key": "secret", "user-agent": "Claude/1.0" },
      });
      const out = beforeSendEvent(event);
      expect(out).not.toBeNull();
      const headers = (out as Sentry.ErrorEvent).request?.headers as
        | Record<string, string>
        | undefined;
      expect(headers?.authorization).toBeUndefined();
      expect(headers?.["x-api-key"]).toBeUndefined();
      expect(headers?.["user-agent"]).toBe("Claude/1.0");
    });

    it("drop tous les headers sensibles connus (proxy/csrf/cloud auth)", () => {
      // Couverture OWASP secret-headers + infra fréquentes (Vercel, AWS).
      const event = makeEvent({
        method: "tools/call",
        exMessage: "tool exploded",
        headers: {
          authorization: "Bearer x",
          "proxy-authorization": "Basic y",
          cookie: "sid=z",
          "set-cookie": "sid=z; HttpOnly",
          "x-api-key": "secret",
          "x-csrf-token": "csrf",
          "x-xsrf-token": "xsrf",
          "x-amz-security-token": "AQoDY...",
          "x-vercel-protection-bypass": "preview-token",
          "user-agent": "Claude/1.0",
          // Casing-insensitive : drop quand même.
          "X-API-KEY": "second",
        },
      });
      const out = beforeSendEvent(event);
      const headers = (out as Sentry.ErrorEvent).request?.headers as
        | Record<string, string>
        | undefined;
      for (const sensitive of [
        "authorization",
        "proxy-authorization",
        "cookie",
        "set-cookie",
        "x-api-key",
        "x-csrf-token",
        "x-xsrf-token",
        "x-amz-security-token",
        "x-vercel-protection-bypass",
        "X-API-KEY",
      ]) {
        expect(headers?.[sensitive]).toBeUndefined();
      }
      expect(headers?.["user-agent"]).toBe("Claude/1.0");
    });

    it("ne mute pas l'event d'entrée (immutabilité, clone)", () => {
      const event = makeEvent({
        method: "tools/call",
        exMessage: "tool exploded",
        headers: { authorization: "Bearer secret", "user-agent": "Claude/1.0" },
      });
      beforeSendEvent(event);
      // L'event d'origine doit toujours avoir authorization (pas muté).
      expect((event.request?.headers as Record<string, string> | undefined)?.authorization).toBe(
        "Bearer secret",
      );
    });

    it("ne crash pas si event sans request", () => {
      const event = makeEvent({ method: "tools/call", exMessage: "boom" });
      expect(() => beforeSendEvent(event)).not.toThrow();
    });
  });
});
