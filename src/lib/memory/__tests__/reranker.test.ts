import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RerankCandidate } from "../reranker";

// Mock onnxruntime-node as a string specifier so tests never touch native binaries
// and pass even when the optional package is not installed.
const mockSessionCreate = vi.fn();
function MockTensor(this: { type: string; data: unknown; dims: readonly number[] }, type: string, data: unknown, dims: readonly number[]) {
  this.type = type;
  this.data = data;
  this.dims = dims;
}

vi.mock("onnxruntime-node", () => ({
  InferenceSession: {
    create: mockSessionCreate,
  },
  Tensor: MockTensor,
}));

// Controllable env vars for the reranker.
vi.mock("@/env", () => ({
  env: {
    RERANKER_ENABLED: false,
    RERANKER_MODEL_PATH: undefined,
    RERANKER_IDLE_TIMEOUT_MS: 120_000,
    RERANKER_CANDIDATE_WINDOW: 30,
  },
}));

import {
  rerankCandidates,
  isRerankerLoaded,
  setOrtLoaderForTest,
  setModelPathResolverForTest,
  getRerankerStatus,
  CANONICAL_MODEL_PATH,
} from "../reranker";
import * as envModule from "@/env";

const CANDIDATES: RerankCandidate[] = [
  { id: "a", content: "JWT authentication tokens for API security" },
  { id: "b", content: "How to bake sourdough bread at home" },
  { id: "c", content: "OAuth2 flow with refresh tokens and scopes" },
];

describe("rerankCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setModelPathResolverForTest(() => "/mock-model.onnx");
    setOrtLoaderForTest(async () => ({
      InferenceSession: {
        create: mockSessionCreate,
      },
      Tensor: MockTensor as unknown as new (type: string, data: unknown, dims: readonly number[]) => import("../reranker").OrtTensor,
    }));
  });

  afterEach(() => {
    setOrtLoaderForTest(null);
    setModelPathResolverForTest(null);
    // Reset global session state between tests.
    const g = globalThis as unknown as Record<string, unknown>;
    delete g["__yggdrasilReranker"];
  });

  it("returns null when RERANKER_ENABLED is false", async () => {
    (envModule.env as Record<string, unknown>).RERANKER_ENABLED = false;
    const result = await rerankCandidates("API security", CANDIDATES);
    expect(result).toBeNull();
  });

  it("returns null when model file is not resolved on disk", async () => {
    (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
    setModelPathResolverForTest(() => null);

    const result = await rerankCandidates("API security", CANDIDATES);
    expect(result).toBeNull();
  });

  it("returns empty array for empty candidates", async () => {
    (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
    (envModule.env as Record<string, unknown>).RERANKER_MODEL_PATH = "/model.onnx";

    // Mock a session that would succeed — candidates list is empty so run is never called.
    const mockSession = {
      run: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
    };
    mockSessionCreate.mockResolvedValue(mockSession);

    const result = await rerankCandidates("API security", []);
    expect(result).toEqual([]);
    expect(mockSession.run).not.toHaveBeenCalled();
  });

  it("scores and sorts candidates by relevance logit", async () => {
    (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
    (envModule.env as Record<string, unknown>).RERANKER_MODEL_PATH = "/model.onnx";

    // Simulate: "a" most relevant (logit 2.0), "c" next (logit 1.5), "b" least (logit -1.0).
    const logitMap: Record<string, number> = { a: 2.0, c: 1.5, b: -1.0 };
    let callIdx = 0;
    const callOrder = ["a", "c", "b"]; // iteration order from CANDIDATES array

    const mockSession = {
      run: vi.fn().mockImplementation(async () => {
        const id = callOrder[callIdx++] ?? "a";
        const logit = logitMap[id] ?? 0;
        const logitsData = new Float32Array([logit]);
        return {
          logits: { data: logitsData },
        };
      }),
      release: vi.fn().mockResolvedValue(undefined),
    };
    mockSessionCreate.mockResolvedValue(mockSession);

    // Reset callIdx; mock run is called in CANDIDATES array order [a, b, c].
    callIdx = 0;
    const callOrderActual = ["a", "b", "c"];
    mockSession.run.mockImplementation(async () => {
      const id = callOrderActual[callIdx++] ?? "a";
      const logit = logitMap[id] ?? 0;
      return { logits: { data: new Float32Array([logit]) } };
    });

    const result = await rerankCandidates("API security tokens", CANDIDATES);

    expect(result).not.toBeNull();
    // Sorted by score descending: a (2.0) > c (1.5) > b (-1.0)
    expect(result![0].id).toBe("a");
    expect(result![1].id).toBe("c");
    expect(result![2].id).toBe("b");
    // Scores are sigmoid-transformed — all should be in [0, 1].
    for (const r of result!) {
      expect(r.rerankScore).toBeGreaterThanOrEqual(0);
      expect(r.rerankScore).toBeLessThanOrEqual(1);
    }
    expect(result![0].rerankScore).toBeGreaterThan(result![1].rerankScore);
  });

  it("returns null and releases session on inference failure", async () => {
    (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
    (envModule.env as Record<string, unknown>).RERANKER_MODEL_PATH = "/model.onnx";

    const mockSession = {
      run: vi.fn().mockRejectedValue(new Error("ORT inference error")),
      release: vi.fn().mockResolvedValue(undefined),
    };
    mockSessionCreate.mockResolvedValue(mockSession);

    const result = await rerankCandidates("API security", CANDIDATES);
    // Inference failure → null (caller preserves RRF order).
    expect(result).toBeNull();
    // Session must be released to reclaim native ORT memory.
    expect(mockSession.release).toHaveBeenCalledOnce();
  });

  it("reuses the loaded session without reloading on subsequent calls", async () => {
    (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
    (envModule.env as Record<string, unknown>).RERANKER_MODEL_PATH = "/model.onnx";

    const mockSession = {
      run: vi.fn().mockResolvedValue({
        logits: { data: new Float32Array([1.0]) },
      }),
      release: vi.fn().mockResolvedValue(undefined),
    };
    mockSessionCreate.mockResolvedValue(mockSession);

    await rerankCandidates("query one", [CANDIDATES[0]]);
    await rerankCandidates("query two", [CANDIDATES[1]]);

    // InferenceSession.create should only have been called once.
    expect(mockSessionCreate).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent initialization so only one session is created", async () => {
    (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
    (envModule.env as Record<string, unknown>).RERANKER_MODEL_PATH = "/model.onnx";

    const mockSession = {
      run: vi.fn().mockResolvedValue({
        logits: { data: new Float32Array([1.0]) },
      }),
      release: vi.fn().mockResolvedValue(undefined),
    };
    // Add artificial micro-delay to ensure concurrency window
    mockSessionCreate.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return mockSession;
    });

    const [res1, res2] = await Promise.all([
      rerankCandidates("concurrent 1", [CANDIDATES[0]]),
      rerankCandidates("concurrent 2", [CANDIDATES[1]]),
    ]);

    expect(res1).not.toBeNull();
    expect(res2).not.toBeNull();
    expect(mockSessionCreate).toHaveBeenCalledOnce();
  });

  it("isRerankerLoaded reflects session lifecycle", async () => {
    (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
    (envModule.env as Record<string, unknown>).RERANKER_MODEL_PATH = "/model.onnx";

    expect(isRerankerLoaded()).toBe(false);

    const mockSession = {
      run: vi.fn().mockResolvedValue({
        logits: { data: new Float32Array([0.5]) },
      }),
      release: vi.fn().mockResolvedValue(undefined),
    };
    mockSessionCreate.mockResolvedValue(mockSession);

    await rerankCandidates("query", [CANDIDATES[0]]);
    expect(isRerankerLoaded()).toBe(true);
  });

  describe("getRerankerStatus", () => {
    it("reports disabled when RERANKER_ENABLED is false", () => {
      (envModule.env as Record<string, unknown>).RERANKER_ENABLED = false;
      const status = getRerankerStatus();
      expect(status.mode).toBe("disabled");
      expect(status.enabled).toBe(false);
      expect(status.canonicalPath).toBe(CANONICAL_MODEL_PATH);
    });

    it("reports fallback when model file is not resolved on disk", () => {
      (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
      setModelPathResolverForTest(() => null);

      const status = getRerankerStatus();
      expect(status.mode).toBe("fallback");
      expect(status.enabled).toBe(true);
      expect(status.available).toBe(false);
      expect(status.modelPath).toBeNull();
    });

    it("reports standby when model file exists but session is not in memory", () => {
      (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
      setModelPathResolverForTest(() => "/mock-model.onnx");

      const status = getRerankerStatus();
      expect(status.mode).toBe("standby");
      expect(status.available).toBe(true);
      expect(status.loaded).toBe(false);
      expect(status.modelPath).toBe("/mock-model.onnx");
    });
  });
});
