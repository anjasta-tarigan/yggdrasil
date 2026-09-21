import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  createHarnessLoop,
  formatTimeoutForClient,
  isTimeoutError,
  classifyTimeoutError,
  timeoutAbortToErrorPart,
  harnessStopReason,
  HARNESS_MAX_STEPS,
  HARNESS_TIMEOUT,
  HARNESS_BASH_TIMEOUT_MS,
} from "@/lib/ai/harness-loop";
import { syslog } from "@/lib/observability/log-store";

vi.mock("@/lib/observability/log-store", () => ({
  syslog: vi.fn(),
}));

// --- Stream part helpers (raw LanguageModelV4 stream parts) ---

function makeStreamStart() {
  return { type: "stream-start" as const, warnings: [] };
}

function makeTextStart(id = "test-text-1") {
  return { type: "text-start" as const, id };
}

function makeTextDelta(delta: string, id = "test-text-1") {
  return { type: "text-delta" as const, id, delta };
}

function makeTextEnd(id = "test-text-1") {
  return { type: "text-end" as const, id };
}

function makeFinish(finishReason: "stop" | "length" | "tool-calls" = "stop") {
  return {
    type: "finish" as const,
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    finishReason: { unified: finishReason, raw: finishReason },
  };
}

// --- isTimeoutError ---

describe("isTimeoutError", () => {
  it("returns true for DOMException with name 'TimeoutError'", () => {
    const error = new DOMException(
      "step timeout of 30000ms exceeded",
      "TimeoutError"
    );
    expect(isTimeoutError(error)).toBe(true);
  });

  it("returns false for DOMException with different name", () => {
    expect(isTimeoutError(new DOMException("something", "Error"))).toBe(false);
  });

  it("returns false for regular Error", () => {
    expect(isTimeoutError(new Error("nope"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isTimeoutError("string")).toBe(false);
    expect(isTimeoutError(42)).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });
});

// --- classifyTimeoutError ---

describe("classifyTimeoutError", () => {
  it.each([
    ["total", 120000],
    ["step", 30000],
    ["first chunk", 10000],
    ["chunk", 5000],
    ["tool", 30000],
    ["tool:my_tool", 30000],
  ])("classifies '%s' timeout", (label, ms) => {
    const error = new DOMException(
      `${label} timeout of ${ms}ms exceeded`,
      "TimeoutError"
    );
    expect(classifyTimeoutError(error)).toBe(`${label} timeout (${ms}ms)`);
  });

  it("returns 'unknown timeout' for non-timeout errors", () => {
    expect(classifyTimeoutError(new Error("boom"))).toBe("unknown timeout");
  });

  it("returns the raw message when pattern doesn't match", () => {
    const error = new DOMException("weird timeout", "TimeoutError");
    expect(classifyTimeoutError(error)).toBe("weird timeout");
  });
});

// --- formatTimeoutForClient ---

describe("formatTimeoutForClient", () => {
  it("builds the exact client message for a timeout DOMException", () => {
    const error = new DOMException(
      "first chunk timeout of 90000ms exceeded",
      "TimeoutError"
    );
    expect(formatTimeoutForClient(error)).toBe(
      "The agent timed out (first chunk timeout (90000ms)). Send a follow-up message to continue."
    );
  });

  it("returns undefined for a plain Error", () => {
    expect(formatTimeoutForClient(new Error("boom"))).toBeUndefined();
  });

  it("returns undefined for a string", () => {
    expect(formatTimeoutForClient("timeout")).toBeUndefined();
  });

  it("returns undefined for a non-timeout DOMException", () => {
    expect(
      formatTimeoutForClient(new DOMException("nope", "AbortError"))
    ).toBeUndefined();
  });

  it("derives the classification from the error, not shared state", () => {
    // A second, differently-classified timeout must format independently —
    // this is what makes the mapper race-free.
    const step = new DOMException("step timeout of 30000ms exceeded", "TimeoutError");
    const total = new DOMException("total timeout of 1200000ms exceeded", "TimeoutError");
    expect(formatTimeoutForClient(step)).toContain("step timeout (30000ms)");
    expect(formatTimeoutForClient(total)).toContain("total timeout (1200000ms)");
  });
});

// --- createHarnessLoop ---

describe("createHarnessLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams text and fires lifecycle callbacks in order", async () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();
    const onTimeoutError = vi.fn();

    const mockModel = new MockLanguageModelV4({
      provider: "test",
      modelId: "test-model",
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            makeStreamStart(),
            makeTextStart(),
            makeTextDelta("Hello"),
            makeTextDelta(" World"),
            makeTextEnd(),
            makeFinish(),
          ],
        }),
      }),
    });

    const result = createHarnessLoop({
      model: mockModel,
      messages: [{ role: "user", content: "Say hello" }],
      onStart,
      onEnd,
      onError,
      onTimeoutError,
    });

    const text = await result.text;

    expect(text).toBe("Hello World");
    expect(onStart).toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onTimeoutError).not.toHaveBeenCalled();
  });

  it("intercepts timeout errors, calls onTimeoutError + onError + syslog", async () => {
    const onError = vi.fn();
    const onTimeoutError = vi.fn();

    const timeoutError = new DOMException(
      "step timeout of 30000ms exceeded",
      "TimeoutError"
    );

    const mockModel = new MockLanguageModelV4({
      provider: "test",
      modelId: "test-model",
      doStream: async () => {
        throw timeoutError;
      },
    });

    const result = createHarnessLoop({
      model: mockModel,
      messages: [{ role: "user", content: "Say hello" }],
      onError,
      onTimeoutError,
    });

    // Consume the stream to trigger the error path
    await Array.fromAsync(result.stream);

    expect(onTimeoutError).toHaveBeenCalledWith(
      timeoutError,
      "step timeout (30000ms)"
    );
    expect(onError).toHaveBeenCalledWith({ error: timeoutError });
    expect(syslog).toHaveBeenCalledWith(
      "warn",
      "agent",
      "Timeout error detected: step timeout (30000ms)"
    );
  });

  it("passes non-timeout errors to onError only, skips onTimeoutError", async () => {
    const onError = vi.fn();
    const onTimeoutError = vi.fn();

    const regularError = new Error("Something went wrong");

    const mockModel = new MockLanguageModelV4({
      provider: "test",
      modelId: "test-model",
      doStream: async () => {
        throw regularError;
      },
    });

    const result = createHarnessLoop({
      model: mockModel,
      messages: [{ role: "user", content: "Say hello" }],
      onError,
      onTimeoutError,
    });

    // Consume the stream to trigger the error path
    await Array.fromAsync(result.stream);

    expect(onTimeoutError).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith({ error: regularError });
  });
});

// --- HARNESS_TIMEOUT policy -------------------------------------------------
//
// Regression guard for the "long project run dies after ~6 steps with no
// message" bug. Root cause: `chunkMs` (a per-chunk watchdog) aborted a step
// while a reasoning model was thinking silently, and the SDK reports an abort
// (not an error), so the route's silent onAbort path swallowed it.

describe("HARNESS_TIMEOUT policy", () => {
  it("keeps a chunk watchdog below stepMs and at least 5 minutes", () => {
    expect("chunkMs" in HARNESS_TIMEOUT).toBe(true);
    expect(HARNESS_TIMEOUT.chunkMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(HARNESS_TIMEOUT.chunkMs).toBeLessThan(HARNESS_TIMEOUT.stepMs);
  });

  it("keeps the bash timeout strictly below the SDK tool timeout", () => {
    expect(HARNESS_TIMEOUT.tools.bashMs).toBeGreaterThan(HARNESS_BASH_TIMEOUT_MS);
    expect(HARNESS_BASH_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it("keeps total > step > chunk > firstChunk ordering", () => {
    expect(HARNESS_TIMEOUT.totalMs).toBeGreaterThan(HARNESS_TIMEOUT.stepMs);
    expect(HARNESS_TIMEOUT.stepMs).toBeGreaterThan(HARNESS_TIMEOUT.chunkMs);
    expect(HARNESS_TIMEOUT.chunkMs).toBeGreaterThan(HARNESS_TIMEOUT.firstChunkMs);
  });
});

// --- timeoutAbortToErrorPart ------------------------------------------------
//
// The abort part is invisible to `useChat` (the SDK emits it and the client
// ignores it), so a timeout surfaced as a clean finish and the user saw
// nothing. Converting a *timeout* abort into an `error` part routes it into
// the existing onError / UI-error path; every other abort stays untouched.

describe("timeoutAbortToErrorPart", () => {
  it("converts a timeout abort into an error part", async () => {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: "abort",
          reason: "Chunk timeout of 60000ms exceeded",
        });
        controller.close();
      },
    });

    const out = await Array.fromAsync(timeoutAbortToErrorPart(source));

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("error");
  });

  it("passes a non-timeout abort through unchanged", async () => {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "abort", reason: "user cancelled" });
        controller.close();
      },
    });

    const out = await Array.fromAsync(timeoutAbortToErrorPart(source));

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: "abort", reason: "user cancelled" });
  });

  it("passes an abort with no reason through unchanged", async () => {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "abort" });
        controller.close();
      },
    });

    const out = await Array.fromAsync(timeoutAbortToErrorPart(source));

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: "abort" });
  });

  it("passes non-abort parts through unchanged and in order", async () => {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(makeTextStart());
        controller.enqueue(makeTextDelta("hi"));
        controller.enqueue(makeFinish());
        controller.close();
      },
    });

    const out = await Array.fromAsync(timeoutAbortToErrorPart(source));

    expect(out.map((p) => p.type)).toEqual([
      "text-start",
      "text-delta",
      "finish",
    ]);
  });
});

// --- harnessStopReason ------------------------------------------------------
//
// The run-end log already distinguishes these server-side, but the client saw
// `finishReason: "stop"` in every case and could not tell a natural stop from a
// step cap or a context wrap-up — which is what made the original bug read as a
// silent success.

describe("harnessStopReason", () => {
  it("reports a natural stop when the model finished on its own", () => {
    expect(
      harnessStopReason({ steps: 7, finishReason: "stop", contextWrapUp: false })
    ).toBe("natural");
  });

  it("reports a step cap when the run reached HARNESS_MAX_STEPS", () => {
    expect(
      harnessStopReason({
        steps: HARNESS_MAX_STEPS,
        finishReason: "stop",
        contextWrapUp: false,
      })
    ).toBe("step-cap");
  });

  it("reports a context wrap-up ahead of a step cap", () => {
    expect(
      harnessStopReason({
        steps: HARNESS_MAX_STEPS,
        finishReason: "stop",
        contextWrapUp: true,
      })
    ).toBe("context-wrap-up");
  });

  it("reports a context wrap-up below the step cap", () => {
    expect(
      harnessStopReason({ steps: 12, finishReason: "stop", contextWrapUp: true })
    ).toBe("context-wrap-up");
  });
});
