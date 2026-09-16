import { describe, it, expect } from "vitest";
import { planInstall } from "../installer";
import type { HfTreeEntry, HfModelInfo } from "../types";
import type { HfClient } from "../hf-client";

describe("planInstall", () => {
  it("selects int8 over fp32 and resolves base-model pooling tag", async () => {
    const tree: HfTreeEntry[] = [
      { path: "onnx/model_int8.onnx", type: "file", size: 118 * 1024 * 1024, lfs: { oid: "sha-int8", size: 118000, pointerSize: 130 } },
      { path: "onnx/model.onnx", type: "file", size: 470 * 1024 * 1024 },
      { path: "tokenizer.json", type: "file", size: 17 * 1024 * 1024 },
      { path: "config.json", type: "file", size: 500 },
    ];
    const info: HfModelInfo = {
      id: "Xenova/multilingual-e5-small",
      tags: ["transformers.js", "base_model:intfloat/multilingual-e5-small"],
    };

    const mockClient = {
      getModelTree: async () => tree,
      getModelInfo: async () => info,
    } as unknown as HfClient;

    const plan = await planInstall({ repo: "Xenova/multilingual-e5-small", kind: "embedding", client: mockClient });
    expect(plan.chosenVariant).toBe("model_int8.onnx");
    expect(plan.files.some(f => f.role === "graph" && f.destinationRelPath === "model_int8.onnx")).toBe(true);
    expect(plan.files.some(f => f.role === "tokenizer" && f.destinationRelPath === "tokenizer.json")).toBe(true);
    expect(plan.poolingSourceRepo).toBe("intfloat/multilingual-e5-small");
  });

  it("co-locates external data file adjacent to graph", async () => {
    const tree: HfTreeEntry[] = [
      { path: "onnx/model.onnx", type: "file", size: 600 * 1024 },
      { path: "onnx/model.onnx_data", type: "file", size: 2 * 1024 * 1024 * 1024 },
      { path: "tokenizer.json", type: "file", size: 10 * 1024 * 1024 },
    ];
    const mockClient = {
      getModelTree: async () => tree,
      getModelInfo: async () => ({ id: "test/repo" } as HfModelInfo),
    } as unknown as HfClient;

    const plan = await planInstall({ repo: "test/repo", kind: "embedding", client: mockClient });
    expect(plan.files.some(f => f.role === "graph-data" && f.destinationRelPath === "model.onnx_data")).toBe(true);
  });

  it("selects int8 from prefixed variant names instead of falling back to bnb4", async () => {
    // Regression: jinaai/jina-clip-v1 names graphs `text_model_int8.onnx`.
    // The old exact-filename ladder missed these and took onnxFiles[0], which
    // is `text_model.onnx` — or bnb4 under alphabetical ordering.
    const tree: HfTreeEntry[] = [
      { path: "onnx/text_model.onnx", type: "file", size: 470 * 1024 * 1024 },
      { path: "onnx/text_model_bnb4.onnx", type: "file", size: 397 * 1024 * 1024 },
      { path: "onnx/text_model_int8.onnx", type: "file", size: 118 * 1024 * 1024 },
      { path: "onnx/vision_model_int8.onnx", type: "file", size: 118 * 1024 * 1024 },
      { path: "tokenizer.json", type: "file", size: 17 * 1024 * 1024 },
    ];
    const mockClient = {
      getModelTree: async () => tree,
      getModelInfo: async () => ({ id: "jinaai/jina-clip-v1" } as HfModelInfo),
    } as unknown as HfClient;

    const plan = await planInstall({ repo: "jinaai/jina-clip-v1", kind: "embedding", client: mockClient });
    expect(plan.chosenVariant).toBe("text_model_int8.onnx");
  });

  it("never selects an fp16 graph when only fp16 and int8 exist", async () => {
    const tree: HfTreeEntry[] = [
      { path: "onnx/model_fp16.onnx", type: "file", size: 235 * 1024 * 1024 },
      { path: "onnx/model_int8.onnx", type: "file", size: 118 * 1024 * 1024 },
      { path: "tokenizer.json", type: "file", size: 17 * 1024 * 1024 },
    ];
    const mockClient = {
      getModelTree: async () => tree,
      getModelInfo: async () => ({ id: "test/repo" } as HfModelInfo),
    } as unknown as HfClient;

    const plan = await planInstall({ repo: "test/repo", kind: "embedding", client: mockClient });
    expect(plan.chosenVariant).toBe("model_int8.onnx");
  });

  it("rejects an explicit fp16 variant request", async () => {
    const tree: HfTreeEntry[] = [
      { path: "onnx/model_fp16.onnx", type: "file", size: 235 * 1024 * 1024 },
      { path: "onnx/model_int8.onnx", type: "file", size: 118 * 1024 * 1024 },
      { path: "tokenizer.json", type: "file", size: 17 * 1024 * 1024 },
    ];
    const mockClient = {
      getModelTree: async () => tree,
      getModelInfo: async () => ({ id: "test/repo" } as HfModelInfo),
    } as unknown as HfClient;

    await expect(
      planInstall({ repo: "test/repo", kind: "embedding", client: mockClient, preferredVariant: "model_fp16.onnx" }),
    ).rejects.toThrow(/not usable on CPU/);
  });

  it("throws when a repository contains only fp16 graphs", async () => {
    const tree: HfTreeEntry[] = [
      { path: "onnx/model_fp16.onnx", type: "file", size: 235 * 1024 * 1024 },
      { path: "tokenizer.json", type: "file", size: 17 * 1024 * 1024 },
    ];
    const mockClient = {
      getModelTree: async () => tree,
      getModelInfo: async () => ({ id: "test/repo" } as HfModelInfo),
    } as unknown as HfClient;

    await expect(
      planInstall({ repo: "test/repo", kind: "embedding", client: mockClient }),
    ).rejects.toThrow(/No usable ONNX variant/);
  });

  it("prefers an Optimum int8 export over the fp16 `_O4` and the fp32 graph", async () => {
    // Regression: intfloat/multilingual-e5-small ships exactly these three.
    // The ladder used to pick the 235 MB fp16 `_O4` (fp16, half the size of
    // fp32) ahead of the 118 MB int8 export.
    const tree: HfTreeEntry[] = [
      { path: "onnx/model.onnx", type: "file", size: 470 * 1024 * 1024 },
      { path: "onnx/model_O4.onnx", type: "file", size: 235 * 1024 * 1024 },
      { path: "onnx/model_qint8_avx512_vnni.onnx", type: "file", size: 118 * 1024 * 1024 },
      { path: "tokenizer.json", type: "file", size: 17 * 1024 * 1024 },
    ];
    const mockClient = {
      getModelTree: async () => tree,
      getModelInfo: async () => ({ id: "test/repo" } as HfModelInfo),
    } as unknown as HfClient;

    const plan = await planInstall({ repo: "test/repo", kind: "embedding", client: mockClient });
    expect(plan.chosenVariant).toBe("model_qint8_avx512_vnni.onnx");
  });

  it("rejects an explicit fp16 `_O4` variant request", async () => {
    const tree: HfTreeEntry[] = [
      { path: "onnx/model_O4.onnx", type: "file", size: 235 * 1024 * 1024 },
      { path: "onnx/model_int8.onnx", type: "file", size: 118 * 1024 * 1024 },
      { path: "tokenizer.json", type: "file", size: 17 * 1024 * 1024 },
    ];
    const mockClient = {
      getModelTree: async () => tree,
      getModelInfo: async () => ({ id: "test/repo" } as HfModelInfo),
    } as unknown as HfClient;

    await expect(
      planInstall({ repo: "test/repo", kind: "embedding", client: mockClient, preferredVariant: "model_O4.onnx" }),
    ).rejects.toThrow(/not usable on CPU/);
  });
});
