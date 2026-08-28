import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
  generateEmbedding,
  chunkText,
  detectEmbeddingDimensions,
  getEmbeddingConfig,
  getDefaultModelForProvider,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_OLLAMA_MODEL_ID,
  DEFAULT_OPENAI_MODEL_ID,
} from "../embeddings";
import { getSettingDb } from "@/lib/settings-service";

// The embeddings module reads saved settings from SQLite; tests control
// the stored configuration through this mock (default: empty → "server").
vi.mock("@/lib/settings-service", () => ({
  getSettingDb: vi.fn(() => ({})),
}));

const getSettingDbMock = vi.mocked(getSettingDb);

function mockEmbeddingResponse(vector: number[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: vector }] }),
  } as Response;
}

describe("Vector Embeddings & Cosine Similarity", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    getSettingDbMock.mockReturnValue({});
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

  it("returns null when no endpoint is configured (no synthetic vectors)", async () => {
    delete process.env.LLM_BASE_URL;
    const embedding = await generateEmbedding("test query");
    expect(embedding).toBeNull();
  });

  it("calls remote endpoint when LLM_BASE_URL is set and returns embedding array", async () => {
    process.env.LLM_BASE_URL = "http://mock-llm.local/v1";
    process.env.LLM_API_KEY = "test-key";

    const mockVector = [0.125, -0.5, 0.75, 1.0];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockEmbeddingResponse(mockVector));

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
      signal: expect.any(AbortSignal),
    });

    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding!.length).toBe(mockVector.length);
    for (let i = 0; i < mockVector.length; i++) {
      expect(embedding![i]).toBeCloseTo(mockVector[i], 5);
    }
  });

  it("returns null when remote endpoint returns error", async () => {
    process.env.LLM_BASE_URL = "http://mock-llm.local/v1";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);

    const embedding = await generateEmbedding("test query with error");
    expect(embedding).toBeNull();
  });

  it("returns null when fetch throws network error", async () => {
    process.env.LLM_BASE_URL = "http://mock-llm.local/v1";

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network connection refused"));

    const embedding = await generateEmbedding("network test");
    expect(embedding).toBeNull();
  });
});

describe("Embedding configuration", () => {
  beforeEach(() => {
    getSettingDbMock.mockReturnValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies safe defaults when nothing is stored", () => {
    const config = getEmbeddingConfig();
    expect(config.provider).toBe("server");
    expect(config.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
    expect(config.chunkOverlap).toBe(DEFAULT_CHUNK_OVERLAP);
    expect(config.baseUrl).toBeUndefined();
    expect(config.dimensions).toBeUndefined();
  });

  it("reads a stored ollama configuration", () => {
    getSettingDbMock.mockReturnValue({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "nomic-embed-text",
      dimensions: 768,
      chunkSize: 1600,
      chunkOverlap: 160,
    });
    const config = getEmbeddingConfig();
    expect(config.provider).toBe("ollama");
    expect(config.baseUrl).toBe("http://localhost:11434");
    expect(config.model).toBe("nomic-embed-text");
    expect(config.dimensions).toBe(768);
    expect(config.chunkSize).toBe(1600);
    expect(config.chunkOverlap).toBe(160);
  });

  it("rejects unknown providers and clamps chunk values", () => {
    getSettingDbMock.mockReturnValue({
      provider: "bogus",
      chunkSize: 999999,
      chunkOverlap: 8000,
    });
    const config = getEmbeddingConfig();
    expect(config.provider).toBe("server");
    expect(config.chunkSize).toBeLessThanOrEqual(20000);
    expect(config.chunkOverlap).toBeLessThanOrEqual(config.chunkSize / 2);
  });
});

describe("Chunking", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("Short text.", 100, 20)).toEqual(["Short text."]);
  });

  it("returns no chunks for empty text", () => {
    expect(chunkText("   ", 100, 20)).toEqual([]);
  });

  it("splits long text into overlapping chunks", () => {
    const sentences = Array.from(
      { length: 20 },
      (_, i) => `Sentence number ${i} carries some meaning.`
    );
    const text = sentences.join(" ");
    const chunks = chunkText(text, 120, 30);

    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk respects the size bound (sentence-aware packing may
    // slightly exceed when a single sentence is longer, not the case here).
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
    // Consecutive chunks share overlapping content.
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1].slice(-15);
      expect(chunks[i - 1].length).toBeGreaterThan(15);
      // The overlap carries at least some of the previous tail forward.
      const sharesContent =
        chunks[i].includes(prevTail) ||
        prevTail
          .split(" ")
          .slice(-2)
          .every((w) => chunks[i].includes(w));
      expect(sharesContent).toBe(true);
    }
    // All sentence content is preserved across chunks.
    const joined = chunks.join(" ");
    for (let i = 0; i < 20; i++) {
      expect(joined).toContain(`Sentence number ${i}`);
    }
  });

  it("hard-windows a single oversized sentence", () => {
    const text = "x".repeat(500);
    const chunks = chunkText(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("handles sentence length equal to chunkSize without overflowing overlap tail", () => {
    // Sentence exactly equal to chunkSize (100 chars) following a short sentence
    const firstSentence = "First sentence carries some initial context.";
    const exactSentence = "A".repeat(100);
    const text = `${firstSentence} ${exactSentence}`;
    const chunks = chunkText(text, 100, 20);

    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(firstSentence);
    // Crucial invariant: second chunk MUST NOT exceed 100 characters
    expect(chunks[1].length).toBeLessThanOrEqual(100);
    expect(chunks[1]).toBe(exactSentence);
  });
});

describe("Provider routing & chunked embedding", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LLM_BASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("routes to Ollama's native /api/embed endpoint", async () => {
    getSettingDbMock.mockReturnValue({
      provider: "ollama",
      baseUrl: "http://ollama.local",
      model: "nomic-embed-text",
    });

    const vector = [0.1, 0.2, 0.3];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [vector] }),
    } as Response);

    const embedding = await generateEmbedding("hello ollama");
    expect(fetchSpy).toHaveBeenCalledWith("http://ollama.local/api/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", input: ["hello ollama"] }),
      signal: expect.any(AbortSignal),
    });
    expect(embedding!.length).toBe(3);
    expect(embedding![0]).toBeCloseTo(0.1, 5);
  });

  it("routes to an OpenAI-compatible cloud endpoint with API key", async () => {
    getSettingDbMock.mockReturnValue({
      provider: "openai-compatible",
      baseUrl: "https://embed.cloud/v1",
      apiKey: "cloud-key",
      model: "text-embedding-3-small",
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockEmbeddingResponse([0.5, 0.5]));

    await generateEmbedding("hello cloud");
    expect(fetchSpy).toHaveBeenCalledWith("https://embed.cloud/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer cloud-key",
      },
      body: JSON.stringify({
        input: "hello cloud",
        model: "text-embedding-3-small",
      }),
      signal: expect.any(AbortSignal),
    });
  });

  it("chunks long text and mean-pools chunk vectors", async () => {
    getSettingDbMock.mockReturnValue({
      provider: "ollama",
      baseUrl: "http://ollama.local",
      model: "nomic-embed-text",
      chunkSize: 60,
      chunkOverlap: 10,
    });

    const longText = Array.from(
      { length: 12 },
      (_, i) => `Chunkable sentence ${i} with padding words.`
    ).join(" ");

    // Two different unit vectors; the mean pool should blend them.
    const responses = [
      { embeddings: [[1, 0]] },
      { embeddings: [[1, 0]] },
      { embeddings: [[0, 1]] },
      { embeddings: [[0, 1]] },
      { embeddings: [[0, 1]] },
      { embeddings: [[0, 1]] },
      { embeddings: [[0, 1]] },
      { embeddings: [[0, 1]] },
      { embeddings: [[0, 1]] },
      { embeddings: [[0, 1]] },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const next = responses.shift() ?? { embeddings: [[0, 1]] };
      return {
        ok: true,
        status: 200,
        json: async () => next,
      } as Response;
    });

    const embedding = await generateEmbedding(longText);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    expect(embedding!.length).toBe(2);
    // L2-normalized result with both components present.
    const norm = Math.hypot(embedding![0], embedding![1]);
    expect(norm).toBeCloseTo(1, 4);
    expect(embedding![0]).toBeGreaterThan(0);
    expect(embedding![1]).toBeGreaterThan(0);
  });

  it("returns null when all chunks fail", async () => {
    getSettingDbMock.mockReturnValue({
      provider: "ollama",
      baseUrl: "http://ollama.local",
      model: "nomic-embed-text",
      chunkSize: 60,
      chunkOverlap: 10,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "boom",
    } as Response);

    const longText = "Some reasonably long text. ".repeat(10);
    const embedding = await generateEmbedding(longText);
    expect(embedding).toBeNull();
  });
});

describe("Dimension auto-detection", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("detects dimensions from an Ollama endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [new Array(768).fill(0.1)] }),
    } as Response);

    const result = await detectEmbeddingDimensions({
      provider: "ollama",
      baseUrl: "http://ollama.local",
      model: "nomic-embed-text",
    });
    expect(result.dimensions).toBe(768);
    expect(result.model).toBe("nomic-embed-text");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("detects dimensions from an OpenAI-compatible endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockEmbeddingResponse(new Array(1536).fill(0.2))
    );

    const result = await detectEmbeddingDimensions({
      provider: "openai-compatible",
      baseUrl: "https://embed.cloud/v1",
      apiKey: "k",
      model: "text-embedding-3-small",
    });
    expect(result.dimensions).toBe(1536);
  });

  it("throws when the probe fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as Response);

    await expect(
      detectEmbeddingDimensions({
        provider: "ollama",
        baseUrl: "http://ollama.local",
        model: "missing-model",
      })
    ).rejects.toThrow("Embedding probe failed");
  });

  it("falls back to provider-specific default model when none is specified", async () => {
    expect(getDefaultModelForProvider("ollama")).toBe(DEFAULT_OLLAMA_MODEL_ID);
    expect(getDefaultModelForProvider("openai-compatible")).toBe(DEFAULT_OPENAI_MODEL_ID);
    expect(getDefaultModelForProvider("server")).toBe(DEFAULT_OPENAI_MODEL_ID);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [new Array(768).fill(0.1)] }),
    } as Response);

    const result = await detectEmbeddingDimensions({
      provider: "ollama",
      baseUrl: "http://ollama.local",
    });
    expect(result.model).toBe(DEFAULT_OLLAMA_MODEL_ID);
    expect(fetchSpy).toHaveBeenCalledWith("http://ollama.local/api/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: DEFAULT_OLLAMA_MODEL_ID, input: ["Yggdrasil embedding dimension probe"] }),
      signal: expect.any(AbortSignal),
    });
  });

  it("requires a base URL for non-server providers", async () => {
    await expect(
      detectEmbeddingDimensions({ provider: "ollama" })
    ).rejects.toThrow("requires a base URL");
  });

  it("uses the server environment for the server provider", async () => {
    delete process.env.LLM_BASE_URL;
    await expect(
      detectEmbeddingDimensions({ provider: "server" })
    ).rejects.toThrow("no LLM_BASE_URL");
  });
});
