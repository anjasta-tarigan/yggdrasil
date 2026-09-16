import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getModelDir, sweepOrphans, discoverModels, writeManifest, readManifest, deleteModel, type ModelManifest } from "../store";

const TEST_BASE = path.resolve(process.cwd(), "tmp/test-models");

describe("models/store", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(TEST_BASE, "embedding"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  });

  it("formats modelDir as <org>--<name> flattened directory", () => {
    const dir = getModelDir("embedding", "Xenova/all-MiniLM-L6-v2", TEST_BASE);
    expect(dir).toBe(path.join(TEST_BASE, "embedding", "Xenova--all-MiniLM-L6-v2"));
  });

  it("discovers manifested models and ignores unmanifested incomplete directories", () => {
    const dir = getModelDir("embedding", "test/model-a", TEST_BASE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "model.onnx"), Buffer.alloc(15 * 1024 * 1024));

    // Without manifest, not discovered
    expect(discoverModels("embedding", TEST_BASE)).toHaveLength(0);

    // With manifest, discovered
    const manifest: ModelManifest = {
      schemaVersion: 1,
      repo: "test/model-a",
      kind: "embedding",
      variant: "model.onnx",
      files: ["model.onnx"],
      sizeBytes: 15 * 1024 * 1024,
      installedAt: new Date().toISOString(),
    };
    writeManifest(dir, manifest);
    const discovered = discoverModels("embedding", TEST_BASE);
    expect(discovered).toHaveLength(1);
    expect(discovered[0].repo).toBe("test/model-a");
    expect(discovered[0].filename).toBe("test--model-a/model.onnx");
  });

  it("sweeps unmanifested directories and *.part files", () => {
    const dir = getModelDir("embedding", "test/stale", TEST_BASE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "model.onnx.part"), "incomplete");

    sweepOrphans("embedding", new Set(), TEST_BASE);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("sweeps stale .part files inside manifested directories", () => {
    const dir = getModelDir("embedding", "test/manifested", TEST_BASE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "model.onnx"), Buffer.alloc(11 * 1024 * 1024));
    fs.writeFileSync(path.join(dir, "model.onnx.part"), "incomplete");

    const manifest: ModelManifest = {
      schemaVersion: 1,
      repo: "test/manifested",
      kind: "embedding",
      variant: "model.onnx",
      files: ["model.onnx"],
      sizeBytes: 11 * 1024 * 1024,
      installedAt: new Date().toISOString(),
    };
    writeManifest(dir, manifest);

    sweepOrphans("embedding", new Set(), TEST_BASE);
    // Manifest directory kept, .part file purged
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, "model.onnx"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "model.onnx.part"))).toBe(false);
  });

  it("preserves active job directories from sweeping", () => {
    const dir = getModelDir("embedding", "test/active", TEST_BASE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "model.onnx.part"), "incomplete");

    const activeDir = path.join(TEST_BASE, "embedding", "test--active");
    sweepOrphans("embedding", new Set([activeDir]), TEST_BASE);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("reads back a written manifest", () => {
    const dir = getModelDir("embedding", "test/readback", TEST_BASE);
    fs.mkdirSync(dir, { recursive: true });
    const manifest: ModelManifest = {
      schemaVersion: 1,
      repo: "test/readback",
      kind: "embedding",
      variant: "model.onnx",
      files: ["model.onnx"],
      sizeBytes: 12 * 1024 * 1024,
      poolingMode: "mean",
      installedAt: "2024-01-01T00:00:00.000Z",
    };
    writeManifest(dir, manifest);
    const read = readManifest(dir);
    expect(read).not.toBeNull();
    expect(read!.repo).toBe("test/readback");
    expect(read!.poolingMode).toBe("mean");
  });

  it("returns null manifest for a directory without one", () => {
    const dir = getModelDir("embedding", "test/nomani", TEST_BASE);
    fs.mkdirSync(dir, { recursive: true });
    expect(readManifest(dir)).toBeNull();
  });

  it("discoverModels returns an empty array when base dir does not exist", () => {
    expect(discoverModels("embedding", path.join(TEST_BASE, "nonexistent"))).toEqual([]);
  });

  it("discoverModels handles readdirSync errors gracefully", () => {
    const dir = getModelDir("embedding", "test/error", TEST_BASE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      repo: "test/error",
      kind: "embedding",
      variant: "model.onnx",
      files: ["model.onnx"],
      sizeBytes: 0,
      installedAt: new Date().toISOString(),
    }));
    // Model file doesn't exist → not discovered even with manifest
    expect(discoverModels("embedding", TEST_BASE)).toHaveLength(0);
  });

  describe("deleteModel", () => {
    it("deletes a manifested model directory cleanly and completely", () => {
      const dir = getModelDir("reranker", "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1", TEST_BASE);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "model_quint8_avx2.onnx"), Buffer.alloc(1024));
      fs.writeFileSync(path.join(dir, "tokenizer.json"), "{}");
      fs.writeFileSync(path.join(dir, "config.json"), "{}");

      const manifest: ModelManifest = {
        schemaVersion: 1,
        repo: "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1",
        kind: "reranker",
        variant: "model_quint8_avx2.onnx",
        files: ["model_quint8_avx2.onnx", "tokenizer.json", "config.json"],
        sizeBytes: 1024,
        installedAt: new Date().toISOString(),
      };
      writeManifest(dir, manifest);
      expect(fs.existsSync(dir)).toBe(true);

      // Delete by repo string
      const result = deleteModel("reranker", "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1", TEST_BASE);
      expect(result.success).toBe(true);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("deletes a manifested model by relative filename or dirName", () => {
      const dir = getModelDir("reranker", "BAAI/bge-reranker-v2-m3", TEST_BASE);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "model.onnx"), Buffer.alloc(2048));
      writeManifest(dir, {
        schemaVersion: 1,
        repo: "BAAI/bge-reranker-v2-m3",
        kind: "reranker",
        variant: "model.onnx",
        files: ["model.onnx"],
        sizeBytes: 2048,
        installedAt: new Date().toISOString(),
      });

      // Delete by filename: "BAAI--bge-reranker-v2-m3/model.onnx"
      const result = deleteModel("reranker", "BAAI--bge-reranker-v2-m3/model.onnx", TEST_BASE);
      expect(result.success).toBe(true);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("deletes legacy flat files and their external data files", () => {
      const base = path.join(TEST_BASE, "reranker");
      fs.mkdirSync(base, { recursive: true });
      const flatFile = path.join(base, "legacy-reranker.onnx");
      const flatData = path.join(base, "legacy-reranker.onnx_data");
      fs.writeFileSync(flatFile, Buffer.alloc(100));
      fs.writeFileSync(flatData, Buffer.alloc(200));

      const result = deleteModel("reranker", "legacy-reranker.onnx", TEST_BASE);
      expect(result.success).toBe(true);
      expect(fs.existsSync(flatFile)).toBe(false);
      expect(fs.existsSync(flatData)).toBe(false);
    });

    it("rejects path traversal attempts that escape base directory", () => {
      expect(() => {
        deleteModel("reranker", "../../../etc/passwd", TEST_BASE);
      }).toThrow(/traversal|escapes|invalid/i);
    });

    it("returns failure when model does not exist", () => {
      const result = deleteModel("reranker", "nonexistent/model", TEST_BASE);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });
  });
});
