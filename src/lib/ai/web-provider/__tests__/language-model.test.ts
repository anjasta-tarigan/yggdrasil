// @vitest-environment node
/**
 * Contract tests for the web-session language model. The frame payloads are
 * synthetic and intentionally unverified; the protocol spike must confirm the
 * provider grammar before enablement (Spec §13.1). These tests bind only the
 * adapter/model boundary: JSON delta frames become SDK v4 text parts, while
 * malformed, unknown, and non-text inputs remain typed errors, unsupported
 * options are reported (never silently dropped), and completion metadata is
 * honest rather than fabricated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AdapterRequestError,
  DEEPSEEK_WEB_ENDPOINTS,
  DEEPSEEK_WEB_ORIGIN,
} from "../deepseek";

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

const CHAT_URL = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.chat}`;

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

function sseResponse(frames: string[], status = 200): Response {
  return new Response(frames.join(""), {
    status,
    headers: { "content-type": "text/event-stream" },
  });
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
async function drainOutcome(
  stream: ReadableStream<Part>
): Promise<unknown | undefined> {
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
  beforeEach(() => {
    clearLogs();
    recordProtocolFailureMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("declares the v4 specification and empty supportedUrls", () => {
    const instance = model();

    expect(instance.specificationVersion).toBe("v4");
    expect(instance.provider).toBe("deepseek-web");
    expect(instance.modelId).toBe("deepseek-chat");
    expect(instance.supportedUrls).toEqual({});
    expect(instance.session).toBe(verifiedSession);
  });

  it("converts synthetic JSON delta frames to AI SDK v4 parts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        // Synthetic, unverified frame grammar: only the contract is asserted.
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
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

  it("reports honest unknown finish metadata instead of a false stop / zero usage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n',
        "data: [DONE]\n\n",
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        "data: [DONE]\n\n",
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', "data: [DONE]\n\n"])
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
    const fetchSpy = vi.spyOn(globalThis, "fetch");

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
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n',
          "data: [DONE]\n\n",
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
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string
    ) as { messages: Array<{ role: string; content: string }> };
    const transcript = JSON.stringify(body.messages);
    expect(transcript).toContain("[Tool invocation: web_search(");
    expect(transcript).toContain("[Tool result for web_search:");
    // The unparseable tool parts are gone — nothing the adapter cannot read.
    expect(transcript).not.toContain('"type":"tool-call"');
    expect(transcript).not.toContain('"type":"tool-result"');
  });

  it("flattens a reasoning part into transcript text", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n',
          "data: [DONE]\n\n",
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

    const body = JSON.parse(
      (fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string
    ) as { messages: Array<{ role: string; content: string }> };
    expect(JSON.stringify(body.messages)).toContain(
      "[Reasoning: weighing options]"
    );
  });

  it("surfaces a malformed frame as a typed protocol error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse(["data: { not-json\n\n"])
    );

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Part>;
    };
    const outcome = await drainOutcome(result.stream);

    expect(outcome).toBeInstanceOf(AdapterRequestError);
    expect((outcome as AdapterRequestError).failure.code).toBe("protocol_error");
    expect(recordProtocolFailureMock).toHaveBeenCalledWith("deepseek-web", "protocol_error");
  });

  it("surfaces an unrecognized JSON frame as a typed protocol error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n',
        'data: {"unexpected_field":true}\n\n',
        "data: [DONE]\n\n",
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

  it("allows explicitly verified heartbeat / metadata frames", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[]}\n\n',
        'data: {"usage":{"prompt_tokens":3}}\n\n',
        'data: {"type":"heartbeat"}\n\n',
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        "data: [DONE]\n\n",
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

  it("aborts the upstream request when the returned stream is cancelled", async () => {
    let upstreamCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')
        );
        // Never closes on its own — the consumer must cancel it.
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(body, { status: 200 }));

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Part>;
    };
    const reader = result.stream.getReader();
    // Pull the first part so the pump is running, then cancel downstream.
    await reader.read();
    await reader.cancel();
    reader.releaseLock();

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const signal = init?.signal as AbortSignal | undefined;
    expect(signal?.aborted).toBe(true);
    // The abort propagates to the frame parser, which cancels the upstream body.
    await vi.waitFor(() => expect(upstreamCancelled).toBe(true));
  });

  it("surfaces a classified 401 failure and does not log the session token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([], 401)
    );

    const outcome = await model().doStream({ prompt: [] }).catch((error) => error);

    expect(outcome).toBeInstanceOf(AdapterRequestError);
    expect((outcome as AdapterRequestError).failure.code).toBe("session_rejected");
    expect(JSON.stringify(queryLogs({}))).not.toContain(verifiedSession.userToken);
    expect(JSON.stringify(outcome)).not.toContain(verifiedSession.userToken);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(CHAT_URL, expect.any(Object));
  });

  it("records a pre-stream unsupported_protocol failure before re-throwing", async () => {
    // Spec §11.3: an unsupported upstream protocol (a credential-bearing
    // redirect / challenge) is thrown by `createTextStream` before any stream
    // exists, so the stream catch never sees it. The challenge case is an
    // explicit trip condition and must reach the breaker.
    const redirectFailure = new TypeError("fetch failed", {
      cause: new Error("unexpected redirect"),
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(redirectFailure);

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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":", world"}}]}\n\n',
        "data: [DONE]\n\n",
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
