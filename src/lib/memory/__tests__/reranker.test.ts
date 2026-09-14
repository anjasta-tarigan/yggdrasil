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

// The reranker now delegates discovery to store.ts, which imports
// embeddings.ts (for CANONICAL_EMBEDDING_DIR). That transitively loads
// @/lib/ai/provider-config/store, whose secrets module is server-only.
// Mock it here the same way onnx-embedding.test.ts does.
const loadRegistryMock = vi.fn();
const resolveApiKeyMock = vi.fn();
vi.mock("@/lib/ai/provider-config/store", () => ({
  get loadRegistry() {
    return loadRegistryMock;
  },
  get resolveApiKey() {
    return resolveApiKeyMock;
  },
  getProviderById: vi.fn(),
  getRegistryView: vi.fn(),
  saveRegistry: vi.fn(),
  ProviderConfigError: class extends Error {
    name = "ProviderConfigError";
  },
}));

import {
  rerankCandidates,
  isRerankerLoaded,
  setModelPathResolverForTest,
  setRerankerDbSettingResolverForTest,
  setDiscoveredModelsResolverForTest,
  getRerankerStatus,
  isRerankerEnabled,
  resolveRerankerModelPath,
  discoverRerankerModels,
  CANONICAL_RERANKER_DIR,
  CANONICAL_MODEL_PATH,
  DEFAULT_RERANKER_FILENAME,
} from "../reranker";
import { setOrtLoaderForTest } from "../onnx-session";
import * as envModule from "@/env";
import path from "node:path";
import fs from "node:fs";

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
      Tensor: MockTensor as unknown as new (type: string, data: unknown, dims: readonly number[]) => import("../onnx-session").OrtTensor,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setOrtLoaderForTest(null);
    setModelPathResolverForTest(null);
    setRerankerDbSettingResolverForTest(null);
    setDiscoveredModelsResolverForTest(null);
    // Reset shared ONNX session state between tests.
    const g = globalThis as unknown as Record<string, unknown>;
    delete g["__yggdrasilOnnxSessions"];
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
      setDiscoveredModelsResolverForTest(() => []);

      const status = getRerankerStatus();
      expect(status.mode).toBe("fallback");
      expect(status.enabled).toBe(true);
      expect(status.available).toBe(false);
      expect(status.modelPath).toBeNull();
      expect(status.discoveredModels).toEqual([]);
    });

    it("reports standby when model file exists but session is not in memory", () => {
      (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
      setModelPathResolverForTest(() => "/mock-model.onnx");

      const status = getRerankerStatus();
      expect(status.mode).toBe("standby");
      expect(status.available).toBe(true);
      expect(status.loaded).toBe(false);
      expect(status.modelPath).toBe("/mock-model.onnx");
      expect(Array.isArray(status.discoveredModels)).toBe(true);
    });

    it("reports active when model is available and session is loaded in memory", async () => {
      (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
      (envModule.env as Record<string, unknown>).RERANKER_MODEL_PATH = "/mock-model.onnx";
      setModelPathResolverForTest(() => "/mock-model.onnx");

      const mockSession = {
        run: vi.fn().mockResolvedValue({
          logits: { data: new Float32Array([0.8]) },
        }),
        release: vi.fn().mockResolvedValue(undefined),
      };
      mockSessionCreate.mockResolvedValue(mockSession);

      await rerankCandidates("query", [CANDIDATES[0]]);

      const status = getRerankerStatus();
      expect(status.mode).toBe("active");
      expect(status.loaded).toBe(true);
      expect(status.available).toBe(true);
    });

    it("includes discovered models in the status report", () => {
      (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
      setModelPathResolverForTest(() => "/mock-model.onnx");
      setDiscoveredModelsResolverForTest(() => [
        {
          filename: "bge-reranker-v2-m3-int8.onnx",
          path: "/path/bge.onnx",
          sizeBytes: 550_000_000,
          isDefault: true,
        },
        {
          filename: "custom-reranker.onnx",
          path: "/path/custom.onnx",
          sizeBytes: 600_000_000,
          isDefault: false,
        },
      ]);

      const status = getRerankerStatus();
      expect(status.discoveredModels).toEqual([
        { filename: "bge-reranker-v2-m3-int8.onnx", sizeBytes: 550_000_000 },
        { filename: "custom-reranker.onnx", sizeBytes: 600_000_000 },
      ]);
    });

    it("reports discovered models even when reranker is disabled", () => {
      (envModule.env as Record<string, unknown>).RERANKER_ENABLED = false;
      setDiscoveredModelsResolverForTest(() => [
        {
          filename: "model-a.onnx",
          path: "/path/model-a.onnx",
          sizeBytes: 100_000_000,
          isDefault: false,
        },
      ]);

      const status = getRerankerStatus();
      expect(status.mode).toBe("disabled");
      expect(status.enabled).toBe(false);
      expect(status.discoveredModels).toEqual([
        { filename: "model-a.onnx", sizeBytes: 100_000_000 },
      ]);
    });

    it("auto-detects model from data/models/reranker via discoveredModels and reports standby", () => {
      (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
      setModelPathResolverForTest(null);
      setRerankerDbSettingResolverForTest(() => null);
      setDiscoveredModelsResolverForTest(() => [
        {
          filename: "discovered-model.onnx",
          path: path.join(CANONICAL_RERANKER_DIR, "discovered-model.onnx"),
          sizeBytes: 80_000_000,
          isDefault: false,
        },
      ]);

      const status = getRerankerStatus();
      expect(status.mode).toBe("standby");
      expect(status.available).toBe(true);
      expect(status.modelPath).toBe(
        path.join(CANONICAL_RERANKER_DIR, "discovered-model.onnx")
      );
      expect(status.discoveredModels).toEqual([
        { filename: "discovered-model.onnx", sizeBytes: 80_000_000 },
      ]);
    });
  });

  describe("canonical paths and auto-discovery", () => {
    it("exports canonical directory under data/models/reranker and default model path", () => {
      expect(CANONICAL_RERANKER_DIR).toBe(
        path.resolve(process.cwd(), "data/models/reranker")
      );
      expect(CANONICAL_MODEL_PATH).toBe(
        path.join(CANONICAL_RERANKER_DIR, "bge-reranker-v2-m3-int8.onnx")
      );
      expect(DEFAULT_RERANKER_FILENAME).toBe("bge-reranker-v2-m3-int8.onnx");
      expect(CANONICAL_RERANKER_DIR.endsWith(path.join("data", "models", "reranker"))).toBe(true);
    });

    it("discoverRerankerModels returns empty array when directory does not exist", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      const models = discoverRerankerModels();
      expect(models).toEqual([]);
    });

    it("discoverRerankerModels returns custom discovered models when resolver is set", () => {
      const customModels = [
        {
          filename: "test.onnx",
          path: "/test.onnx",
          sizeBytes: 123456789,
          isDefault: true,
        },
      ];
      setDiscoveredModelsResolverForTest(() => customModels);
      expect(discoverRerankerModels()).toEqual(customModels);
    });

    it("discoverRerankerModels filters non-onnx files and files under 50MB", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readdirSync").mockReturnValue([
        { name: "bge-reranker-v2-m3-int8.onnx", isFile: () => true },
        { name: "other-model.onnx", isFile: () => true },
        { name: "tiny-stub.onnx", isFile: () => true },
        { name: "config.json", isFile: () => true },
        { name: "nested-dir.onnx", isFile: () => false },
      ] as unknown as never);
      vi.spyOn(fs, "statSync").mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.endsWith("bge-reranker-v2-m3-int8.onnx")) {
          return { size: 550 * 1024 * 1024, isFile: () => true } as fs.Stats;
        }
        if (p.endsWith("other-model.onnx")) {
          return { size: 60 * 1024 * 1024, isFile: () => true } as fs.Stats;
        }
        if (p.endsWith("tiny-stub.onnx")) {
          return { size: 1024, isFile: () => true } as fs.Stats;
        }
        return { size: 0, isFile: () => true } as fs.Stats;
      });

      const models = discoverRerankerModels();
      expect(models).toHaveLength(2);
      expect(models[0]).toEqual({
        filename: "bge-reranker-v2-m3-int8.onnx",
        path: path.join(CANONICAL_RERANKER_DIR, "bge-reranker-v2-m3-int8.onnx"),
        sizeBytes: 550 * 1024 * 1024,
        isDefault: true,
      });
      expect(models[1]).toEqual({
        filename: "other-model.onnx",
        path: path.join(CANONICAL_RERANKER_DIR, "other-model.onnx"),
        sizeBytes: 60 * 1024 * 1024,
        isDefault: false,
      });
    });

    it("discoverRerankerModels sorts default model first then alphabetical", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readdirSync").mockReturnValue([
        { name: "zebra.onnx", isFile: () => true },
        { name: "alpha.onnx", isFile: () => true },
        { name: DEFAULT_RERANKER_FILENAME, isFile: () => true },
        { name: "beta.onnx", isFile: () => true },
      ] as unknown as never);
      vi.spyOn(fs, "statSync").mockReturnValue({
        size: 60 * 1024 * 1024,
        isFile: () => true,
      } as fs.Stats);

      const models = discoverRerankerModels();
      expect(models.map((m) => m.filename)).toEqual([
        DEFAULT_RERANKER_FILENAME,
        "alpha.onnx",
        "beta.onnx",
        "zebra.onnx",
      ]);
      expect(models[0].isDefault).toBe(true);
      expect(models[1].isDefault).toBe(false);
    });

    it("discoverRerankerModels handles statSync error gracefully for inaccessible files", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readdirSync").mockReturnValue([
        { name: "vanished.onnx", isFile: () => true },
        { name: "valid.onnx", isFile: () => true },
      ] as unknown as never);
      vi.spyOn(fs, "statSync").mockImplementation((filePath) => {
        if (String(filePath).endsWith("vanished.onnx")) {
          throw new Error("ENOENT: no such file or directory");
        }
        return { size: 60 * 1024 * 1024, isFile: () => true } as fs.Stats;
      });

      const models = discoverRerankerModels();
      expect(models).toHaveLength(1);
      expect(models[0].filename).toBe("valid.onnx");
    });

    it("discoverRerankerModels handles readdirSync error gracefully", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readdirSync").mockImplementation(() => {
        throw new Error("EACCES: permission denied");
      });

      const models = discoverRerankerModels();
      expect(models).toEqual([]);
    });
  });

  describe("database setting integration and model resolution", () => {
    it("isRerankerEnabled checks both env and db setting", () => {
      (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
      setRerankerDbSettingResolverForTest(() => ({ enabled: false }));
      expect(isRerankerEnabled()).toBe(false);

      setRerankerDbSettingResolverForTest(() => ({ enabled: true }));
      expect(isRerankerEnabled()).toBe(true);

      (envModule.env as Record<string, unknown>).RERANKER_ENABLED = false;
      setRerankerDbSettingResolverForTest(() => ({ enabled: true }));
      expect(isRerankerEnabled()).toBe(false);
    });

    it("picks the first discovered model when no selectedModel is configured", () => {
      setModelPathResolverForTest(null);
      setRerankerDbSettingResolverForTest(() => null);
      setDiscoveredModelsResolverForTest(() => [
        {
          filename: "model-a.onnx",
          path: "/path/to/model-a.onnx",
          sizeBytes: 100_000_000,
          isDefault: false,
        },
      ]);

      const resolved = resolveRerankerModelPath();
      expect(resolved).toBe("/path/to/model-a.onnx");
    });

    it("resolves relative selectedModel inside data/models/reranker/ directory", () => {
      setModelPathResolverForTest(null);
      setRerankerDbSettingResolverForTest(() => ({
        selectedModel: "custom-relative.onnx",
      }));

      vi.spyOn(fs, "statSync").mockImplementation((filePath) => {
        if (
          String(filePath) ===
          path.join(CANONICAL_RERANKER_DIR, "custom-relative.onnx")
        ) {
          return { size: 60 * 1024 * 1024, isFile: () => true } as fs.Stats;
        }
        return { size: 0, isFile: () => false } as fs.Stats;
      });

      const resolved = resolveRerankerModelPath();
      expect(resolved).toBe(
        path.join(CANONICAL_RERANKER_DIR, "custom-relative.onnx")
      );
    });

    it("resolves absolute selectedModel path when valid", () => {
      setModelPathResolverForTest(null);
      setRerankerDbSettingResolverForTest(() => ({
        selectedModel: "/opt/models/my-custom.onnx",
      }));

      vi.spyOn(fs, "statSync").mockImplementation((filePath) => {
        if (String(filePath) === "/opt/models/my-custom.onnx") {
          return { size: 60 * 1024 * 1024, isFile: () => true } as fs.Stats;
        }
        return { size: 0, isFile: () => false } as fs.Stats;
      });

      const resolved = resolveRerankerModelPath();
      expect(resolved).toBe("/opt/models/my-custom.onnx");
    });

    it("falls back to CANONICAL_MODEL_PATH in data/models/reranker/ when present and valid", () => {
      setModelPathResolverForTest(null);
      setRerankerDbSettingResolverForTest(() => null);
      setDiscoveredModelsResolverForTest(() => []);

      vi.spyOn(fs, "statSync").mockImplementation((filePath) => {
        if (String(filePath) === CANONICAL_MODEL_PATH) {
          return { size: 550 * 1024 * 1024, isFile: () => true } as fs.Stats;
        }
        return { size: 0, isFile: () => false } as fs.Stats;
      });

      const resolved = resolveRerankerModelPath();
      expect(resolved).toBe(CANONICAL_MODEL_PATH);
    });

    it("switches sessions cleanly when modelPath changes", async () => {
      (envModule.env as Record<string, unknown>).RERANKER_ENABLED = true;
      (envModule.env as Record<string, unknown>).RERANKER_MODEL_PATH = "/model-1.onnx";

      const mockSession1 = {
        run: vi.fn().mockResolvedValue({ logits: { data: new Float32Array([1.0]) } }),
        release: vi.fn().mockResolvedValue(undefined),
      };
      const mockSession2 = {
        run: vi.fn().mockResolvedValue({ logits: { data: new Float32Array([2.0]) } }),
        release: vi.fn().mockResolvedValue(undefined),
      };

      mockSessionCreate
        .mockResolvedValueOnce(mockSession1)
        .mockResolvedValueOnce(mockSession2);

      setModelPathResolverForTest(() => "/model-1.onnx");
      await rerankCandidates("q", [CANDIDATES[0]]);
      expect(mockSessionCreate).toHaveBeenCalledWith(
        "/model-1.onnx",
        expect.any(Object)
      );

      // Now switch model path to /model-2.onnx
      setModelPathResolverForTest(() => "/model-2.onnx");
      await rerankCandidates("q", [CANDIDATES[0]]);

      // Previous session released
      expect(mockSession1.release).toHaveBeenCalledOnce();
      // New session created for model-2
      expect(mockSessionCreate).toHaveBeenCalledWith(
        "/model-2.onnx",
        expect.any(Object)
      );
      expect(mockSessionCreate).toHaveBeenCalledTimes(2);
    });
  });
});
