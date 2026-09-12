import { describe, it, expect, beforeEach, vi } from "vitest";

// Pin the per-call metric ring buffer to a small capacity BEFORE the log
// store module evaluates. Vitest isolates module registries per test file,
// so this only affects this file's module instance (mirrors the
// `YGGDRASIL_LOG_DIR` pattern in log-store.test.ts).
const METRIC_CAPACITY = vi.hoisted(() => {
  process.env.YGGDRASIL_AGENT_METRIC_CAPACITY = "5";
  return 5;
});

import {
  recordAgentMetric,
  queryAgentMetrics,
  clearAgentMetrics,
} from "@/lib/observability/log-store";

describe("Agent metric store (recordAgentMetric / queryAgentMetrics)", () => {
  beforeEach(() => clearAgentMetrics());

  it("records a metric retrievable by callId with all core fields", () => {
    recordAgentMetric({
      callId: "call-1",
      durationMs: 120,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      finishReason: "stop",
    });

    const metrics = queryAgentMetrics("call-1");
    expect(metrics).toHaveLength(1);
    const m = metrics[0];
    expect(m.callId).toBe("call-1");
    expect(m.durationMs).toBe(120);
    expect(m.inputTokens).toBe(100);
    expect(m.outputTokens).toBe(50);
    expect(m.totalTokens).toBe(150);
    expect(m.finishReason).toBe("stop");
    expect(m.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("defaults stepNumber and toolName to null when not supplied", () => {
    recordAgentMetric({
      callId: "call-a",
      durationMs: 33,
      totalTokens: 10,
      finishReason: "tool-calls",
    });

    const [m] = queryAgentMetrics("call-a");
    expect(m.stepNumber).toBeNull();
    expect(m.toolName).toBeNull();
  });

  it("stores a per-tool metric with toolName and durationMs", () => {
    recordAgentMetric({
      callId: "call-t",
      toolName: "web_search",
      durationMs: 842,
      finishReason: null,
    });

    const [m] = queryAgentMetrics("call-t");
    expect(m.toolName).toBe("web_search");
    expect(m.durationMs).toBe(842);
    expect(m.stepNumber).toBeNull();
    expect(m.totalTokens).toBeNull();
  });

  it("records multiple metrics per callId, returned newest-last", () => {
    recordAgentMetric({
      callId: "call-multi",
      durationMs: 100,
      finishReason: "tool-calls",
    });
    recordAgentMetric({
      callId: "call-multi",
      durationMs: 250,
      finishReason: "stop",
    });

    const metrics = queryAgentMetrics("call-multi");
    expect(metrics).toHaveLength(2);
    expect(metrics[0].durationMs).toBe(100);
    expect(metrics[1].durationMs).toBe(250);
    expect(metrics[0].at).toBe(metrics[0].at);
  });

  it("isolates metrics across different callIds", () => {
    recordAgentMetric({ callId: "alpha", durationMs: 1, totalTokens: 2 });
    recordAgentMetric({ callId: "beta", durationMs: 3, totalTokens: 4 });

    expect(queryAgentMetrics("alpha")).toHaveLength(1);
    expect(queryAgentMetrics("beta")).toHaveLength(1);
    expect(queryAgentMetrics("alpha")[0].callId).toBe("alpha");
    expect(queryAgentMetrics("beta")[0].callId).toBe("beta");
  });

  it("returns an empty array for an unknown callId", () => {
    recordAgentMetric({ callId: "known", durationMs: 5 });
    expect(queryAgentMetrics("unknown")).toEqual([]);
  });

  it("returns all records across callIds when no callId is given", () => {
    recordAgentMetric({ callId: "a", durationMs: 1 });
    recordAgentMetric({ callId: "b", durationMs: 2 });
    const all = queryAgentMetrics();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.callId)).toEqual(["a", "b"]);
  });

  it("bounds the buffer to the ring capacity, evicting oldest entries", () => {
    expect(METRIC_CAPACITY).toBe(5);
    // Record more than the capacity; oldest must be dropped, newest kept.
    for (let i = 0; i < METRIC_CAPACITY + 3; i++) {
      recordAgentMetric({
        callId: `c${i}`,
        durationMs: i,
        finishReason: "stop",
      });
    }

    // Buffer never exceeds capacity.
    expect(queryAgentMetrics().length).toBe(METRIC_CAPACITY);
    // The newest callId survives; an evicted one is gone.
    expect(queryAgentMetrics(`c${METRIC_CAPACITY + 2}`)).toHaveLength(1);
    expect(queryAgentMetrics("c0")).toEqual([]);
    // Surviving records are returned newest-last and contiguous.
    const all = queryAgentMetrics();
    expect(all.map((m) => m.callId)).toEqual(
      Array.from({ length: METRIC_CAPACITY }, (_, i) => `c${i + 3}`)
    );
  });

  it("never throws when given empty or partial input", () => {
    expect(() => recordAgentMetric({ callId: "edge" })).not.toThrow();
    expect(() => recordAgentMetric({ callId: "", durationMs: 0 })).not.toThrow();
    const [m] = queryAgentMetrics("edge");
    expect(m.callId).toBe("edge");
    expect(m.durationMs).toBeNull();
    expect(m.totalTokens).toBeNull();
    expect(m.finishReason).toBeNull();
  });

  it("clearAgentMetrics empties the store and reports the cleared count", () => {
    recordAgentMetric({ callId: "x", durationMs: 1 });
    recordAgentMetric({ callId: "y", durationMs: 2 });
    recordAgentMetric({ callId: "z", durationMs: 3 });

    const cleared = clearAgentMetrics();
    expect(cleared).toBe(3);
    expect(queryAgentMetrics()).toEqual([]);
    expect(queryAgentMetrics("x")).toEqual([]);
  });
});
