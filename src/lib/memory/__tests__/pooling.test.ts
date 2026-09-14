import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: { ...actual, readFileSync: vi.fn() } };
});

import { resolvePoolingMode, poolTokenEmbeddings } from "../pooling";

/** Serve specific files by path; everything else ENOENTs. */
function mockFiles(files: Record<string, unknown>) {
  vi.mocked(fs.readFileSync).mockImplementation(((p: unknown) => {
    const key = String(p);
    if (key in files) {
      const v = files[key];
      return typeof v === "string" ? v : JSON.stringify(v);
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }) as typeof fs.readFileSync);
}

const MODEL = "/models/embed/onnx/model.onnx";
const MODEL_DIR = "/models/embed/onnx";
const PARENT = "/models/embed";

describe("pooling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolvePoolingMode", () => {
    it("treats a 2-D [batch, hidden] output as already pooled", () => {
      // sentence_transformers*.onnx and jina's -mean-pooling variant.
      expect(resolvePoolingMode(MODEL, [1, 384])).toEqual({
        kind: "already-pooled",
      });
      // No file access should be needed for this tier.
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it("reads 1_Pooling/config.json beside the model", () => {
      mockFiles({
        [path.join(MODEL_DIR, "1_Pooling", "config.json")]: {
          word_embedding_dimension: 384,
          pooling_mode_cls_token: true,
          pooling_mode_mean_tokens: false,
          pooling_mode_max_tokens: false,
        },
      });
      expect(resolvePoolingMode(MODEL, [1, 7, 384])).toEqual({
        kind: "resolved",
        mode: "cls",
        source: "sidecar",
      });
    });

    it("reads the config from the PARENT dir when the ONNX sits in onnx/", () => {
      // The standard sentence-transformers layout: config at repo root,
      // model under onnx/.
      mockFiles({
        [path.join(PARENT, "1_Pooling", "config.json")]: {
          pooling_mode_mean_tokens: true,
        },
      });
      expect(resolvePoolingMode(MODEL, [1, 7, 384])).toEqual({
        kind: "resolved",
        mode: "mean",
        source: "sidecar",
      });
    });

    it("resolves lasttoken (Qwen3-Embedding / bge-code style)", () => {
      mockFiles({
        [path.join(MODEL_DIR, "1_Pooling", "config.json")]: {
          pooling_mode_lasttoken: true,
          include_prompt: true,
        },
      });
      expect(resolvePoolingMode(MODEL, [1, 7, 384])).toMatchObject({
        mode: "lasttoken",
      });
    });

    it("follows modules.json to a non-standard pooling directory", () => {
      mockFiles({
        [path.join(MODEL_DIR, "modules.json")]: [
          { idx: 0, type: "sentence_transformers.models.Transformer", path: "" },
          { idx: 1, type: "sentence_transformers.models.Pooling", path: "2_Pooling" },
        ],
        [path.join(MODEL_DIR, "2_Pooling", "config.json")]: {
          pooling_mode_cls_token: true,
        },
      });
      expect(resolvePoolingMode(MODEL, [1, 7, 384])).toEqual({
        kind: "resolved",
        mode: "cls",
        source: "modules",
      });
    });

    it("refuses a multi-mode config instead of collapsing it", () => {
      // Multiple true flags mean concatenated pooling — a different output
      // dimension. Silently picking one would corrupt the vector.
      mockFiles({
        [path.join(MODEL_DIR, "1_Pooling", "config.json")]: {
          pooling_mode_cls_token: true,
          pooling_mode_mean_tokens: true,
        },
      });
      const result = resolvePoolingMode(MODEL, [1, 7, 384]);
      expect(result.kind).toBe("unresolved");
    });

    it("reports unresolved with the searched paths when nothing declares it", () => {
      // The Xenova / onnx-community layout: no pooling config anywhere.
      mockFiles({});
      const result = resolvePoolingMode(MODEL, [1, 7, 384]);
      expect(result.kind).toBe("unresolved");
      if (result.kind === "unresolved") {
        expect(result.searched).toContain(
          path.join(MODEL_DIR, "1_Pooling", "config.json")
        );
        expect(result.searched).toContain(
          path.join(PARENT, "1_Pooling", "config.json")
        );
      }
    });

    it("ignores a malformed pooling config", () => {
      mockFiles({
        [path.join(MODEL_DIR, "1_Pooling", "config.json")]: "{ not json",
      });
      expect(resolvePoolingMode(MODEL, [1, 7, 384]).kind).toBe("unresolved");
    });
  });

  describe("poolTokenEmbeddings", () => {
    // Two tokens, 2 dims: token0 = [1, 0], token1 = [0, 1]
    const FLAT = new Float32Array([1, 0, 0, 1]);
    const SEQ = 2;
    const HIDDEN = 2;

    it("mean-pools across all tokens", () => {
      const v = poolTokenEmbeddings(FLAT, SEQ, HIDDEN, [1, 1], "mean");
      expect(Array.from(v)).toEqual([0.5, 0.5]);
    });

    it("mean-pooling excludes masked tokens", () => {
      // Masking token1 must yield token0's vector, not the average.
      const v = poolTokenEmbeddings(FLAT, SEQ, HIDDEN, [1, 0], "mean");
      expect(Array.from(v)).toEqual([1, 0]);
    });

    it("cls takes the first token regardless of mask", () => {
      const v = poolTokenEmbeddings(FLAT, SEQ, HIDDEN, [1, 1], "cls");
      expect(Array.from(v)).toEqual([1, 0]);
    });

    it("lasttoken takes the final unmasked token", () => {
      const v = poolTokenEmbeddings(FLAT, SEQ, HIDDEN, [1, 1], "lasttoken");
      expect(Array.from(v)).toEqual([0, 1]);
    });

    it("lasttoken skips trailing masked tokens", () => {
      const flat = new Float32Array([1, 0, 0, 1, 9, 9]);
      const v = poolTokenEmbeddings(flat, 3, 2, [1, 1, 0], "lasttoken");
      expect(Array.from(v)).toEqual([0, 1]);
    });

    it("max takes the elementwise maximum over unmasked tokens", () => {
      const flat = new Float32Array([1, 5, 3, 2]);
      const v = poolTokenEmbeddings(flat, 2, 2, [1, 1], "max");
      expect(Array.from(v)).toEqual([3, 5]);
    });

    it("max ignores masked tokens", () => {
      const flat = new Float32Array([1, 5, 99, 99]);
      const v = poolTokenEmbeddings(flat, 2, 2, [1, 0], "max");
      expect(Array.from(v)).toEqual([1, 5]);
    });

    it("returns zeros for an all-masked input instead of -Infinity", () => {
      const v = poolTokenEmbeddings(FLAT, SEQ, HIDDEN, [0, 0], "max");
      expect(Array.from(v)).toEqual([0, 0]);
      expect(Array.from(v).every(Number.isFinite)).toBe(true);
    });

    it("returns zeros for an all-masked mean instead of NaN", () => {
      const v = poolTokenEmbeddings(FLAT, SEQ, HIDDEN, [0, 0], "mean");
      expect(Array.from(v)).toEqual([0, 0]);
    });

    it("handles a single-token sequence", () => {
      const flat = new Float32Array([0.25, -0.75]);
      for (const mode of ["mean", "cls", "lasttoken", "max"] as const) {
        const v = poolTokenEmbeddings(flat, 1, 2, [1], mode);
        expect(Array.from(v)).toEqual([0.25, -0.75]);
      }
    });

    it("mean-pools a longer sequence correctly", () => {
      // 3 tokens × 2 dims: [1,2], [3,4], [5,6] → mean [3,4]
      const flat = new Float32Array([1, 2, 3, 4, 5, 6]);
      const v = poolTokenEmbeddings(flat, 3, 2, [1, 1, 1], "mean");
      expect(Array.from(v)).toEqual([3, 4]);
    });
  });
});
