import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkWebProviderSession,
  saveWebProviderSession,
  deleteWebProviderSession,
  discoverWebProviderModels,
  revalidateWebProviderSession,
} from "@/lib/settings";

const PROVIDER_ID = "deepseek-web";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Last fetch call as [url, init]; fails loudly when the helper never fetched. */
function lastFetchCall(): [string, RequestInit] {
  const calls = vi.mocked(global.fetch).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1] as unknown as [string, RequestInit];
}

describe("web provider settings helpers", () => {
  let storageSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    vi.restoreAllMocks();
    // Spec §4.3: the token is write-only to the check/save routes. No helper may
    // read or write browser storage, so every Storage accessor is watched.
    storageSpies = [
      vi.spyOn(Storage.prototype, "getItem"),
      vi.spyOn(Storage.prototype, "setItem"),
      vi.spyOn(Storage.prototype, "removeItem"),
      vi.spyOn(Storage.prototype, "clear"),
    ];
  });

  afterEach(() => {
    expect(storageSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  describe("checkWebProviderSession", () => {
    it("posts only the declared candidate fields to the check route", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({ ok: true, provider: PROVIDER_ID, status: "verified" })
      );

      const res = await checkWebProviderSession({
        providerId: PROVIDER_ID,
        userToken: "sk-token",
        userAgentMode: "browser",
        userAgent: "Mozilla/5.0",
      });

      expect(res).toEqual({ ok: true });
      const [url, init] = lastFetchCall();
      expect(url).toBe("/api/web-providers/deepseek/session/check");
      expect(init.method).toBe("POST");
      // The route's schema is strict: providerId must not ride along in the body.
      expect(JSON.parse(init.body as string)).toEqual({
        userToken: "sk-token",
        userAgentMode: "browser",
        userAgent: "Mozilla/5.0",
      });
    });

    it("omits userAgent when the mode does not carry one", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }));

      await checkWebProviderSession({
        providerId: PROVIDER_ID,
        userToken: "sk-token",
        userAgentMode: "server-default",
      });

      expect(JSON.parse(lastFetchCall()[1].body as string)).toEqual({
        userToken: "sk-token",
        userAgentMode: "server-default",
      });
    });

    it("surfaces the server's safe code and message on a non-OK response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse(
          { ok: false, code: "session_rejected", message: "The session was rejected." },
          401
        )
      );

      const res = await checkWebProviderSession({
        providerId: PROVIDER_ID,
        userToken: "bad",
        userAgentMode: "browser",
      });

      expect(res).toEqual({
        ok: false,
        code: "session_rejected",
        message: "The session was rejected.",
      });
    });

    it("falls back to an ok:false result when the error body is not JSON", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("<html>gateway</html>", { status: 502 })
      );

      const res = await checkWebProviderSession({
        providerId: PROVIDER_ID,
        userToken: "bad",
        userAgentMode: "browser",
      });

      expect(res).toEqual({ ok: false, code: undefined, message: undefined });
    });
  });

  describe("saveWebProviderSession", () => {
    it("posts the candidate to the session route and returns lastCheckedAt", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          ok: true,
          provider: PROVIDER_ID,
          status: "verified",
          lastCheckedAt: "2026-09-23T00:00:00.000Z",
        })
      );

      const res = await saveWebProviderSession({
        providerId: PROVIDER_ID,
        userToken: "sk-token",
        userAgentMode: "custom",
        userAgent: "Custom/1.0",
      });

      expect(res).toEqual({ ok: true, lastCheckedAt: "2026-09-23T00:00:00.000Z" });
      const [url, init] = lastFetchCall();
      expect(url).toBe("/api/web-providers/deepseek/session");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        userToken: "sk-token",
        userAgentMode: "custom",
        userAgent: "Custom/1.0",
      });
    });

    it("surfaces the server's safe code and message on a non-OK response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({ ok: false, code: "protocol_error", message: "Failed to store web provider session" }, 500)
      );

      const res = await saveWebProviderSession({
        providerId: PROVIDER_ID,
        userToken: "sk-token",
        userAgentMode: "browser",
      });

      expect(res).toEqual({
        ok: false,
        code: "protocol_error",
        message: "Failed to store web provider session",
      });
    });
  });

  describe("deleteWebProviderSession", () => {
    it("issues a DELETE to the session route with no body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({ ok: true, provider: PROVIDER_ID, status: "not-configured" })
      );

      await expect(deleteWebProviderSession(PROVIDER_ID)).resolves.toBeUndefined();

      const [url, init] = lastFetchCall();
      expect(url).toBe("/api/web-providers/deepseek/session");
      expect(init.method).toBe("DELETE");
      expect(init.body).toBeUndefined();
    });

    it("throws with the server's message and code on failure", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({ ok: false, code: "protocol_error", message: "Failed to delete web provider session" }, 500)
      );

      await expect(deleteWebProviderSession(PROVIDER_ID)).rejects.toThrow(
        "Failed to delete web provider session (protocol_error)"
      );
    });
  });

  describe("discoverWebProviderModels", () => {
    it("posts force:true and returns the normalized models and cache state", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({
          ok: true,
          provider: PROVIDER_ID,
          models: [{ modelId: "deepseek-chat" }],
          cache: "fresh",
        })
      );

      const res = await discoverWebProviderModels(PROVIDER_ID, true);

      expect(res).toEqual({
        ok: true,
        models: [{ modelId: "deepseek-chat" }],
        cache: "fresh",
      });
      const [url, init] = lastFetchCall();
      expect(url).toBe("/api/web-providers/deepseek/models/discover");
      expect(init.method).toBe("POST");
      // Discovery never carries the token; the server uses the stored session.
      expect(JSON.parse(init.body as string)).toEqual({ force: true });
    });

    it("defaults force to false and surfaces the server's safe error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({ ok: false, code: "session_rejected", message: "Session is not configured or verified" }, 401)
      );

      const res = await discoverWebProviderModels(PROVIDER_ID);

      expect(JSON.parse(lastFetchCall()[1].body as string)).toEqual({ force: false });
      expect(res).toEqual({
        ok: false,
        code: "session_rejected",
        message: "Session is not configured or verified",
      });
    });
  });

  describe("revalidateWebProviderSession", () => {
    it("posts to the revalidate route without a body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }));

      await expect(revalidateWebProviderSession(PROVIDER_ID)).resolves.toEqual({ ok: true });

      const [url, init] = lastFetchCall();
      expect(url).toBe("/api/web-providers/deepseek/session/revalidate");
      expect(init.method).toBe("POST");
      expect(init.body).toBeUndefined();
    });

    it("surfaces the server's safe code and message on a non-OK response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({ ok: false, code: "rate_limited", message: "Too many attempts." }, 429)
      );

      const res = await revalidateWebProviderSession(PROVIDER_ID);

      expect(res).toEqual({ ok: false, code: "rate_limited", message: "Too many attempts." });
    });
  });

  it("fails fast on an unsupported provider id instead of targeting DeepSeek routes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      checkWebProviderSession({ providerId: "other-web", userToken: "sk", userAgentMode: "browser" })
    ).rejects.toThrow("Unknown web provider: other-web");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
