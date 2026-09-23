import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DeepSeekWebAdapter,
  DEEPSEEK_WEB_ORIGIN,
  DEEPSEEK_WEB_ENDPOINTS,
  AdapterRequestError,
  parseStreamFrames,
} from "../deepseek";
import { ERROR_MAPPING } from "../adapter";
import { FIXTURES, buildOversizedDiscoveryPayload } from "../__fixtures__/deepseek-fixtures";
import { env } from "@/env";
import { queryLogs, clearLogs } from "@/lib/observability/log-store";

const SESSION_PATH = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.session}`;
const MODELS_PATH = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.models}`;
const CHAT_PATH = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.chat}`;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The headers a real fetch would send for a given call, lower-cased. */
function requestHeaders(call: [unknown, RequestInit?]): Record<string, string> {
  const raw = (call[1]?.headers ?? {}) as Record<string, string>;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
}

describe("DeepSeekWebAdapter", () => {
  let adapter: DeepSeekWebAdapter;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    adapter = new DeepSeekWebAdapter();
    fetchSpy = vi.spyOn(globalThis, "fetch");
    clearLogs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fixed upstream policy (Spec §7.1)", () => {
    it("dispatches only to the fixed HTTPS origin and session path", async () => {
      fetchSpy.mockResolvedValue(jsonResponse(FIXTURES.sessionSuccess));

      const result = await adapter.validateSession({ userToken: "test-token", userAgentMode: "server-default" });

      expect(result.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(SESSION_PATH);
      expect(url).toMatch(/^https:\/\//);
      expect(init?.method).toBe("GET");
    });

    it("always sets redirect: 'error' on every request", async () => {
      fetchSpy.mockResolvedValue(jsonResponse(FIXTURES.modelDiscoverySuccess));
      await adapter.discoverModels({ userToken: "t" });
      expect(fetchSpy.mock.calls[0][1]?.redirect).toBe("error");
    });

    it("surfaces a rejected redirect as a classified failure through the thrown-error path", async () => {
      // Under redirect: "error" a 3xx never becomes a Response — fetch rejects
      // with a TypeError whose cause is "unexpected redirect" (Spec §7.1).
      const redirectFailure = new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
      fetchSpy.mockRejectedValue(redirectFailure);

      const result = await adapter.validateSession({ userToken: "test-token", userAgentMode: "server-default" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("network_error");
        expect(result.httpStatus).toBe(ERROR_MAPPING.network_error.status);
      }
      // The redirect was never followed.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("never forwards incoming cookies and never returns upstream Set-Cookie", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify(FIXTURES.sessionSuccess), {
          status: 200,
          headers: { "content-type": "application/json", "set-cookie": "session=upstream-secret; HttpOnly" },
        })
      );

      const result = await adapter.validateSession({ userToken: "test-token" });

      const headers = requestHeaders(fetchSpy.mock.calls[0] as [unknown, RequestInit?]);
      expect(headers).not.toHaveProperty("cookie");
      expect(headers).not.toHaveProperty("set-cookie");
      expect(Object.keys(headers).sort()).toEqual(["accept", "authorization", "user-agent"]);
      // No upstream header material leaks through the adapter's return value.
      expect(JSON.stringify(result)).not.toContain("upstream-secret");
      expect(result).not.toHaveProperty("headers");
    });
  });

  describe("User-Agent precedence (Spec §5.2)", () => {
    it("applies saved custom, then saved browser-captured, then the server default", async () => {
      fetchSpy.mockResolvedValue(jsonResponse(FIXTURES.sessionSuccess));

      await adapter.validateSession({ userToken: "t", userAgentMode: "custom", selectedUserAgent: "CustomUA/1.0" });
      expect(requestHeaders(fetchSpy.mock.calls[0] as [unknown, RequestInit?])["user-agent"]).toBe("CustomUA/1.0");

      await adapter.validateSession({ userToken: "t", userAgentMode: "browser", selectedUserAgent: "BrowserUA/2.0" });
      expect(requestHeaders(fetchSpy.mock.calls[1] as [unknown, RequestInit?])["user-agent"]).toBe("BrowserUA/2.0");

      await adapter.validateSession({ userToken: "t", userAgentMode: "server-default" });
      const fallback = requestHeaders(fetchSpy.mock.calls[2] as [unknown, RequestInit?])["user-agent"];
      expect(fallback).toMatch(/Yggdrasil/);
    });

    it("falls back to the server default when a captured value is absent", async () => {
      fetchSpy.mockResolvedValue(jsonResponse(FIXTURES.sessionSuccess));

      await adapter.validateSession({ userToken: "t", userAgentMode: "browser" });
      await adapter.validateSession({ userToken: "t", userAgentMode: "custom" });

      for (const call of fetchSpy.mock.calls) {
        expect(requestHeaders(call as [unknown, RequestInit?])["user-agent"]).toMatch(/Yggdrasil/);
      }
    });
  });

  describe("failure classification (Spec §6.3, §7.3)", () => {
    it("classifies 401 and 403 as session_rejected without retrying", async () => {
      fetchSpy.mockResolvedValue(jsonResponse(FIXTURES.sessionRejected, 401));
      const unauthorized = await adapter.validateSession({ userToken: "expired-token" });
      expect(unauthorized.ok).toBe(false);
      if (!unauthorized.ok) {
        expect(unauthorized.code).toBe("session_rejected");
        expect(unauthorized.httpStatus).toBe(401);
        expect(unauthorized.message).toBe(ERROR_MAPPING.session_rejected.message);
      }

      fetchSpy.mockResolvedValue(jsonResponse(FIXTURES.sessionRejected, 403));
      const forbidden = await adapter.validateSession({ userToken: "expired-token" });
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("session_rejected");

      // No authentication retry after a rejection (Spec §7.2).
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("classifies 429 as rate_limited and exposes Retry-After as bounded safe metadata", async () => {
      fetchSpy.mockResolvedValue(
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

      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify(FIXTURES.rateLimited), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "99999" },
        })
      );
      const clamped = await adapter.validateSession({ userToken: "t" });
      expect(clamped.ok).toBe(false);
      if (!clamped.ok) expect(clamped.retryAfterSeconds).toBe(env.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_MAX_SECONDS);

      // Absent or non-numeric Retry-After is not invented.
      fetchSpy.mockResolvedValue(jsonResponse(FIXTURES.rateLimited, 429));
      const absent = await adapter.validateSession({ userToken: "t" });
      expect(absent.ok).toBe(false);
      if (!absent.ok) expect(absent.retryAfterSeconds).toBeUndefined();
    });

    it("classifies a 5xx as protocol_error and an abort as upstream_timeout", async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 502));
      const serverError = await adapter.validateSession({ userToken: "t" });
      expect(serverError.ok).toBe(false);
      if (!serverError.ok) expect(serverError.code).toBe("protocol_error");

      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      fetchSpy.mockRejectedValue(abortError);
      const timedOut = await adapter.validateSession({ userToken: "t" });
      expect(timedOut.ok).toBe(false);
      if (!timedOut.ok) {
        expect(timedOut.code).toBe("upstream_timeout");
        expect(timedOut.httpStatus).toBe(504);
      }
    });

    it("treats an HTML login page as a session error, not a successful empty catalog", async () => {
      fetchSpy.mockResolvedValue(
        new Response(FIXTURES.loginPageHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
      );

      const checked = await adapter.validateSession({ userToken: "t" });
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.code).toBe("session_rejected");

      const discovered = await adapter.discoverModels({ userToken: "t" });
      expect(discovered.ok).toBe(false);
      if (!discovered.ok) expect(discovered.code).toBe("session_rejected");
    });

    it("rejects an over-cap response without reading it", async () => {
      fetchSpy.mockResolvedValue(
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_RESPONSE_BYTES + 1),
          },
        })
      );

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("protocol_error");
    });

    it("honours caller cancellation", async () => {
      const controller = new AbortController();
      controller.abort();
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      fetchSpy.mockRejectedValue(abortError);

      const result = await adapter.validateSession({ userToken: "t" }, controller.signal);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("upstream_timeout");
    });

    it("never logs the token, Authorization header, or raw upstream body (Spec §12)", async () => {
      const secret = "sk-live-secret-token-value";
      fetchSpy.mockResolvedValue(
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
    });

    it("never echoes raw upstream text in any classified message", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ error: "leaked-internal-detail" }), { status: 401 })
      );
      const result = await adapter.validateSession({ userToken: "t" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).not.toContain("leaked-internal-detail");
        expect(result.message).toBe(ERROR_MAPPING[result.code].message);
      }
    });
  });

  describe("discoverModels normalization (Spec §8.3)", () => {
    it("dispatches to the fixed models path and normalizes a successful payload", async () => {
      fetchSpy.mockResolvedValue(jsonResponse(FIXTURES.modelDiscoverySuccess));

      const result = await adapter.discoverModels({
        userToken: "valid-token",
        userAgentMode: "browser",
        selectedUserAgent: "Mozilla/5.0 Test",
      });

      expect(fetchSpy.mock.calls[0][0]).toBe(MODELS_PATH);
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

    it("drops blank, non-string, and non-object ids deterministically", async () => {
      fetchSpy.mockResolvedValue(jsonResponse(FIXTURES.modelDiscoveryWithInvalidRecords));

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.models.map((m) => m.modelId)).toEqual(["kept-model", "trimmed-model"]);
    });

    it("never sets isDefault even when the upstream record claims it", async () => {
      fetchSpy.mockResolvedValue(jsonResponse(FIXTURES.modelDiscoveryWithDefaultClaim));

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.models.every((m) => m.isDefault === false)).toBe(true);
    });

    it("caps the model list at the configured maximum", async () => {
      fetchSpy.mockResolvedValue(jsonResponse(FIXTURES.oversizedModelCatalog));

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.models).toHaveLength(env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_MODELS);
        expect(result.models[0].modelId).toBe("model-0");
      }
    });

    it("returns a successful empty catalog, distinguishable from a failure", async () => {
      fetchSpy.mockResolvedValue(jsonResponse(FIXTURES.modelDiscoveryEmpty));

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.models).toEqual([]);
    });

    it("classifies a malformed discovery payload as protocol_error", async () => {
      fetchSpy.mockResolvedValue(
        new Response(FIXTURES.modelDiscoveryMalformed, {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("protocol_error");
    });

    it("rejects an oversized discovery payload body", async () => {
      fetchSpy.mockResolvedValue(
        new Response(buildOversizedDiscoveryPayload(), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );

      const result = await adapter.discoverModels({ userToken: "t" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("protocol_error");
    });
  });

  describe("createTextStream (Spec §7.2, §8.5)", () => {
    function sseResponse(frames: string[]): Response {
      const body = frames.map((f) => `data: ${f}\n\n`).join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }

    it("dispatches to the fixed chat path with the caller signal and redirect: error", async () => {
      fetchSpy.mockResolvedValue(sseResponse(['{"text":"hi"}', "[DONE]"]));
      const controller = new AbortController();

      const stream = await adapter.createTextStream(
        { userToken: "t", userAgentMode: "server-default" },
        { prompt: "hello", messages: [{ role: "user", content: "hello" }] },
        controller.signal
      );

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(CHAT_PATH);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      expect(stream).toBeInstanceOf(ReadableStream);
      // The caller's abort must reach the upstream request.
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
    });

    it("rejects with a typed failure carrying the closed code and no raw upstream text", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ error: "leaked-upstream-detail" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      );

      await expect(
        adapter.createTextStream({ userToken: "t" }, { prompt: "x", messages: [] })
      ).rejects.toBeInstanceOf(AdapterRequestError);

      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ error: "leaked-upstream-detail" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      );
      try {
        await adapter.createTextStream({ userToken: "t" }, { prompt: "x", messages: [] });
        throw new Error("expected createTextStream to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterRequestError);
        const failure = (error as AdapterRequestError).failure;
        expect(failure.code).toBe("session_rejected");
        expect(failure.message).not.toContain("leaked-upstream-detail");
        expect(failure.message).toBe(ERROR_MAPPING.session_rejected.message);
      }
    });

    it("propagates a 429 with bounded Retry-After metadata", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify(FIXTURES.rateLimited), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "99999" },
        })
      );

      try {
        await adapter.createTextStream({ userToken: "t" }, { prompt: "x", messages: [] });
        throw new Error("expected createTextStream to reject");
      } catch (error) {
        expect((error as AdapterRequestError).failure.code).toBe("rate_limited");
        expect((error as AdapterRequestError).failure.retryAfterSeconds).toBe(
          env.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_MAX_SECONDS
        );
      }
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

    it("processes a final frame that arrives without its terminating blank line", async () => {
      const frames: string[] = [];
      for await (const frame of parseStreamFrames(frameStream(['data: {"a":1}\n\n', 'data: {"b":2}']))) {
        frames.push(frame);
      }
      expect(frames).toEqual(['{"a":1}', '{"b":2}']);
    });

    it("ignores SSE comments and heartbeats that carry no data payload", async () => {
      const frames: string[] = [];
      for await (const frame of parseStreamFrames(
        frameStream([": keep-alive\n\n", 'data: {"a":1}\n\n', "data: [DONE]\n\n"])
      )) {
        frames.push(frame);
      }
      expect(frames).toEqual(['{"a":1}']);
    });

    it("parses CRLF-delimited frames, which are valid SSE", async () => {
      const frames: string[] = [];
      for await (const frame of parseStreamFrames(
        frameStream(['data: {"a":1}\r\n\r\n', 'data: {"b":2}\r\n\r\n', "data: [DONE]\r\n\r\n"])
      )) {
        frames.push(frame);
      }
      expect(frames).toEqual(['{"a":1}', '{"b":2}']);
    });

    it("does not fabricate a frame boundary when CRLF is split across chunks", async () => {
      const frames: string[] = [];
      for await (const frame of parseStreamFrames(
        frameStream(['data: {"a":1}\r', '\n\r\ndata: {"b":2}\r\n\r\n', "data: [DONE]\r\n\r\n"])
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

    it("terminates with a typed protocol error when a frame exceeds the byte cap", async () => {
      const oversizedFrame = `data: {"text":"${"a".repeat(env.YGGDRASIL_WEB_PROVIDER_STREAM_FRAME_MAX_BYTES)}"}\n\n`;

      const consume = async () => {
        for await (const payload of parseStreamFrames(frameStream([oversizedFrame]))) {
          expect(typeof payload).toBe("string");
        }
      };

      const outcome = await consume().catch((error) => error);
      expect(outcome).toBeInstanceOf(AdapterRequestError);
      expect((outcome as AdapterRequestError).failure.code).toBe("protocol_error");
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

    it("cancels the source reader when the caller aborts", async () => {
      const controller = new AbortController();
      let sourceCancelled = false;
      const silent = new ReadableStream<Uint8Array>({
        start() {},
        cancel() {
          sourceCancelled = true;
        },
      });

      const consume = async () => {
        for await (const payload of parseStreamFrames(silent, { idleTimeoutMs: 5_000 }, controller.signal)) {
          expect(typeof payload).toBe("string");
        }
      };

      const pending = consume().catch((error) => error);
      controller.abort();
      const outcome = await pending;

      expect(sourceCancelled).toBe(true);
      expect(outcome).toBeInstanceOf(AdapterRequestError);
      expect((outcome as AdapterRequestError).failure.code).toBe("upstream_timeout");
    });
  });
});
