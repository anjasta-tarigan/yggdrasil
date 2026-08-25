import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
  generateEmbedding,
} from "../embeddings";

describe("Vector Embeddings & Cosine Similarity", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("converts Float32Array to Buffer and back losslessly", () => {
    const original = new Float32Array([0.1, -0.5, 0.85, 1.0]);
    const buffer = vectorToBuffer(original);
    const restored = bufferToVector(buffer);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("calculates cosine similarity correctly", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    const c = new Float32Array([0, 1, 0]);
    const d = new Float32Array([-1, 0, 0]);

    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
    expect(cosineSimilarity(a, c)).toBeCloseTo(0.0, 5);
    expect(cosineSimilarity(a, d)).toBeCloseTo(-1.0, 5);
  });

  it("handles edge cases in cosine similarity (zero norms, mismatched lengths)", () => {
    const zero = new Float32Array([0, 0, 0]);
    const normal = new Float32Array([1, 2, 3]);
    const mismatched = new Float32Array([1, 2]);
    const empty = new Float32Array([]);

    expect(cosineSimilarity(zero, normal)).toBe(0);
    expect(cosineSimilarity(normal, zero)).toBe(0);
    expect(cosineSimilarity(normal, mismatched)).toBe(0);
    expect(cosineSimilarity(empty, empty)).toBe(0);
  });

  it("generates fallback synthetic embedding if LLM_BASE_URL is not set", async () => {
    delete process.env.LLM_BASE_URL;
    const embedding = await generateEmbedding("test query");
    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding.length).toBe(64);
  });

  it("calls remote endpoint when LLM_BASE_URL is set and returns embedding array", async () => {
    process.env.LLM_BASE_URL = "http://mock-llm.local/v1";
    process.env.LLM_API_KEY = "test-key";

    const mockVector = [0.125, -0.5, 0.75, 1.0];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ embedding: mockVector }],
      }),
    } as Response);

    const embedding = await generateEmbedding("hello world", "custom-embedding-model");
    expect(fetchSpy).toHaveBeenCalledWith("http://mock-llm.local/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify({
        input: "hello world",
        model: "custom-embedding-model",
      }),
    });

    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding.length).toBe(mockVector.length);
    for (let i = 0; i < mockVector.length; i++) {
      expect(embedding[i]).toBeCloseTo(mockVector[i], 5);
    }
  });

  it("falls back to deterministic embedding when remote endpoint returns error", async () => {
    process.env.LLM_BASE_URL = "http://mock-llm.local/v1";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);

    const embedding = await generateEmbedding("test query with error");
    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding.length).toBe(64);
  });

  it("falls back to deterministic embedding when fetch throws network error", async () => {
    process.env.LLM_BASE_URL = "http://mock-llm.local/v1";

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network connection refused"));

    const embedding = await generateEmbedding("network test");
    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding.length).toBe(64);
  });
});
