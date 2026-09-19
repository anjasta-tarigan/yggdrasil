// @vitest-environment node
// Real ORT + real fs: this must run in Node, not jsdom. jsdom's realm gives
// onnxruntime-node a different TypedArray constructor, which the native addon
// rejects ("A float32 tensor's data must be type of function Float32Array()").
import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Integration test against a REAL local ONNX model in data/models/embedding.
 *
 * Gated: skipped when no model is present, so CI and fresh clones stay green.
 * Everything below the config layer is real — the actual tokenizer, the actual
 * ORT session, the actual pooling, the actual file on disk. Only the registry
 * read is stubbed, so the test targets the local model deterministically
 * instead of whatever endpoint the developer's registry happens to point at.
 *
 * This is the layer that catches what unit tests cannot: a tokenizer that
 * produces plausible-but-wrong ids, a pooling mode that does not match the
 * checkpoint, or a graph input the code fails to feed. Unit tests pass with
 * all three broken, because they mock the session.
 *
 * To run: place a model + its tokenizer.json in data/models/embedding/.
 */

const DIR = path.resolve(process.cwd(), "data/models/embedding");

const modelFile = (() => {
  try {
    return fs.readdirSync(DIR).find((f) => f.endsWith(".onnx")) ?? null;
  } catch (err) {
    return null;
  }
})();
const hasTokenizer = (() => {
  try {
    return fs.existsSync(path.join(DIR, "tokenizer.json"));
  } catch (err) {
    return false;
  }
})();
const canRun = modelFile !== null && hasTokenizer;

// Stub only the config source so the local model is selected deterministically.
const loadRegistryMock = vi.fn();
vi.mock("@/lib/ai/provider-config/store", () => ({
  get loadRegistry() {
    return loadRegistryMock;
  },
  resolveApiKey: vi.fn(async () => undefined),
  getProviderById: vi.fn(),
  getRegistryView: vi.fn(),
  saveRegistry: vi.fn(),
  ProviderConfigError: class extends Error {
    name = "ProviderConfigError";
  },
}));

import {
  discoverEmbeddingModels,
  resolveEmbeddingOnnxPath,
  getOnnxEmbeddingStatus,
  generateEmbedding,
  clearTokenizerCacheForTest,
  clearEmbeddingCacheForTest,
  cosineSimilarity,
} from "../embeddings";

describe.skipIf(!canRun)("ONNX embedding (real model on disk)", () => {
  beforeAll(() => {
    loadRegistryMock.mockResolvedValue({
      version: 1,
      providers: [],
      embedding: {
        provider: "onnx",
        providerId: null,
        modelPath: modelFile!,
        // The e5 family uses mean pooling (intfloat's 1_Pooling/config.json).
        poolingMode: "mean",
        chunkSize: 2000,
        chunkOverlap: 200,
      },
    });
    clearTokenizerCacheForTest();
    clearEmbeddingCacheForTest();
  });

  it("discovers the model file and its size clears the stub threshold", async () => {
    const models = await discoverEmbeddingModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.sizeBytes).toBeGreaterThan(50 * 1024 * 1024);
    }
  });

  it("resolves a model path", async () => {
    expect(await resolveEmbeddingOnnxPath()).toBeTruthy();
  });

  it("reports status without throwing", async () => {
    const status = await getOnnxEmbeddingStatus(modelFile!);
    expect(status.modelPath).toBeTruthy();
    expect(["already-pooled", "resolved", "unresolved"]).toContain(
      status.pooling.status
    );
  });

  it("embeds to an L2-normalized vector, deterministically", async () => {
    const v = await generateEmbedding("Hello world");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v!.length).toBeGreaterThan(0);

    let norm = 0;
    for (let i = 0; i < v!.length; i++) norm += v![i] * v![i];
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4);

    const again = await generateEmbedding("Hello world");
    expect(again!.length).toBe(v!.length);
    expect(cosineSimilarity(v!, again!)).toBeCloseTo(1, 5);
  });

  it("places a related sentence closer than an unrelated one", async () => {
    // The real check: a wrong tokenizer or pooling still yields unit vectors,
    // so only the RELATIVE geometry reveals it.
    const query = await generateEmbedding("How do I reset my password?");
    const related = await generateEmbedding(
      "I need to change my login credentials."
    );
    const unrelated = await generateEmbedding(
      "Photosynthesis converts light into glucose."
    );

    const relSim = cosineSimilarity(query!, related!);
    const unrelSim = cosineSimilarity(query!, unrelated!);
    expect(relSim).toBeGreaterThan(unrelSim);
  });

  it("separates paraphrase pairs from unrelated pairs on average", async () => {
    const pairs: Array<[string, string, boolean]> = [
      ["The cat sat on the mat.", "A feline rested on the rug.", true],
      ["She is cooking dinner.", "A woman is preparing a meal.", true],
      ["How do I reset my password?", "Photosynthesis converts light.", false],
      ["The cat sat on the mat.", "Interest rates rose sharply.", false],
    ];

    let relSum = 0;
    let unrelSum = 0;
    let relN = 0;
    let unrelN = 0;
    for (const [a, b, isRelated] of pairs) {
      const [va, vb] = [await generateEmbedding(a), await generateEmbedding(b)];
      const sim = cosineSimilarity(va!, vb!);
      if (isRelated) {
        relSum += sim;
        relN++;
      } else {
        unrelSum += sim;
        unrelN++;
      }
    }

    const relAvg = relSum / relN;
    const unrelAvg = unrelSum / unrelN;
    expect(relAvg).toBeGreaterThan(unrelAvg);
    // A working embedder separates these clearly; a broken one would not.
    expect(relAvg - unrelAvg).toBeGreaterThan(0.05);
  });
});
