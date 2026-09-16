import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateEmbedding } from "@/lib/memory/embeddings";
import { detectTopicDrift } from "@/lib/ai/pipeline/topic-drift-detector";
import type { TopicDriftReport } from "@/lib/ai/pipeline/topic-drift-detector";

// The embeddings module is heavy (ONNX / registry / provider deps). Mock it
// so we control `generateEmbedding` as a pure stub, while `importOriginal`
// preserves the REAL `cosineSimilarity` — so the cosine math is exercised for
// real, not faked. The two transitive modules are mocked so importOriginal can
// load the real module the same way `embeddings.test.ts` does.
vi.mock("@/lib/settings-service", () => ({
  getSettingDb: vi.fn(() => ({})),
}));
vi.mock("@/lib/ai/provider-config/store", () => ({
  loadRegistry: vi.fn(),
  resolveApiKey: vi.fn(),
  getProviderById: vi.fn(),
  getRegistryView: vi.fn(),
  saveRegistry: vi.fn(),
  ProviderConfigError: class extends Error {
    name = "ProviderConfigError";
  },
}));
vi.mock("@/lib/memory/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memory/embeddings")>();
  return {
    ...actual,
    generateEmbedding: vi.fn(),
  };
});

const mockGenerateEmbedding = vi.mocked(generateEmbedding);

/** One-hot unit vector so distinct sentences are orthogonal (cosine sim = 0). */
function oneHot(index: number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  v[index] = 1;
  return v;
}

describe("detectTopicDrift", () => {
  beforeEach(() => {
    mockGenerateEmbedding.mockReset();
  });

  it("reports no drift for coherent, same-topic text", async () => {
    const sentences = [
      "The code compiles without errors.",
      "The code follows clean patterns.",
      "The code runs efficiently.",
    ];
    const text = sentences.join(" ");
    // Coherent sentences embed identically → cosine similarity 1.0.
    mockGenerateEmbedding.mockResolvedValue(oneHot(0, 4));

    const report: TopicDriftReport | null = await detectTopicDrift(text);

    expect(report).not.toBeNull();
    expect(report!.driftDetected).toBe(false);
    expect(report!.minSimilarity).toBeCloseTo(1.0, 5);
    expect(report!.sentences).toEqual(sentences);
    expect(report!.threshold).toBe(0.35);
    expect(report!.confidence).toBeCloseTo(1.0, 1);
  });

  it("detects topic drift across disjoint topics (password -> weather -> climate -> tech)", async () => {
    const sentences = [
      "The password must be at least twelve characters.",
      "The weather forecast predicts heavy rain today.",
      "Climate change affects global temperature patterns.",
      "Technology evolves rapidly each year.",
    ];
    const text = sentences.join(" ");
    // Each sentence embeds to a distinct one-hot vector → similarity 0.0.
    let callCount = 0;
    mockGenerateEmbedding.mockImplementation(async () =>
      oneHot(callCount++, sentences.length)
    );

    const report: TopicDriftReport | null = await detectTopicDrift(text);

    expect(report).not.toBeNull();
    expect(report!.driftDetected).toBe(true);
    expect(report!.minSimilarity).toBe(0);
    expect(report!.threshold).toBe(0.35);
    expect(report!.sentences).toEqual(sentences);
    expect(report!.confidence).toBeCloseTo(1.0, 1);
  });

  it("returns null for text with fewer than 3 sentences", async () => {
    const text = "The code compiles without errors. The code runs efficiently.";
    mockGenerateEmbedding.mockResolvedValue(oneHot(0, 4));

    const report: TopicDriftReport | null = await detectTopicDrift(text);

    expect(report).toBeNull();
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  it("returns null when embeddings are unavailable", async () => {
    const text =
      "The password must be twelve characters. " +
      "The weather is rainy today. " +
      "Climate patterns shift globally.";

    // Embedding subsystem degrades to null (endpoint down / model missing).
    mockGenerateEmbedding.mockResolvedValue(null);

    const report: TopicDriftReport | null = await detectTopicDrift(text);

    expect(report).toBeNull();
    expect(mockGenerateEmbedding).toHaveBeenCalled();
  });
});
