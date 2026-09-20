import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  createHarnessLoop,
  isTimeoutError,
  classifyTimeoutError,
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
