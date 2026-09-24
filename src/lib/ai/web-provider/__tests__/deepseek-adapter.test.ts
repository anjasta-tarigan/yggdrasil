import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DeepSeekWebAdapter,
  DEEPSEEK_WEB_ORIGIN,
  DEEPSEEK_WEB_ENDPOINTS,
  AdapterRequestError,
  parseStreamFrames,
  toTranscript,
} from "../deepseek";
import { deepSeekHashV1, digestToHex, type PowChallenge } from "../pow";
import { ERROR_MAPPING } from "../adapter";
import { ModelEntrySchema } from "../../provider-config/schema";
import { FIXTURES, buildOversizedDiscoveryPayload } from "../__fixtures__/deepseek-fixtures";
import { env } from "@/env";
import { queryLogs, clearLogs } from "@/lib/observability/log-store";

const CURRENT_USER_PATH = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.currentUser}`;
const CLIENT_SETTINGS_PATH = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.clientSettings}`;
const CREATE_SESSION_PATH = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.createSession}`;
const CREATE_POW_PATH = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.createPowChallenge}`;
const COMPLETION_PATH = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.completion}`;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** The headers a real fetch would send for a given call, lower-cased. */
function requestHeaders(call: readonly unknown[]): Record<string, string> {
  const raw = (call[1] as RequestInit | undefined)?.headers ?? {};
  return Object.fromEntries(Object.entries(raw as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
}

/** Decoded `X-Ds-Pow-Response` header value. */
function decodePowHeader(header: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

/** Builds a self-consistent PoW challenge whose answer is `answer`. */
function solvableChallenge(answer: number, difficulty: number): PowChallenge {
  const salt = "fixture-salt";
  const expireAt = 1760000000000;
  const prefix = `${salt}_${expireAt}_`;
  const challenge = digestToHex(deepSeekHashV1(new TextEncoder().encode(`${prefix}${answer}`)));
  return {
    algorithm: "DeepSeekHashV1",
    challenge,
    salt,
    signature: "sig",
    difficulty,
    expire_at: expireAt,
    target_path: "/api/v0/chat/completion",
  };
}

function sseResponse(frames: string[], status = 200): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join("");
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

/**
 * Wires the gateway so `currentUser` always yields the session fixture (or the
 * supplied token response) and every operational endpoint yields the matching
 * fixture. Returns the spy so callers can inspect request headers/ordering.
 */
function mockLifecycle(options: {
  tokenResponse?: Response;
  sessionResponse?: Response;
  settingsResponse?: Response;
  powChallenge?: PowChallenge;
  completionResponse?: Response;
}): ReturnType<typeof vi.spyOn> {
  const tokenResponse = options.tokenResponse ?? jsonResponse(FIXTURES.sessionSuccess);
  const sessionResponse = options.sessionResponse ?? jsonResponse(FIXTURES.chatSessionCreate);
  const settingsResponse = options.settingsResponse ?? jsonResponse(FIXTURES.modelDiscoverySuccess);
  const powResponse = jsonResponse({
    code: 0,
    biz_data: options.powChallenge ?? solvableChallenge(0, 16),
  });
  const completionResponse = options.completionResponse ?? sseResponse(["data: [DONE]"]);

  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
    const endpoint = String(input);
    if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.currentUser)) return tokenResponse;
    if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.createSession)) return sessionResponse;
    if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.createPowChallenge)) return powResponse;
    if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.clientSettings)) return settingsResponse;
    return completionResponse;
  });
}

describe("DeepSeekWebAdapter", () => {
  let adapter: DeepSeekWebAdapter;

  beforeEach(() => {
    adapter = new DeepSeekWebAdapter();
    clearLogs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fixed upstream policy (Spec §7.1)", () => {
    it("dispatches /users/current to the fixed HTTPS origin with redirect: error", async () => {
      const fetchSpy = mockLifecycle({ tokenResponse: jsonResponse(FIXTURES.sessionSuccess) });

      const result = await adapter.validateSession({ userToken: "test-token", userAgentMode: "server-default" });

      expect(result.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(CURRENT_USER_PATH);
      expect(url).toMatch(/^https:\/\//);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
    });

    it("always sets redirect: 'error' on every request", async () => {
      const fetchSpy = mockLifecycle({ settingsResponse: jsonResponse(FIXTURES.modelDiscoverySuccess) });
      await adapter.discoverModels({ userToken: "t" });
      // currentUser + client/settings
      expect(fetchSpy.mock.calls).toHaveLength(2);
      expect(fetchSpy.mock.calls.every((call: readonly unknown[]) => (call[1] as RequestInit | undefined)?.redirect === "error")).toBe(true);
    });

    it("classifies a rejected redirect as unsupported_protocol, not network_error (Spec §7.1)", async () => {
      const redirectFailure = new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(redirectFailure);

      const result = await adapter.validateSession({ userToken: "test-token", userAgentMode: "server-default" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("unsupported_protocol");
        expect(result.code).not.toBe("network_error");
        expect(result.httpStatus).toBe(ERROR_MAPPING.unsupported_protocol.status);
        expect(result.message).toBe(ERROR_MAPPING.unsupported_protocol.message);
      }
      // A redirect is not retried: the redirect was never followed.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("never forwards incoming cookies and never returns upstream Set-Cookie", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify(FIXTURES.sessionSuccess), {
            status: 200,
            headers: { "content-type": "application/json", "set-cookie": "session=upstream-secret; HttpOnly" },
          })
        );

      const result = await adapter.validateSession({ userToken: "test-token" });

      const headers = requestHeaders(fetchSpy.mock.calls[0]);
      expect(headers).not.toHaveProperty("cookie");
      expect(headers).not.toHaveProperty("set-cookie");
      // No upstream header material leaks through the adapter's return value.
      expect(JSON.stringify(result)).not.toContain("upstream-secret");
      expect(result).not.toHaveProperty("headers");
    });

    it("never logs the token, Authorization header, or raw upstream body (Spec §12)", async () => {
      const secret = "sk-live-secret-token-value";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: "raw upstream body echo", token: secret }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      );

      await adapter.validateSession({ userToken: secret, userAgentMode: "custom", selectedUserAgent: "LeakyUA/9" });

      const logs = queryLogs({ limit: 200 });
      expect(logs.length).toBeGreaterThan(0);
      for (const entry of logs) {
        expect(entry.message).not.toContain(secret);
        expect(entry.message).not.toContain("raw upstream body echo");
        expect(entry.message).not.toContain("Bearer");
        expect(entry.message).not.toContain("LeakyUA/9");
      }
      void fetchSpy;
    });
  });

  describe("User-Agent precedence (Spec §5.2)", () => {
    it("applies saved custom, then saved browser-captured, then the server default", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(FIXTURES.sessionSuccess));
      // Distinct tokens force a fresh token exchange each time (caching is
      // keyed by userToken), so each call emits exactly one request.
      await adapter.validateSession({ userToken: "a", userAgentMode: "custom", selectedUserAgent: "CustomUA/1.0" });
      expect(requestHeaders(fetchSpy.mock.calls[0])["user-agent"]).toBe("CustomUA/1.0");

      await adapter.validateSession({ userToken: "b", userAgentMode: "browser", selectedUserAgent: "BrowserUA/2.0" });
      expect(requestHeaders(fetchSpy.mock.calls[1])["user-agent"]).toBe("BrowserUA/2.0");

      await adapter.validateSession({ userToken: "c", userAgentMode: "server-default" });
      const fallback = requestHeaders(fetchSpy.mock.calls[2])["user-agent"];
      expect(fallback).toMatch(/Yggdrasil/);
    });
  });

  describe("two-phase auth (Spec A2)", () => {
    it("exchanges the userToken for an access token and reports success only on code === 0 + token", async () => {
      const fetchSpy = mockLifecycle({ tokenResponse: jsonResponse(FIXTURES.sessionSuccess) });

      const result = await adapter.validateSession({ userToken: "test-token" });

      expect(result.ok).toBe(true);
      // The exchange used the browser token, not the operational access token.
      const headers = requestHeaders(fetchSpy.mock.calls[0]);
      expect(headers.authorization).toBe("Bearer test-token");
    });

    it("treats HTTP 200 with code !== 0 as session_rejected (the false-verified risk)", async () => {
      const fetchSpy = mockLifecycle({ tokenResponse: jsonResponse(FIXTURES.sessionRejected, 200) });

      const result = await adapter.validateSession({ userToken: "expired-token" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("session_rejected");
        expect(result.httpStatus).toBe(401);
      }
      void fetchSpy;
    });

    it("caches the access token so discovery reuses it without a second /users/current call", async () => {
      const fetchSpy = mockLifecycle({ settingsResponse: jsonResponse(FIXTURES.modelDiscoverySuccess) });

      await adapter.validateSession({ userToken: "t" });
      await adapter.discoverModels({ userToken: "t" });

      const currentUserCalls = fetchSpy.mock.calls.filter((c: readonly unknown[]) => String(c[0]).endsWith(DEEPSEEK_WEB_ENDPOINTS.currentUser));
      const settingsCalls = fetchSpy.mock.calls.filter((c: readonly unknown[]) => String(c[0]).endsWith(DEEPSEEK_WEB_ENDPOINTS.clientSettings));
      expect(currentUserCalls).toHaveLength(1);
      expect(settingsCalls).toHaveLength(1);
      // Discovery used the cached access token, not the raw userToken.
      expect(requestHeaders(settingsCalls[0]).authorization).not.toBe("Bearer t");
    });
  });

  describe("failure classification (Spec §6.3, §7.3)", () => {
    it("classifies 401 and 403 as session_rejected without retrying", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(FIXTURES.sessionRejected, 401));
      const unauthorized = await adapter.validateSession({ userToken: "expired-token" });
      expect(unauthorized.ok).toBe(false);
      if (!unauthorized.ok) {
        expect(unauthorized.code).toBe("session_rejected");
        expect(unauthorized.httpStatus).toBe(401);
        expect(unauthorized.message).toBe(ERROR_MAPPING.session_rejected.message);
      }

      fetchSpy.mockResolvedValueOnce(jsonResponse(FIXTURES.sessionRejected, 403));
      const forbidden = await adapter.validateSession({ userToken: "expired-token" });
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("session_rejected");

      // No authentication retry after a rejection (Spec §7.2). One call each.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("classifies 429 as rate_limited and exposes Retry-After as bounded safe metadata", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(FIXTURES.rateLimited), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "120" },
        })
      );
      const bounded = await adapter.validateSession({ userToken: "t" });
      expect(bounded.ok).toBe(false);
      if (!bounded.ok) {
        expect(bounded.code).toBe("rate_limited");
        expect(bounded.retryAfterSeconds).toBe(120);
      }

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(FIXTURES.rateLimited), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "99999" },
        })
      );
      const clamped = await adapter.validateSession({ userToken: "t" });
      expect(clamped.ok).toBe(false);
      if (!clamped.ok) expect(clamped.retryAfterSeconds).toBe(env.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_MAX_SECONDS);

      // Absent or non-numeric Retry-After is not invented.
      fetchSpy.mockResolvedValueOnce(jsonResponse(FIXTURES.rateLimited, 429));
      const absent = await adapter.validateSession({ userToken: "t" });
      expect(absent.ok).toBe(false);
      if (!absent.ok) expect(absent.retryAfterSeconds).toBeUndefined();
    });

    it("classifies a 5xx as protocol_error and an abort as upstream_timeout", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "boom" }, 502));
      const serverError = await adapter.validateSession({ userToken: "t" });
      expect(serverError.ok).toBe(false);
      if (!serverError.ok) expect(serverError.code).toBe("protocol_error");

      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      fetchSpy.mockRejectedValueOnce(abortError);
      const timedOut = await adapter.validateSession({ userToken: "t" });
      expect(timedOut.ok).toBe(false);
      if (!timedOut.ok) {
        expect(timedOut.code).toBe("upstream_timeout");
        expect(timedOut.httpStatus).toBe(504);
      }
    });

    it("treats an HTML login page as a session error, not a successful empty catalog", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(htmlResponse(FIXTURES.loginPageHtml));

      const checked = await adapter.validateSession({ userToken: "t" });
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.code).toBe("session_rejected");

      const discovered = await adapter.discoverModels({ userToken: "t" });
      expect(discovered.ok).toBe(false);
      if (!discovered.ok) expect(discovered.code).toBe("session_rejected");
      void fetchSpy;
    });

    it("never echoes raw upstream text in any classified message", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ error: "leaked-internal-detail" }), { status: 401 }));
      const result = await adapter.validateSession({ userToken: "t" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).not.toContain("leaked-internal-detail");
        expect(result.message).toBe(ERROR_MAPPING[result.code].message);
      }
      void fetchSpy;
    });
  });

  describe("retry policy (Spec §7.2)", () => {
    const networkFailure = () => new TypeError("fetch failed", { cause: new Error("ECONNRESET") });

    it("retries once on a network failure before any content is emitted", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(networkFailure())
        .mockResolvedValueOnce(jsonResponse(FIXTURES.sessionSuccess));

      const result = await adapter.validateSession({ userToken: "t" });

      expect(result.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("gives up after one retry and surfaces the closed network failure", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(networkFailure());

      const result = await adapter.validateSession({ userToken: "t" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("network_error");
        expect(result.httpStatus).toBe(ERROR_MAPPING.network_error.status);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("does not retry after a 401 or 403 rejection", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(FIXTURES.sessionRejected, 401));
      const unauthorized = await adapter.validateSession({ userToken: "t" });
      expect(unauthorized.ok).toBe(false);
      if (!unauthorized.ok) expect(unauthorized.code).toBe("session_rejected");

      fetchSpy.mockResolvedValueOnce(jsonResponse(FIXTURES.sessionRejected, 403));
      const forbidden = await adapter.validateSession({ userToken: "t" });
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("session_rejected");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("does not retry a rejected redirect", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new TypeError("fetch failed", { cause: new Error("unexpected redirect") }));

      const result = await adapter.validateSession({ userToken: "t" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("unsupported_protocol");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("discoverModels normalization (Spec §8.3, A6)", () => {
    it("dispatches to client/settings with the access token and normalizes a successful payload", async () => {
      const fetchSpy = mockLifecycle({ settingsResponse: jsonResponse(FIXTURES.modelDiscoverySuccess) });

      const result = await adapter.discoverModels({ userToken: "valid-token" });

      // call 0 = currentUser (token exchange), call 1 = client/settings.
      expect(fetchSpy.mock.calls[0][0]).toBe(CURRENT_USER_PATH);
      expect(fetchSpy.mock.calls[1][0]).toBe(CLIENT_SETTINGS_PATH);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Deterministic first-seen dedup keeps the first display name.
        expect(result.models.map((m) => m.modelId)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
        expect(result.models[0].displayName).toBe("DeepSeek Chat");
        expect(result.models[0].isDefault).toBe(false);
        expect(result.models[0].capabilities).toEqual({
          contextWindow: null,
          maxOutputTokens: null,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsToolCalls: null,
          supportsReasoning: null,
        });
        expect(result.models[0].capabilitySources).toEqual({
          inputModalities: "provider-metadata",
          outputModalities: "provider-metadata",
        });
      }
    });

    it("accepts the data.models envelope variant", async () => {
      const fetchSpy = mockLifecycle({ settingsResponse: jsonResponse(FIXTURES.modelDiscoveryDataModels) });

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.models.map((m) => m.modelId)).toEqual(["deepseek-chat"]);
      void fetchSpy;
    });

    it("drops blank, non-string, and non-object ids deterministically", async () => {
      const fetchSpy = mockLifecycle({ settingsResponse: jsonResponse(FIXTURES.modelDiscoveryWithInvalidRecords) });

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.models.map((m) => m.modelId)).toEqual(["kept-model", "trimmed-model"]);
      void fetchSpy;
    });

    it("never sets isDefault even when the upstream record claims it", async () => {
      const fetchSpy = mockLifecycle({ settingsResponse: jsonResponse(FIXTURES.modelDiscoveryWithDefaultClaim) });

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.models.every((m) => m.isDefault === false)).toBe(true);
      void fetchSpy;
    });

    it("caps modelId and displayName to the registry limit so candidates always validate", async () => {
      const overLongId = `model-${"i".repeat(400)}`;
      const overLongName = `n`.repeat(400);
      const fetchSpy = mockLifecycle({
        settingsResponse: jsonResponse({ code: 0, biz_data: [{ id: overLongId, name: overLongName }] }),
      });

      const result = await adapter.discoverModels({ userToken: "t" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.models).toHaveLength(1);
        expect(result.models[0].modelId).toHaveLength(200);
        expect(result.models[0].displayName).toHaveLength(200);
        expect(ModelEntrySchema.safeParse(result.models[0]).success).toBe(true);
      }
      void fetchSpy;
    });

    it("returns an empty auto-discovery catalog when no mappable models are present (Spec §8.2)", async () => {
      const fetchSpy = mockLifecycle({ settingsResponse: jsonResponse(FIXTURES.modelDiscoveryUnavailable) });

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.models).toEqual([]);
      void fetchSpy;
    });

    it("returns a successful empty catalog, distinguishable from a failure", async () => {
      const fetchSpy = mockLifecycle({ settingsResponse: jsonResponse(FIXTURES.modelDiscoveryEmpty) });

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.models).toEqual([]);
      void fetchSpy;
    });

    it("caps the model list at the configured maximum", async () => {
      const fetchSpy = mockLifecycle({ settingsResponse: jsonResponse(FIXTURES.oversizedModelCatalog) });

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.models).toHaveLength(env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_MODELS);
        expect(result.models[0].modelId).toBe("model-0");
      }
      void fetchSpy;
    });

    it("classifies a malformed discovery payload as protocol_error", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
        if (String(input).endsWith(DEEPSEEK_WEB_ENDPOINTS.currentUser)) {
          return jsonResponse(FIXTURES.sessionSuccess);
        }
        return new Response(FIXTURES.modelDiscoveryMalformed, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("protocol_error");
      void fetchSpy;
    });

    it("rejects an oversized discovery payload body", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
        if (String(input).endsWith(DEEPSEEK_WEB_ENDPOINTS.currentUser)) {
          return jsonResponse(FIXTURES.sessionSuccess);
        }
        return new Response(buildOversizedDiscoveryPayload(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("protocol_error");
      void fetchSpy;
    });
  });

  describe("createTextStream completion handshake (Spec A4)", () => {
    it("runs session → PoW → completion and attaches X-Ds-Pow-Response only on completion", async () => {
      const fetchSpy = mockLifecycle({ powChallenge: solvableChallenge(3, 64) });

      const stream = await adapter.createTextStream(
        { userToken: "t", userAgentMode: "server-default" },
        { messages: [{ role: "user", content: "hello" }], modelId: "deepseek-chat" },
        undefined
      );

      expect(stream).toBeInstanceOf(ReadableStream);
      const urls = fetchSpy.mock.calls.map((c: readonly unknown[]) => String(c[0]));
      expect(urls).toEqual([CURRENT_USER_PATH, CREATE_SESSION_PATH, CREATE_POW_PATH, COMPLETION_PATH]);

      // Completion carried the PoW proof; the upstream calls did not.
      const completionHeaders = requestHeaders(fetchSpy.mock.calls[3]);
      expect(completionHeaders["x-ds-pow-response"]).toBeDefined();
      const decoded = decodePowHeader(completionHeaders["x-ds-pow-response"] as string);
      expect(decoded.answer).toBe(3);
      expect(completionHeaders.authorization).toBe("Bearer redacted-access-token");
      expect(requestHeaders(fetchSpy.mock.calls[0])["x-ds-pow-response"]).toBeUndefined();
    });

    it("uses the access token for the operational calls, never the raw userToken", async () => {
      const fetchSpy = mockLifecycle({});

      await adapter.createTextStream(
        { userToken: "raw-user-token", userAgentMode: "server-default" },
        { messages: [], modelId: "deepseek-chat" },
        undefined
      );

      for (const call of fetchSpy.mock.calls.slice(1)) {
        expect(requestHeaders(call).authorization).toBe("Bearer redacted-access-token");
      }
    });

    it("maps the reasoner model to thinking_enabled and the right model_type", async () => {
      const fetchSpy = mockLifecycle({ powChallenge: solvableChallenge(1, 16) });

      await adapter.createTextStream(
        { userToken: "t", userAgentMode: "server-default" },
        { messages: [], modelId: "deepseek-reasoner" },
        undefined
      );

      const body = JSON.parse((fetchSpy.mock.calls[3][1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body.model_type).toBe("deepseek-reasoner");
      expect(body.thinking_enabled).toBe(true);
    });

    it("classifies an unsolved PoW challenge as unsupported_protocol, never a bypass", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
        const endpoint = String(input);
        if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.currentUser)) return jsonResponse(FIXTURES.sessionSuccess);
        if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.createSession)) return jsonResponse(FIXTURES.chatSessionCreate);
        if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.createPowChallenge)) {
          return jsonResponse({ code: 0, biz_data: solvableChallenge(900, 4) }); // answer out of range
        }
        return sseResponse(["data: [DONE]"]);
      });

      let caught: unknown;
      try {
        await adapter.createTextStream(
          { userToken: "t", userAgentMode: "server-default" },
          { messages: [], modelId: "deepseek-chat" },
          undefined
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AdapterRequestError);
      expect((caught as AdapterRequestError).failure.code).toBe("unsupported_protocol");
      expect((caught as AdapterRequestError).failure.message).toContain("PoW");
      void fetchSpy;
    });

    it("classifies a challenge/CAPTCHA page on PoW as unsupported_protocol", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
        const endpoint = String(input);
        if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.currentUser)) return jsonResponse(FIXTURES.sessionSuccess);
        if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.createSession)) return jsonResponse(FIXTURES.chatSessionCreate);
        if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.createPowChallenge)) {
          return htmlResponse(FIXTURES.loginPageHtml);
        }
        return sseResponse(["data: [DONE]"]);
      });

      let caught: unknown;
      try {
        await adapter.createTextStream(
          { userToken: "t", userAgentMode: "server-default" },
          { messages: [], modelId: "deepseek-chat" },
          undefined
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AdapterRequestError);
      expect((caught as AdapterRequestError).failure.code).toBe("unsupported_protocol");
      void fetchSpy;
    });

    it("rejects with a typed failure carrying the closed code and no raw upstream text", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
        const endpoint = String(input);
        if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.currentUser)) return jsonResponse(FIXTURES.sessionSuccess);
        if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.createSession)) return jsonResponse(FIXTURES.chatSessionCreate);
        if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.createPowChallenge)) {
          return new Response(JSON.stringify({ error: "leaked-upstream-detail" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return sseResponse(["data: [DONE]"]);
      });

      let caught: unknown;
      try {
        await adapter.createTextStream(
          { userToken: "t", userAgentMode: "server-default" },
          { messages: [], modelId: "deepseek-chat" },
          undefined
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AdapterRequestError);
      const failure = (caught as AdapterRequestError).failure;
      expect(failure.code).toBe("session_rejected");
      expect(failure.message).not.toContain("leaked-upstream-detail");
      expect(failure.message).toBe(ERROR_MAPPING.session_rejected.message);
      void fetchSpy;
    });
  });

  describe("toTranscript (Spec A4)", () => {
    it("flattens messages into a User/Assistant transcript", () => {
      const transcript = toTranscript([
        { role: "user", content: "What is 2+2?" },
        { role: "assistant", content: "4" },
        { role: "system", content: "Be terse." },
      ]);
      expect(transcript).toBe("User: What is 2+2?\n\nAssistant: 4\n\nSystem: Be terse.");
    });

    it("skips messages without content", () => {
      expect(toTranscript([{ role: "user" }, { role: "assistant", content: "hi" }])).toBe("Assistant: hi");
    });
  });

  describe("parseStreamFrames (Spec §7.2, §8.5)", () => {
    function frameStream(chunks: string[]): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
    }

    it("yields normalized frame payloads and stops at the terminator", async () => {
      const frames: string[] = [];
      for await (const frame of parseStreamFrames(
        frameStream(['data: {"a":1}\n\n', 'data: {"b":2}\n\n', "data: [DONE]\n\n"])
      )) {
        frames.push(frame);
      }
      expect(frames).toEqual(['{"a":1}', '{"b":2}']);
    });

    it("terminates with a typed protocol error on a malformed frame", async () => {
      const consume = async () => {
        for await (const payload of parseStreamFrames(frameStream(["data: { not-json\n\n"]))) {
          expect(typeof payload).toBe("string");
        }
      };

      const outcome = await consume().catch((error) => error);
      expect(outcome).toBeInstanceOf(AdapterRequestError);
      expect((outcome as AdapterRequestError).failure.code).toBe("protocol_error");
      expect((outcome as AdapterRequestError).failure.message).toBe(ERROR_MAPPING.protocol_error.message);
    });

    it("terminates with an upstream_timeout when the stream goes idle", async () => {
      const silent = new ReadableStream<Uint8Array>({ start() {} });

      const consume = async () => {
        for await (const payload of parseStreamFrames(silent, { idleTimeoutMs: 25 })) {
          expect(typeof payload).toBe("string");
        }
      };

      const outcome = await consume().catch((error) => error);
      expect(outcome).toBeInstanceOf(AdapterRequestError);
      expect((outcome as AdapterRequestError).failure.code).toBe("upstream_timeout");
    });
  });
});
