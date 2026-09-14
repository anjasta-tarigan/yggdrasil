import { describe, it, expect, beforeEach } from "vitest";
import { getJobRegistry, JobConflictError } from "../jobs";

describe("models/jobs", () => {
  beforeEach(() => {
    getJobRegistry().clearAllForTest();
  });

  it("creates job and joins idempotently for same variant", () => {
    const reg = getJobRegistry();
    const job1 = reg.createJob("embedding", "Xenova/minilm", "model_int8.onnx", 100);
    const job2 = reg.getOrCreateJob("embedding", "Xenova/minilm", "model_int8.onnx", 100);
    expect(job1.id).toBe(job2.id);
  });

  it("throws JobConflictError when requested variant differs from active variant", () => {
    const reg = getJobRegistry();
    reg.createJob("embedding", "Xenova/minilm", "model_int8.onnx", 100);
    expect(() => {
      reg.getOrCreateJob("embedding", "Xenova/minilm", "model_fp32.onnx", 200);
    }).toThrow(JobConflictError);
  });

  it("tracks activeJobsBytesReserved across running jobs", () => {
    const reg = getJobRegistry();
    reg.createJob("embedding", "repo1", "m.onnx", 500);
    reg.createJob("reranker", "repo2", "m.onnx", 300);
    expect(reg.getTotalBytesReserved()).toBe(800);
  });
});
