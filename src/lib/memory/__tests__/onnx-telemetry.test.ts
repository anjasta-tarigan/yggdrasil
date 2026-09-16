import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  recordInferenceLatency,
  getOnnxSlotTelemetry,
  setOrtLoaderForTest,
  acquireOnnxSession,
  releaseOnnxSession,
  resetOnnxSlotTelemetryForTest,
  ONNX_SLOT_RERANKER,
} from "../onnx-session";
import { getRerankerStatus } from "../reranker";

describe("ONNX Hardware Telemetry & Profiling", () => {
  beforeEach(async () => {
    resetOnnxSlotTelemetryForTest(ONNX_SLOT_RERANKER);
    await releaseOnnxSession(ONNX_SLOT_RERANKER);
  });

  afterEach(async () => {
    setOrtLoaderForTest(null);
    resetOnnxSlotTelemetryForTest(ONNX_SLOT_RERANKER);
    await releaseOnnxSession(ONNX_SLOT_RERANKER);
  });

  it("calculates rolling p50 and p95 latencies accurately using fixed ring buffer", () => {
    // Record 50 synthetic latencies from 10ms to 59ms
    for (let i = 10; i <= 59; i++) {
      recordInferenceLatency(ONNX_SLOT_RERANKER, i);
    }
    const telemetry = getOnnxSlotTelemetry(ONNX_SLOT_RERANKER);
    expect(telemetry).not.toBeNull();
    expect(telemetry!.totalInferences).toBe(50);
    expect(telemetry!.lastInferenceMs).toBe(59);
    // Median of 10..59 is approx 34-35
    expect(telemetry!.p50LatencyMs).toBeGreaterThanOrEqual(33);
    expect(telemetry!.p50LatencyMs).toBeLessThanOrEqual(36);
    // p95 of 50 items is around the 47th item (approx 56-58)
    expect(telemetry!.p95LatencyMs).toBeGreaterThanOrEqual(55);
  });

  it("records cold start time and captures active execution provider race-free", async () => {
    setOrtLoaderForTest(async () => ({
      InferenceSession: {
        create: async () => {
          // Simulate 15ms cold start
          await new Promise((r) => setTimeout(r, 15));
          return {
            inputNames: ["input"],
            outputNames: ["output"],
            run: async () => ({ output: { data: new Float32Array([1]) } }),
            release: async () => {},
          };
        },
      },
      Tensor: class {} as never,
    }));

    await acquireOnnxSession(ONNX_SLOT_RERANKER, "/mock/model.onnx", { executionProviders: ["cpu"] });

    const telemetry = getOnnxSlotTelemetry(ONNX_SLOT_RERANKER);
    expect(telemetry).not.toBeNull();
    expect(telemetry!.activeProvider).toBe("cpu");
    expect(telemetry!.coldStartTimeMs).toBeGreaterThanOrEqual(10);
  });

  it("returns null for unknown slot with no activity", () => {
    const telemetry = getOnnxSlotTelemetry("non_existent_slot");
    expect(telemetry).toBeNull();
  });

  it("handles ring buffer wrap-around correctly after 50+ inferences", () => {
    // Record 60 latencies: 1..60. Ring buffer will retain 11..60 (50 items)
    for (let i = 1; i <= 60; i++) {
      recordInferenceLatency(ONNX_SLOT_RERANKER, i);
    }
    const telemetry = getOnnxSlotTelemetry(ONNX_SLOT_RERANKER);
    expect(telemetry).not.toBeNull();
    expect(telemetry!.totalInferences).toBe(60);
    expect(telemetry!.lastInferenceMs).toBe(60);
    // Items are 11..60. Average is (11+60)/2 = 35.5
    expect(telemetry!.avgLatencyMs).toBeCloseTo(35.5, 1);
    expect(telemetry!.rollingAvgMs).toBeCloseTo(35.5, 1);
  });

  it("exposes telemetry in getRerankerStatus", () => {
    recordInferenceLatency(ONNX_SLOT_RERANKER, 25.5);
    const status = getRerankerStatus();
    expect(status.telemetry).toBeDefined();
    expect(status.telemetry?.totalInferences).toBe(1);
    expect(status.telemetry?.lastInferenceMs).toBe(25.5);
  });

  it("persists telemetry across session release so standby status retains metrics", async () => {
    recordInferenceLatency(ONNX_SLOT_RERANKER, 42);
    expect(getOnnxSlotTelemetry(ONNX_SLOT_RERANKER)?.totalInferences).toBe(1);

    // Idle timeout or explicit release releases ORT native memory
    await releaseOnnxSession(ONNX_SLOT_RERANKER);

    // Telemetry remains intact so status dashboards still see profiling data
    const telemetryAfter = getOnnxSlotTelemetry(ONNX_SLOT_RERANKER);
    expect(telemetryAfter).not.toBeNull();
    expect(telemetryAfter?.totalInferences).toBe(1);
    expect(telemetryAfter?.lastInferenceMs).toBe(42);
  });

  it("ignores invalid latency inputs like NaN and negative numbers", () => {
    recordInferenceLatency(ONNX_SLOT_RERANKER, Number.NaN);
    recordInferenceLatency(ONNX_SLOT_RERANKER, -15);
    recordInferenceLatency(ONNX_SLOT_RERANKER, Number.POSITIVE_INFINITY);

    const telemetry = getOnnxSlotTelemetry(ONNX_SLOT_RERANKER);
    expect(telemetry).toBeNull();

    recordInferenceLatency(ONNX_SLOT_RERANKER, 20);
    const validTelemetry = getOnnxSlotTelemetry(ONNX_SLOT_RERANKER);
    expect(validTelemetry?.totalInferences).toBe(1);
    expect(validTelemetry?.lastInferenceMs).toBe(20);
  });
});
