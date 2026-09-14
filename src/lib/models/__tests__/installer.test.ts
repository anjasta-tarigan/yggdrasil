import { describe, it, expect } from "vitest";
import { planInstall } from "../installer";
import type { HfTreeEntry, HfModelInfo } from "../types";

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
    } as any;

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
    const mockClient = { getModelTree: async () => tree, getModelInfo: async () => ({ id: "test/repo" }) } as any;

    const plan = await planInstall({ repo: "test/repo", kind: "embedding", client: mockClient });
    expect(plan.files.some(f => f.role === "graph-data" && f.destinationRelPath === "model.onnx_data")).toBe(true);
  });
});
