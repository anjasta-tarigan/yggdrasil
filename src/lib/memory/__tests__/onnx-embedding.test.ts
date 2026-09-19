import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Mock the shared ONNX session module: tests never touch native binaries and
// pass even when the optional onnxruntime-node package is absent.
const mockSessionCreate = vi.fn();
function MockTensor(
  this: { type: string; data: unknown; dims: readonly number[] },
  type: string,
  data: unknown,
  dims: readonly number[]
) {
  this.type = type;
  this.data = data;
  this.dims = dims;
}

const mockAcquire = vi.fn();
const mockRelease = vi.fn();
const mockIsLoaded = vi.fn();

vi.mock("../onnx-session", () => ({
  acquireOnnxSession: (...args: unknown[]) => mockAcquire(...args),
  releaseOnnxSession: (...args: unknown[]) => mockRelease(...args),
  releaseAllOnnxSessions: vi.fn(),
  isOnnxSessionLoaded: (...args: unknown[]) => mockIsLoaded(...args),
  ONNX_SLOT_EMBEDDING: "embedding",
  ONNX_SLOT_RERANKER: "reranker",
  loadOrt: vi.fn(async () => ({
    InferenceSession: { create: mockSessionCreate },
    Tensor: MockTensor,
  })),
  setOrtLoaderForTest: vi.fn(),
}));

// Controllable env for the ONNX embedding tunables.
vi.mock("@/env", () => ({
  env: {
    EMBEDDING_FETCH_TIMEOUT_MS: 5000,
    EMBEDDING_MODEL_ID: undefined,
    EMBEDDING_ONNX_DIR: undefined,
    EMBEDDING_ONNX_IDLE_TIMEOUT_MS: 120_000,
  },
}));

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

/**
 * A WordPiece tokenizer.json served to the tokenizer reader. It is installed
 * via `vi.spyOn` (per-test, undone by `restoreAllMocks`) — NOT `vi.mock` on
 * `node:fs`, which is worker-permanent and leaks into every other test file
 * sharing the worker, hanging suites that read real files.
 */
const TOKENIZER_FIXTURE = JSON.stringify({
  model: {
    type: "WordPiece",
    unk_token: "[UNK]",
    continuing_subword_prefix: "##",
    max_input_chars_per_word: 100,
    vocab: {
      "[PAD]": 0,
      "[UNK]": 100,
      "[CLS]": 101,
      "[SEP]": 102,
      hello: 7592,
      world: 2088,
      chunkable: 4001,
      sentence: 4002,
      with: 4003,
      padding: 4004,
      words: 4005,
      a: 4006,
      b: 4007,
      c: 4008,
      probe: 4009,
      onnx: 4010,
    },
  },
});

/** Pooling config fixture, keyed by the mode it declares. */
function poolingFixture(mode: "mean" | "cls" | "lasttoken" | "max") {
  return JSON.stringify({ [`pooling_mode_${mode}_tokens`]: true });
}

/** Captured before any spy is installed, so fall-through stays genuine. */
const realReadSync = fs.readFileSync.bind(fs);

/** Normalise the several PathLike shapes `readFileSync` accepts to a string key. */
function readSyncKey(p: unknown): string {
  if (typeof p === "string") return p;
  if (p instanceof URL) return p.pathname;
  return String(p);
}

/**
 * Serve `readFileSync` from a path → content map. Unlisted paths fall through
 * to the real filesystem **with the original argument untouched**.
 *
 * The untouched argument matters: this spy is process-wide, so it also
 * intercepts Vitest's own ESM loader, which calls `readFileSync(new URL(...))`.
 * Coercing that URL to a string (e.g. `String(p)` → `file:///…`) would hand
 * Node a literal path that does not exist and crash module loading.
 */
function serveFiles(files: Record<string, string>) {
  vi.spyOn(fs, "readFileSync").mockImplementation(((p: unknown, enc?: unknown) => {
    if (readSyncKey(p) in files) return files[readSyncKey(p)];
    return realReadSync(p as never, enc as never);
  }) as typeof fs.readFileSync);
}

import {
  generateEmbedding,
  detectEmbeddingDimensions,
  discoverEmbeddingModels,
  resolveEmbeddingOnnxPath,
  getOnnxEmbeddingStatus,
  clearTokenizerCacheForTest,
  clearEmbeddingCacheForTest,
  CANONICAL_EMBEDDING_DIR,
} from "../embeddings";
import type { OrtSession } from "../onnx-session";
import { saveEmbeddingSettings } from "@/lib/settings";
import type { RegistryDocument } from "@/lib/ai/provider-config/schema";

const MODEL_FILENAME = "bge-small-en-v1.5.onnx";
const MODEL_PATH = path.join(CANONICAL_EMBEDDING_DIR, MODEL_FILENAME);
const MODEL_SIZE = 60 * 1024 * 1024;

/** Registry doc whose embedding block selects the local ONNX provider. */
function onnxRegistryDoc(modelPath: string): RegistryDocument {
  return {
    version: 1,
    providers: [],
    embedding: {
      provider: "onnx",
      providerId: null,
      modelPath,
      dimensions: 384,
      chunkSize: 2000,
      chunkOverlap: 200,
    },
  };
}

/**
 * Session whose `run` returns a pooled sentence vector of `dim` entries.
 * `inputNames` mirrors what a real ORT session exposes — the embedding path
 * builds its feeds from the graph's declared inputs, so a mock without it
 * would silently feed nothing.
 */
function mockEmbeddingSession(dim = 4, inputNames = ["input_ids", "attention_mask"]) {
  return {
    inputNames,
    outputNames: ["sentence_embedding"],
    run: vi.fn(async () => ({
      sentence_embedding: { data: new Float32Array(dim).fill(0.5) },
    })),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ONNX embedding provider", () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearTokenizerCacheForTest();
    // The LRU is module-level; without this, a vector cached by an earlier
    // test is served for the same text and the assertion never runs.
    clearEmbeddingCacheForTest();
    process.env = { ...originalEnv };
    loadRegistryMock.mockResolvedValue({
      version: 1,
      providers: [],
      embedding: undefined,
    });
    resolveApiKeyMock.mockResolvedValue(undefined);
    // Default: a tokenizer.json sits beside the model, and no pooling config
    // exists (so pooling resolution falls through to the user-selection tier).
    serveFiles({
      [path.join(CANONICAL_EMBEDDING_DIR, "tokenizer.json")]: TOKENIZER_FIXTURE,
    });
    // Default: a valid model file exists on disk. Only the .onnx path has a
    // size — the external-data sibling (`<file>_data`) must ENOENT, or its
    // size would be double-counted into the model's effective size.
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      { name: MODEL_FILENAME, isFile: () => true, isDirectory: () => false },
    ] as unknown as never);
    vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (String(p).endsWith(".onnx")) {
        return { size: MODEL_SIZE, isFile: () => true } as fs.Stats;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockAcquire.mockResolvedValue(mockEmbeddingSession());
    mockIsLoaded.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("auto-discovery", () => {
    it("scans data/models/embedding for .onnx files >= 50 MB", async () => {
      const models = await discoverEmbeddingModels();
      expect(models).toHaveLength(1);
      expect(models[0]).toEqual({
        filename: MODEL_FILENAME,
        path: MODEL_PATH,
        sizeBytes: MODEL_SIZE,
      });
      expect(CANONICAL_EMBEDDING_DIR.endsWith(
        path.join("data", "models", "embedding")
      )).toBe(true);
    });

    it("filters non-onnx files and undersized stubs", async () => {
      vi.spyOn(fs, "readdirSync").mockImplementation(((p: unknown) => {
        const dir = String(p);
        // A nested folder with no .onnx files must contribute nothing.
        if (dir.endsWith("empty-dir")) {
          return [
            { name: "config.json", isFile: () => true, isDirectory: () => false },
          ];
        }
        return [
          { name: "real.onnx", isFile: () => true, isDirectory: () => false },
          { name: "tiny.onnx", isFile: () => true, isDirectory: () => false },
          { name: "config.json", isFile: () => true, isDirectory: () => false },
          { name: "empty-dir", isFile: () => false, isDirectory: () => true },
        ];
      }) as unknown as never);
      vi.spyOn(fs, "statSync").mockImplementation((p) => {
        const name = String(p);
        if (name.endsWith("tiny.onnx")) {
          return { size: 1024, isFile: () => true } as fs.Stats;
        }
        if (name.endsWith(".onnx")) {
          return { size: MODEL_SIZE, isFile: () => true } as fs.Stats;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const models = await discoverEmbeddingModels();
      expect(models.map((m) => m.filename)).toEqual(["real.onnx"]);
    });

    it("returns [] when the directory does not exist", async () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      expect(await discoverEmbeddingModels()).toEqual([]);
    });

    it("returns [] when readdirSync throws", async () => {
      vi.spyOn(fs, "readdirSync").mockImplementation(() => {
        throw new Error("EACCES");
      });
      expect(await discoverEmbeddingModels()).toEqual([]);
    });

    it("skips files whose statSync throws (vanished mid-scan)", async () => {
      vi.spyOn(fs, "readdirSync").mockReturnValue([
        { name: "gone.onnx", isFile: () => true, isDirectory: () => false },
        { name: "kept.onnx", isFile: () => true, isDirectory: () => false },
      ] as unknown as never);
      vi.spyOn(fs, "statSync").mockImplementation((p) => {
        const name = String(p);
        if (name.endsWith("gone.onnx")) throw new Error("ENOENT");
        if (name.endsWith(".onnx")) {
          return { size: MODEL_SIZE, isFile: () => true } as fs.Stats;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      expect((await discoverEmbeddingModels()).map((m) => m.filename)).toEqual([
        "kept.onnx",
      ]);
    });

    it("finds models one level deep (the HF onnx/ layout)", async () => {
      // Most repos put the graph in onnx/, so a top-level-only scan misses
      // nearly every real download.
      vi.spyOn(fs, "readdirSync").mockImplementation(((p: unknown) => {
        const dir = String(p);
        if (dir.endsWith("embedding")) {
          return [
            { name: "onnx", isFile: () => false, isDirectory: () => true },
            { name: "tokenizer.json", isFile: () => true, isDirectory: () => false },
          ];
        }
        if (dir.endsWith("onnx")) {
          return [
            { name: "model.onnx", isFile: () => true, isDirectory: () => false },
            { name: "model.onnx_data", isFile: () => true, isDirectory: () => false },
          ];
        }
        return [];
      }) as unknown as never);
      vi.spyOn(fs, "statSync").mockImplementation((p) => {
        const name = String(p);
        if (name.endsWith(".onnx")) {
          return { size: MODEL_SIZE, isFile: () => true } as fs.Stats;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      // The store's manifest-gate requires a manifest.json inside the onnx/
      // subdir for the model to be discovered (half-finished installs stay hidden).
      serveFiles({
        [path.join(CANONICAL_EMBEDDING_DIR, "onnx", "manifest.json")]:
          JSON.stringify({
            schemaVersion: 1,
            repo: "test/onnx-model",
            kind: "embedding",
            variant: "model.onnx",
            files: ["model.onnx", "model.onnx_data"],
            sizeBytes: MODEL_SIZE,
            installedAt: new Date().toISOString(),
          }),
      });

      const models = await discoverEmbeddingModels();
      expect(models.map((m) => m.filename)).toEqual(["onnx/model.onnx"]);
    });

    it("counts external-data weights toward the model size", async () => {
      // BGE-m3: a 607 KB graph plus a multi-GB .onnx_data file. Measuring the
      // graph alone would reject it as a stub.
      vi.spyOn(fs, "statSync").mockImplementation((p) => {
        const name = String(p);
        if (name.endsWith(".onnx_data")) {
          return { size: 2_200_000_000, isFile: () => true } as fs.Stats;
        }
        if (name.endsWith(".onnx")) {
          return { size: 607_298, isFile: () => true } as fs.Stats;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const models = await discoverEmbeddingModels();
      expect(models).toHaveLength(1);
      expect(models[0].sizeBytes).toBeGreaterThan(50 * 1024 * 1024);
    });

    it("accepts models between 10 MB and 50 MB (lowered size threshold)", async () => {
      vi.spyOn(fs, "readdirSync").mockReturnValue([
        {
          name: "small-quantized-model.onnx",
          isFile: () => true,
          isDirectory: () => false,
        },
      ] as unknown as never);
      vi.spyOn(fs, "statSync").mockImplementation((p) => {
        const name = String(p);
        if (name.endsWith("small-quantized-model.onnx")) {
          // 25 MB file should now be considered valid
          return { size: 25 * 1024 * 1024, isFile: () => true } as fs.Stats;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      expect(
        (await discoverEmbeddingModels()).some(
          (m) => m.filename === "small-quantized-model.onnx"
        )
      ).toBe(true);
    });
  });

  describe("path resolution", () => {
    it("resolves an absolute modelPath when valid", async () => {
      expect(await resolveEmbeddingOnnxPath("/opt/models/e.onnx")).toBe(
        "/opt/models/e.onnx"
      );
    });

    it("resolves a bare filename inside the canonical directory", async () => {
      expect(await resolveEmbeddingOnnxPath(MODEL_FILENAME)).toBe(MODEL_PATH);
    });

    it("auto-discovers the first model when no path is configured", async () => {
      expect(await resolveEmbeddingOnnxPath()).toBe(MODEL_PATH);
    });

    it("returns null when nothing valid is on disk", async () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      vi.spyOn(fs, "statSync").mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });
      expect(await resolveEmbeddingOnnxPath()).toBeNull();
      expect(await resolveEmbeddingOnnxPath("missing.onnx")).toBeNull();
    });

    it("does not substitute a different discovered model for an invalid explicit path", async () => {
      // A misconfigured or broken (stub) explicit path must be reported as
      // unavailable — never silently replaced by the first discovered model,
      // which would embed (and report status for) a provider the user did not
      // select. Auto-discovery only applies when NO explicit path is given.
      vi.spyOn(fs, "statSync").mockImplementation((p) => {
        const name = String(p);
        if (name.includes("stub.onnx")) {
          return { size: 100, isFile: () => true } as fs.Stats;
        }
        if (name.endsWith(".onnx")) {
          return { size: MODEL_SIZE, isFile: () => true } as fs.Stats;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      // The discovered default IS valid here — we must still not fall back to it.
      expect(await resolveEmbeddingOnnxPath("stub.onnx")).toBeNull();
    });

    it("still auto-discovers when no explicit path is given", async () => {
      vi.spyOn(fs, "statSync").mockImplementation((p) => {
        if (String(p).endsWith(".onnx")) {
          return { size: MODEL_SIZE, isFile: () => true } as fs.Stats;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      expect(await resolveEmbeddingOnnxPath()).toBe(MODEL_PATH);
    });
  });

  describe("status reporting", () => {
    it("reports the resolved path, load state, and discovered models", async () => {
      mockIsLoaded.mockReturnValue(true);
      const status = await getOnnxEmbeddingStatus(MODEL_FILENAME);
      expect(status.modelPath).toBe(MODEL_PATH);
      expect(status.loaded).toBe(true);
      expect(status.discoveredModels).toEqual([
        { filename: MODEL_FILENAME, sizeBytes: MODEL_SIZE },
      ]);
    });

    it("reports null modelPath (no silent fallback) when the configured path is invalid", async () => {
      // The configured path is a stub (below the size threshold) while a
      // *different* valid model is discoverable on disk. getOnnxEmbeddingStatus
      // must NOT substitute the discovered model — it reports the configured
      // file as unavailable so the footer surfaces the real misconfiguration
      // instead of another provider's repo.
      vi.spyOn(fs, "statSync").mockImplementation((p) => {
        const name = String(p);
        if (name.includes("stub.onnx")) {
          return { size: 100, isFile: () => true } as fs.Stats;
        }
        if (name.endsWith(".onnx")) {
          return { size: MODEL_SIZE, isFile: () => true } as fs.Stats;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      const status = await getOnnxEmbeddingStatus("stub.onnx");
      expect(status.modelPath).toBeNull();
      // The discovered model is still listed (for the settings dropdown), but
      // must not leak into the resolved path.
      expect(status.discoveredModels).toEqual([
        { filename: MODEL_FILENAME, sizeBytes: MODEL_SIZE },
      ]);
    });

    it("reports null path and loaded:false when no model is on disk", async () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      const status = await getOnnxEmbeddingStatus();
      expect(status.modelPath).toBeNull();
      expect(status.loaded).toBe(false);
      expect(status.discoveredModels).toEqual([]);
    });

    it("reports the configured pooling mode when one is saved", async () => {
      const status = await getOnnxEmbeddingStatus(MODEL_FILENAME, "cls");
      expect(status.pooling).toEqual({
        status: "resolved",
        mode: "cls",
        source: "configured",
      });
    });

    it("reports pooling as unresolved when nothing declares or saves it", async () => {
      // No 1_Pooling/config.json anywhere → the UI must ask.
      const status = await getOnnxEmbeddingStatus(MODEL_FILENAME);
      expect(status.pooling).toEqual({ status: "unresolved" });
    });

    it("resolves pooling from the sidecar config when present", async () => {
      serveFiles({
        [path.join(CANONICAL_EMBEDDING_DIR, "tokenizer.json")]: TOKENIZER_FIXTURE,
        [path.join(CANONICAL_EMBEDDING_DIR, "1_Pooling", "config.json")]:
          poolingFixture("mean"),
      });
      const status = await getOnnxEmbeddingStatus(MODEL_FILENAME);
      expect(status.pooling).toEqual({
        status: "resolved",
        mode: "mean",
        source: "sidecar",
      });
    });
  });

  describe("generateEmbedding", () => {
    it("loads the session lazily and returns an L2-normalized vector", async () => {
      loadRegistryMock.mockResolvedValue(onnxRegistryDoc(MODEL_FILENAME));
      mockAcquire.mockResolvedValue(mockEmbeddingSession(4));

      const embedding = await generateEmbedding("hello onnx");

      expect(mockAcquire).toHaveBeenCalledWith(
        "embedding",
        MODEL_PATH,
        undefined,
        120_000
      );
      expect(embedding).toBeInstanceOf(Float32Array);
      expect(embedding!.length).toBe(4);
      // Every component 0.5 → unit norm after normalization.
      const norm = Math.hypot(...Array.from(embedding!));
      expect(norm).toBeCloseTo(1, 5);
    });

    it("mean-pools a token-level output tensor across the sequence", async () => {
      loadRegistryMock.mockResolvedValue(onnxRegistryDoc(MODEL_FILENAME));
      // A sidecar declares mean pooling (tier 2 auto-resolution).
      serveFiles({
        [path.join(CANONICAL_EMBEDDING_DIR, "tokenizer.json")]: TOKENIZER_FIXTURE,
        [path.join(CANONICAL_EMBEDDING_DIR, "1_Pooling", "config.json")]:
          poolingFixture("mean"),
      });

      const seqLen = 3;
      const hidden = 2;
      // Tokens: [1,0], [0,1], [1,1] → mean [2/3, 2/3].
      const flat = new Float32Array([1, 0, 0, 1, 1, 1]);
      const session = {
        inputNames: ["input_ids", "attention_mask"],
        outputNames: ["last_hidden_state"],
        run: vi.fn(async () => ({
          last_hidden_state: { data: flat },
        })),
        release: vi.fn().mockResolvedValue(undefined),
      };
      mockAcquire.mockResolvedValue(session);

      const embedding = await generateEmbedding("abc");
      expect(session.run).toHaveBeenCalledOnce();
      expect(embedding!.length).toBe(hidden);
      // Both components equal after mean-pool → normalized to 1/√2 each.
      expect(embedding![0]).toBeCloseTo(embedding![1], 5);
      expect(Math.hypot(embedding![0], embedding![1])).toBeCloseTo(1, 5);
      // Sanity: seqLen drives the pooling stride.
      expect(seqLen * hidden).toBe(flat.length);
    });

    it("honours an explicitly configured pooling mode (tier 3)", async () => {
      // cls pooling: take token 0 only → [1, 0] → normalized [1, 0].
      loadRegistryMock.mockResolvedValue({
        ...onnxRegistryDoc(MODEL_FILENAME),
        embedding: {
          provider: "onnx" as const,
          providerId: null,
          modelPath: MODEL_FILENAME,
          poolingMode: "cls" as const,
        },
      });
      const session = {
        inputNames: ["input_ids", "attention_mask"],
        outputNames: ["last_hidden_state"],
        run: vi.fn(async () => ({
          last_hidden_state: { data: new Float32Array([1, 0, 0, 1, 1, 1]) },
        })),
        release: vi.fn().mockResolvedValue(undefined),
      };
      mockAcquire.mockResolvedValue(session);

      const embedding = await generateEmbedding("abc");
      // CLS keeps token 0 verbatim rather than averaging.
      expect(Array.from(embedding!)).toEqual([1, 0]);
    });

    it("refuses a token-level output when no pooling mode can be resolved", async () => {
      // The safety property, mirroring the tokenizer rule: guessing pooling
      // yields a plausible vector from the wrong embedding region, which
      // degrades retrieval silently. Refuse and let the backfill re-embed.
      loadRegistryMock.mockResolvedValue(onnxRegistryDoc(MODEL_FILENAME));
      // Tokenizer present, no pooling config anywhere → tier 3 required.
      serveFiles({
        [path.join(CANONICAL_EMBEDDING_DIR, "tokenizer.json")]: TOKENIZER_FIXTURE,
      });
      mockAcquire.mockResolvedValue({
        run: vi.fn(async () => ({
          last_hidden_state: { data: new Float32Array([1, 0, 0, 1]) },
        })),
        release: vi.fn().mockResolvedValue(undefined),
      });

      const embedding = await generateEmbedding("abc");
      expect(embedding).toBeNull();
    });

    it("refuses to embed when the model has no tokenizer.json", async () => {
      // The safety property: a hash-based fallback would emit numerically
      // valid but meaningless vectors, silently corrupting the vector index.
      // A missing tokenizer must degrade to "no vector", not to fake numbers.
      loadRegistryMock.mockResolvedValue(onnxRegistryDoc(MODEL_FILENAME));
      // No tokenizer.json anywhere → the tokenizer read throws. Scope the
      // throw to tokenizer reads: this spy is process-wide, and throwing for
      // *every* path would also break Vitest's own ESM loader (which calls
      // readFileSync with a URL).
      vi.spyOn(fs, "readFileSync").mockImplementation(((p: unknown, enc?: unknown) => {
        if (readSyncKey(p).endsWith("tokenizer.json")) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return realReadSync(p as never, enc as never);
      }) as typeof fs.readFileSync);

      const embedding = await generateEmbedding("hello");
      expect(embedding).toBeNull();
      // The session is not even exercised — we fail before inference.
      expect(mockAcquire).not.toHaveBeenCalled();
    });

    it("returns null when no model file is on disk", async () => {
      loadRegistryMock.mockResolvedValue(onnxRegistryDoc("missing.onnx"));
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      // Both the explicit path and the discovery scan must find nothing.
      vi.spyOn(fs, "statSync").mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      const embedding = await generateEmbedding("hello");
      expect(embedding).toBeNull();
      expect(mockAcquire).not.toHaveBeenCalled();
    });

    it("returns null (no throw) when the session fails to load", async () => {
      loadRegistryMock.mockResolvedValue(onnxRegistryDoc(MODEL_FILENAME));
      mockAcquire.mockRejectedValue(
        new Error("onnxruntime-node is not installed")
      );

      const embedding = await generateEmbedding("hello");
      expect(embedding).toBeNull();
    });

    it("returns null and releases the session on inference failure", async () => {
      loadRegistryMock.mockResolvedValue(onnxRegistryDoc(MODEL_FILENAME));
      const session = {
        inputNames: ["input_ids", "attention_mask"],
        outputNames: ["last_hidden_state"],
        run: vi.fn().mockRejectedValue(new Error("ORT inference error")),
        release: vi.fn().mockResolvedValue(undefined),
      };
      mockAcquire.mockResolvedValue(session);

      const embedding = await generateEmbedding("hello");
      expect(embedding).toBeNull();
      expect(mockRelease).toHaveBeenCalledWith("embedding");
    });

    it("returns null when the model yields no usable output tensor", async () => {
      loadRegistryMock.mockResolvedValue(onnxRegistryDoc(MODEL_FILENAME));
      mockAcquire.mockResolvedValue({
        run: vi.fn(async () => ({ present: { data: new Float32Array(1) } })),
        release: vi.fn().mockResolvedValue(undefined),
      });

      const embedding = await generateEmbedding("hello");
      expect(embedding).toBeNull();
    });

    it("chunks long text and mean-pools per-chunk ONNX vectors", async () => {
      loadRegistryMock.mockResolvedValue({
        ...onnxRegistryDoc(MODEL_FILENAME),
        embedding: {
          provider: "onnx" as const,
          providerId: null,
          modelPath: MODEL_FILENAME,
          chunkSize: 60,
          chunkOverlap: 10,
        },
      });
      let call = 0;
      const session = {
        inputNames: ["input_ids", "attention_mask"],
        outputNames: ["last_hidden_state"],
        run: vi.fn(async () => {
          // Alternate between two unit vectors so the pool blends them.
          const vec = call++ === 0 ? [1, 0] : [0, 1];
          return { sentence_embedding: { data: new Float32Array(vec) } };
        }),
        release: vi.fn().mockResolvedValue(undefined),
      };
      mockAcquire.mockResolvedValue(session);

      const longText = Array.from(
        { length: 12 },
        (_, i) => `Chunkable sentence ${i} with padding words.`
      ).join(" ");

      const embedding = await generateEmbedding(longText);
      expect(session.run.mock.calls.length).toBeGreaterThan(1);
      expect(embedding!.length).toBe(2);
      expect(Math.hypot(embedding![0], embedding![1])).toBeCloseTo(1, 4);
    });
  });

  describe("detectEmbeddingDimensions", () => {
    it("probes the ONNX model and reports its native dimension", async () => {
      mockAcquire.mockResolvedValue(mockEmbeddingSession(384));

      const result = await detectEmbeddingDimensions({
        provider: "onnx",
        model: MODEL_FILENAME,
      });

      expect(result.dimensions).toBe(384);
      // The probe reports the model file it measured, not a synthetic id.
      expect(result.model).toBe(MODEL_FILENAME);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("throws when no ONNX model file can be resolved", async () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      vi.spyOn(fs, "statSync").mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });
      await expect(
        detectEmbeddingDimensions({ provider: "onnx" })
      ).rejects.toThrow(/No valid ONNX embedding model/);
    });
  });

  describe("saveEmbeddingSettings", () => {
    it("persists poolingMode through saveEmbeddingSettings", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("{}", { status: 200 }));
      await saveEmbeddingSettings({
        provider: "onnx",
        modelPath: "test.onnx",
        poolingMode: "cls",
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          body: expect.stringContaining('"poolingMode":"cls"'),
        })
      );
    });
  });

  describe("OrtSession interface contract", () => {
    it("exposes dims on session output tensors", async () => {
      const session: OrtSession = {
        inputNames: ["input_ids"],
        outputNames: ["last_hidden_state"],
        run: vi.fn(async () => ({
          last_hidden_state: {
            data: new Float32Array([1, 2, 3, 4]),
            dims: [1, 2, 2],
          },
        })),
        release: vi.fn().mockResolvedValue(undefined),
      };
      const result = await session.run({});
      expect(result.last_hidden_state?.dims).toEqual([1, 2, 2]);
    });
  });
});
