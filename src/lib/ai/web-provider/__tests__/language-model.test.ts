// @vitest-environment node
/**
 * Contract tests for the web-session language model. The frame payloads are
 * synthetic and intentionally unverified; the protocol spike must confirm the
 * provider grammar before enablement (Spec §13.1). These tests bind only the
 * adapter/model boundary: JSON patch frames become SDK v4 text/reasoning parts,
 * while malformed, unknown, and non-text inputs remain typed errors, unsupported
 * options are reported (never silently dropped), and completion metadata is
 * honest rather than fabricated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AdapterRequestError,
  DEEPSEEK_WEB_ENDPOINTS,
  DEEPSEEK_WEB_ORIGIN,
} from "../deepseek";
import { deepSeekHashV1, digestToHex, type PowChallenge } from "../pow";
import { FIXTURES } from "../__fixtures__/deepseek-fixtures";

// Spec §11.3: a stream-level protocol failure is one of the two sources that
// feed the circuit breaker. The breaker's thresholds are covered by
// `circuit-breaker.test.ts`; here we assert only that `doStream` records the
// failure code before it re-emits the error.
const recordProtocolFailureMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../circuit-breaker", () => ({
  recordProtocolFailure: recordProtocolFailureMock,
  resetProtocolFailures: vi.fn(),
}));
import {
  WebProviderGenerationUnavailableError,
  createWebProviderModel,
} from "../language-model";
import { clearLogs, queryLogs } from "@/lib/observability/log-store";
import type { ProviderEntry } from "@/lib/ai/provider-config/schema";
import type { WebProviderSession } from "../types";

const CURRENT_USER_PATH = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.currentUser}`;

/** Builds a self-consistent solvable challenge whose answer is `answer`. */
function solvableChallenge(answer: number, difficulty: number): PowChallenge {
  const salt = "test-salt";
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

/** Initial `v.response` frame declaring a single empty RESPONSE fragment. */
const RESPONSE_INIT_FRAME =
  '{"v":{"response":{"message_id":1,"thinking_enabled":false,"fragments":[{"id":1,"type":"RESPONSE","content":""}]}}}';

const webSessionEntry: ProviderEntry = {
  id: "deepseek-web",
  kind: "web-session",
  name: "DeepSeek Web",
  baseUrl: "https://chat.deepseek.com",
  models: [],
};

const verifiedSession: WebProviderSession = {
  id: "wps-1",
  providerId: "deepseek-web",
  userToken: "secret-session-token",
  status: "verified",
  lastCheckedAt: null,
  lastFailureCode: null,
  userAgentMode: "browser",
  capturedAt: null,
  sessionVersion: 1,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: string[], status = 200): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join("");
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

function model(session: WebProviderSession | null = verifiedSession) {
  return createWebProviderModel(webSessionEntry, "deepseek-chat", session);
}

type Part = Record<string, unknown>;

async function drain(stream: ReadableStream<Part>): Promise<Part[]> {
  const parts: Part[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return parts;
}

/** Reads the stream to completion, returning the thrown error if it errors. */
async function drainOutcome(stream: ReadableStream<Part>): Promise<unknown | undefined> {
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return undefined;
    }
  } catch (error) {
    return error;
  } finally {
    reader.releaseLock();
  }
}

describe("WebProviderLanguageModel", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearLogs();
    recordProtocolFailureMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Wires the four-step completion handshake so `doStream` reaches the SSE body:
   * currentUser (access token) → createSession → createPowChallenge (solvable) →
   * the provided completion response.
   */
  function mockHandshake(completionResponse: () => Response): void {
    const solved = solvableChallenge(0, 16);
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (url: unknown) => {
      const endpoint = String(url);
      if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.currentUser)) return jsonResponse(FIXTURES.sessionSuccess);
      if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.createSession)) return jsonResponse(FIXTURES.chatSessionCreate);
      if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.createPowChallenge)) {
        return jsonResponse({ code: 0, biz_data: solved });
      }
      return completionResponse();
    });
  }

  it("declares the v4 specification and empty supportedUrls", () => {
    const instance = model();

    expect(instance.specificationVersion).toBe("v4");
    expect(instance.provider).toBe("deepseek-web");
    expect(instance.modelId).toBe("deepseek-chat");
    expect(instance.supportedUrls).toEqual({});
    expect(instance.session).toBe(verifiedSession);
  });

  it("converts synthetic JSON patch deltas to AI SDK v4 parts", async () => {
    mockHandshake(() =>
      sseResponse([
        RESPONSE_INIT_FRAME,
        '{"p":"response/fragments/-1/content","o":"APPEND","v":"Hello"}',
        '{"p":"response/fragments/-1/content","o":"APPEND","v":" world"}',
        '{"p":"response/status","o":"SET","v":"FINISHED"}',
      ])
    );

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Part>;
    };
    const parts = await drain(result.stream);

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(parts.filter((part) => part.type === "text-delta")).toEqual([
      { type: "text-delta", id: "web-text-1", delta: "Hello" },
      { type: "text-delta", id: "web-text-1", delta: " world" },
    ]);
    expect(JSON.stringify(parts)).not.toContain(verifiedSession.userToken);
  });

  it("emits reasoning-delta for a THINK segment and text-delta after the RESPONSE switch", async () => {
    mockHandshake(() =>
      sseResponse([
        '{"v":{"response":{"message_id":2,"thinking_enabled":true,"fragments":[{"id":1,"type":"THINK","content":""}]}}}',
        '{"p":"response/fragments/-1/content","o":"APPEND","v":"Let me reason step by step. "}',
        '{"p":"response/fragments","o":"APPEND","v":{"id":3,"type":"RESPONSE","content":""}}',
        '{"p":"response/fragments/-1/content","o":"APPEND","v":"The answer is 42."}',
        '{"p":"response/status","o":"SET","v":"FINISHED"}',
      ])
    );

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Part>;
    };
    const parts = await drain(result.stream);

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "text-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(parts).toContainEqual({ type: "reasoning-delta", id: "web-reasoning-1", delta: "Let me reason step by step. " });
    expect(parts).toContainEqual({ type: "text-delta", id: "web-text-1", delta: "The answer is 42." });
  });

  it("reports honest unknown finish metadata instead of a false stop / zero usage", async () => {
    mockHandshake(() =>
      sseResponse([
        RESPONSE_INIT_FRAME,
        '{"p":"response/fragments/-1/content","o":"APPEND","v":"Done"}',
        '{"p":"response/status","o":"SET","v":"FINISHED"}',
      ])
    );

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Part>;
    };
    const parts = await drain(result.stream);

    const finish = parts.find((part) => part.type === "finish") as {
      finishReason: { unified: string; raw: string | undefined };
      usage: {
        inputTokens: Record<string, number | undefined>;
        outputTokens: Record<string, number | undefined>;
      };
    };
    // Not `stop` — DeepSeek Web's finish reason is unverified (Spec §13.1).
    expect(finish.finishReason.unified).toBe("other");
    expect(finish.finishReason.raw).toBe("web-provider:unverified");
    // Every token count is honestly unknown, not a fabricated 0.
    expect(Object.values(finish.usage.inputTokens).every((v) => v === undefined)).toBe(true);
    expect(Object.values(finish.usage.outputTokens).every((v) => v === undefined)).toBe(true);
  });

  it("strips unsupported options and reports them as warnings without failing", async () => {
    mockHandshake(() =>
      sseResponse([
        RESPONSE_INIT_FRAME,
        '{"p":"response/fragments/-1/content","o":"APPEND","v":"Hi"}',
        '{"p":"response/status","o":"SET","v":"FINISHED"}',
      ])
    );

    const result = (await model().doStream({
      prompt: [],
      // The chat route always passes these; the model must not hard-fail.
      tools: [{ type: "function", name: "t", inputSchema: { type: "object" } }],
      maxOutputTokens: 1024,
      responseFormat: { type: "text" },
      reasoning: "high",
      temperature: 0.7,
      providerOptions: { openai: { reasoningEffort: "high" } },
    })) as { stream: ReadableStream<Part> };

    const parts = await drain(result.stream);

    const start = parts.find((part) => part.type === "stream-start") as {
      warnings: Array<{ type: string; feature: string }>;
    };
    const features = start.warnings.map((w) => w.feature);
    expect(features).toEqual(
      expect.arrayContaining([
        "tools",
        "maxOutputTokens",
        "responseFormat",
        "reasoning",
        "temperature",
        "providerOptions",
      ])
    );
    expect(start.warnings.every((w) => w.type === "unsupported")).toBe(true);
    // The stream still completes with the provider's text.
    expect(parts).toContainEqual({ type: "text-delta", id: "web-text-1", delta: "Hi" });
    expect(parts.some((part) => part.type === "finish")).toBe(true);
  });

  it("does not warn for the route's empty toolset / providerOptions defaults", async () => {
    mockHandshake(() =>
      sseResponse([
        RESPONSE_INIT_FRAME,
        '{"p":"response/fragments/-1/content","o":"APPEND","v":"Hi"}',
        '{"p":"response/status","o":"SET","v":"FINISHED"}',
      ])
    );

    const result = (await model().doStream({
      prompt: [],
      tools: [],
      providerOptions: {},
    })) as { stream: ReadableStream<Part> };
    const parts = await drain(result.stream);

    const start = parts.find((part) => part.type === "stream-start") as {
      warnings: unknown[];
    };
    expect(start.warnings).toEqual([]);
  });

  it("rejects a non-text prompt part with a typed unsupported_protocol error", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch");

    const outcome = await model()
      .doStream({
        prompt: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "file", data: "AAAA", mediaType: "image/png" },
            ],
          },
        ],
      })
      .catch((error) => error);

    expect(outcome).toBeInstanceOf(AdapterRequestError);
    const failure = (outcome as AdapterRequestError).failure;
    expect(failure.code).toBe("unsupported_protocol");
    // The user must see WHICH part could not be served, not a generic refusal.
    expect(failure.message).toContain("file");
    // Rejected before any upstream request — nothing was sent.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flattens a tool call and its result into transcript text instead of rejecting the history", async () => {
    mockHandshake(() =>
      sseResponse([
        RESPONSE_INIT_FRAME,
        '{"p":"response/fragments/-1/content","o":"APPEND","v":"Done"}',
        '{"p":"response/status","o":"SET","v":"FINISHED"}',
      ])
    );

    const result = (await model().doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "search for X" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me search." },
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "web_search",
              input: { q: "X" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "web_search",
              output: { type: "json", value: { results: ["a", "b"] } },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "summarize" }] },
      ],
    })) as { stream: ReadableStream<Part> };
    const parts = await drain(result.stream);

    // Generation proceeded — no unsupported_protocol for a tool-using history.
    expect(parts.some((part) => part.type === "text-delta")).toBe(true);
    // The completion body is a single `prompt` transcript, not a message array.
    const completionBody = JSON.parse(
      (fetchSpy.mock.calls[3]?.[1] as RequestInit).body as string
    ) as { prompt: string };
    const transcript = JSON.stringify(completionBody.prompt);
    expect(transcript).toContain("[Tool invocation: web_search(");
    expect(transcript).toContain("[Tool result for web_search:");
  });

  it("flattens a reasoning part into transcript text", async () => {
    mockHandshake(() =>
      sseResponse([
        RESPONSE_INIT_FRAME,
        '{"p":"response/fragments/-1/content","o":"APPEND","v":"Answer."}',
        '{"p":"response/status","o":"SET","v":"FINISHED"}',
      ])
    );

    const result = (await model().doStream({
      prompt: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "weighing options" },
            { type: "text", text: "Answer." },
          ],
        },
      ],
    })) as { stream: ReadableStream<Part> };
    await drain(result.stream);

    const completionBody = JSON.parse(
      (fetchSpy.mock.calls[3]?.[1] as RequestInit).body as string
    ) as { prompt: string };
    expect(JSON.stringify(completionBody.prompt)).toContain(
      "[Reasoning: weighing options]"
    );
  });

  it("drops search-result metadata frames without erroring", async () => {
    mockHandshake(() =>
      sseResponse([
        RESPONSE_INIT_FRAME,
        '{"p":"response/search_results","v":[{"title":"Source","url":"https://example.invalid"}]}',
        '{"p":"response/fragments/-1/content","o":"APPEND","v":"Hi"}',
        '{"p":"response/status","o":"SET","v":"FINISHED"}',
      ])
    );

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Part>;
    };
    const parts = await drain(result.stream);

    expect(parts.filter((part) => part.type === "text-delta")).toEqual([
      { type: "text-delta", id: "web-text-1", delta: "Hi" },
    ]);
    expect(parts.some((part) => part.type === "finish")).toBe(true);
  });

  it("keeps classifying trailing frames after FINISHED (unknown frame → protocol_error, not a silent drop)", async () => {
    // I-1 regression: the loop must NOT break on FINISHED, or the upstream would
    // be torn down and a trailing unknown frame would be silently lost. Instead
    // the trailing frame is still classified → protocol_error.
    mockHandshake(() =>
      sseResponse([
        RESPONSE_INIT_FRAME,
        '{"p":"response/fragments/-1/content","o":"APPEND","v":"Hi"}',
        '{"p":"response/status","o":"SET","v":"FINISHED"}',
        '{"unexpected_after_finished":true}',
      ])
    );

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Part>;
    };
    const outcome = await drainOutcome(result.stream);

    expect(outcome).toBeInstanceOf(AdapterRequestError);
    expect((outcome as AdapterRequestError).failure.code).toBe("protocol_error");
  });

  it("drains a trailing search_results metadata frame after FINISHED and terminates (no upstream-closing needed)", async () => {
    // I-1 regression: a metadata frame arriving AFTER FINISHED is still consumed
    // (the upstream stays open through the drain window rather than being torn
    // down by the loop exit). The turn finishes once the upstream ends.
    const trailingFrames = [
      RESPONSE_INIT_FRAME,
      '{"p":"response/fragments/-1/content","o":"APPEND","v":"Hi"}',
      '{"p":"response/status","o":"SET","v":"FINISHED"}',
      '{"p":"response/search_results","v":[{"title":"Source","url":"https://example.invalid"}]}',
    ].map((f) => `data: ${f}\n\n`).join("");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(trailingFrames));
        // Close promptly after the trailing frame so the turn ends naturally.
        setTimeout(() => controller.close(), 10);
      },
    });
    mockHandshake(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Part>;
    };
    const parts = await drain(result.stream);

    // The trailing metadata frame was processed (consumed), not silently lost, and
    // the stream still closed cleanly with the finish part.
    expect(parts.some((part) => part.type === "text-delta")).toBe(true);
    expect(parts.some((part) => part.type === "finish")).toBe(true);
  });

  it("force-closes the turn via the drain timer when the upstream never ends after FINISHED", async () => {
    // I-1 regression: with the loop kept open, the FINISHED_DRAIN_MS timer must
    // resolve the stream if the upstream does not close on its own. The test body
    // stays open after FINISHED and must resolve well under the 750ms window +
    // headroom.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const frames = [
          RESPONSE_INIT_FRAME,
          '{"p":"response/fragments/-1/content","o":"APPEND","v":"Hi"}',
          '{"p":"response/status","o":"SET","v":"FINISHED"}',
        ].map((f) => `data: ${f}\n\n`).join("");
        controller.enqueue(new TextEncoder().encode(frames));
        // Intentionally never close: the drain timer must terminate the turn.
      },
    });
    mockHandshake(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Part>;
    };
    // A generous ceiling: FINISHED_DRAIN_MS (750) plus scheduling headroom. If the
    // stream hangs (the old break-to-tear-down bug), this rejects/times out.
    const parts = await drain(result.stream);
    expect(parts.some((part) => part.type === "finish")).toBe(true);
  });

  it("surfaces a malformed frame as a typed protocol error", async () => {
    mockHandshake(() => sseResponse(["{ not-json"]));

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Part>;
    };
    const outcome = await drainOutcome(result.stream);

    expect(outcome).toBeInstanceOf(AdapterRequestError);
    expect((outcome as AdapterRequestError).failure.code).toBe("protocol_error");
    expect(recordProtocolFailureMock).toHaveBeenCalledWith("deepseek-web", "protocol_error");
  });

  it("surfaces an unrecognized JSON frame as a typed protocol error", async () => {
    mockHandshake(() =>
      sseResponse([
        RESPONSE_INIT_FRAME,
        '{"unexpected_field":true}',
        '{"p":"response/status","o":"SET","v":"FINISHED"}',
      ])
    );

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Part>;
    };
    const outcome = await drainOutcome(result.stream);

    // Never a silent drop into a partial successful response (Spec §7.2).
    expect(outcome).toBeInstanceOf(AdapterRequestError);
    expect((outcome as AdapterRequestError).failure.code).toBe("protocol_error");
  });

  it("aborts the upstream request when the returned stream is cancelled", async () => {
    let upstreamCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("data: Hello\n\n")
        );
        // Never closes on its own — the consumer must cancel it.
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const solved = solvableChallenge(0, 16);
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (url: unknown) => {
      const endpoint = String(url);
      if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.currentUser)) return jsonResponse(FIXTURES.sessionSuccess);
      if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.createSession)) return jsonResponse(FIXTURES.chatSessionCreate);
      if (endpoint.endsWith(DEEPSEEK_WEB_ENDPOINTS.createPowChallenge)) {
        return jsonResponse({ code: 0, biz_data: solved });
      }
      return new Response(body, { status: 200 });
    });

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Part>;
    };
    const reader = result.stream.getReader();
    // Pull the first part so the pump is running, then cancel downstream.
    await reader.read();
    await reader.cancel();
    reader.releaseLock();

    const init = fetchSpy.mock.calls[3]?.[1] as RequestInit | undefined;
    const signal = init?.signal as AbortSignal | undefined;
    expect(signal?.aborted).toBe(true);
    // The abort propagates to the frame parser, which cancels the upstream body.
    await vi.waitFor(() => expect(upstreamCancelled).toBe(true));
  });

  it("surfaces a classified 401 failure and does not log the session token", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([], 401));

    const outcome = await model().doStream({ prompt: [] }).catch((error) => error);

    expect(outcome).toBeInstanceOf(AdapterRequestError);
    expect((outcome as AdapterRequestError).failure.code).toBe("session_rejected");
    expect(JSON.stringify(queryLogs({}))).not.toContain(verifiedSession.userToken);
    expect(JSON.stringify(outcome)).not.toContain(verifiedSession.userToken);
    // The rejection happens on the first (token-exchange) request.
    expect(fetchSpy).toHaveBeenCalledWith(CURRENT_USER_PATH, expect.any(Object));
  });

  it("records a pre-stream unsupported_protocol failure before re-throwing", async () => {
    // Spec §11.3: an unsupported upstream protocol (a credential-bearing
    // redirect / challenge) is thrown by `createTextStream` before any stream
    // exists, so the stream catch never sees it. The challenge case is an
    // explicit trip condition and must reach the breaker.
    const redirectFailure = new TypeError("fetch failed", {
      cause: new Error("unexpected redirect"),
    });
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(redirectFailure);

    const outcome = await model().doStream({ prompt: [] }).catch((error) => error);

    expect(outcome).toBeInstanceOf(AdapterRequestError);
    expect((outcome as AdapterRequestError).failure.code).toBe("unsupported_protocol");
    expect(recordProtocolFailureMock).toHaveBeenCalledWith(
      "deepseek-web",
      "unsupported_protocol"
    );
  });

  it("keeps the null-session seam typed instead of attempting a request", async () => {
    await expect(model(null).doStream({})).rejects.toBeInstanceOf(
      WebProviderGenerationUnavailableError
    );
  });

  it("doGenerate aggregates the streamed deltas into one text block", async () => {
    mockHandshake(() =>
      sseResponse([
        RESPONSE_INIT_FRAME,
        '{"p":"response/fragments/-1/content","o":"APPEND","v":"Hello"}',
        '{"p":"response/fragments/-1/content","o":"APPEND","v":", world"}',
        '{"p":"response/status","o":"SET","v":"FINISHED"}',
      ])
    );

    const result = await model().doGenerate({
      prompt: [],
      temperature: 0.5,
    });

    // The non-streaming path reuses doStream, so the same text-only contract
    // and the same unsupported-option warnings apply.
    expect(result.content).toEqual([{ type: "text", text: "Hello, world" }]);
    expect(result.finishReason.unified).toBe("other");
    expect(result.finishReason.raw).toBe("web-provider:unverified");
    expect(Object.values(result.usage.outputTokens).every((v) => v === undefined)).toBe(true);
    expect(
      result.warnings.map((w) => (w as { feature?: string }).feature)
    ).toContain("temperature");
  });

  it("doGenerate fails loudly without a session rather than returning empty text", async () => {
    await expect(model(null).doGenerate({ prompt: [] })).rejects.toBeInstanceOf(
      WebProviderGenerationUnavailableError
    );
  });
});
