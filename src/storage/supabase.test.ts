import { beforeEach, describe, expect, it, vi } from "vitest";

describe("getAnonClient", () => {
  beforeEach(() => {
    vi.resetModules();
    // biome-ignore lint/performance/noDelete: env vars must be removed (assigning undefined coerces to "undefined" string).
    delete process.env.SUPABASE_URL;
    // biome-ignore lint/performance/noDelete: env vars must be removed (assigning undefined coerces to "undefined" string).
    delete process.env.SUPABASE_ANON_KEY;
  });

  it("throws a clear error when SUPABASE_URL is missing", async () => {
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const mod = await import("./supabase");
    expect(() => mod.getAnonClient()).toThrow(/SUPABASE_URL/);
  });

  it("throws a clear error when SUPABASE_ANON_KEY is missing", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    const mod = await import("./supabase");
    expect(() => mod.getAnonClient()).toThrow(/SUPABASE_ANON_KEY/);
  });

  it("returns a SupabaseClient when both env vars are present", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const mod = await import("./supabase");
    const client = mod.getAnonClient();
    expect(client).toBeDefined();
    expect(typeof client.from).toBe("function");
  });

  it("memoizes the client (returns same instance on second call)", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key";
    const mod = await import("./supabase");
    expect(mod.getAnonClient()).toBe(mod.getAnonClient());
  });
});

describe("getServiceClient", () => {
  beforeEach(() => {
    vi.resetModules();
    // biome-ignore lint/performance/noDelete: env vars must be removed (assigning undefined coerces to "undefined" string).
    delete process.env.SUPABASE_URL;
    // biome-ignore lint/performance/noDelete: env vars must be removed (assigning undefined coerces to "undefined" string).
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("throws a clear error when SUPABASE_SERVICE_ROLE_KEY is missing", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    const mod = await import("./supabase");
    expect(() => mod.getServiceClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("returns a SupabaseClient when env vars are present", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    const mod = await import("./supabase");
    const client = mod.getServiceClient();
    expect(client).toBeDefined();
    expect(typeof client.from).toBe("function");
  });
});
