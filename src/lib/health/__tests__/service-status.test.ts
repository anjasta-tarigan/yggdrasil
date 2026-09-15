import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  mapEmbeddingHealth,
  mapRerankerHealth,
  resolveModelName,
  unloadedService,
} from "@/lib/health/service-status";
import type {
  EmbeddingConfig,
  OnnxEmbeddingStatus,
} from "@/lib/memory/embeddings";
import type { RerankerStatus } from "@/lib/memory/reranker";
import type { DiscoveredModel } from "@/lib/models/store";

function onnxStatus(
  overrides: Partial<OnnxEmbeddingStatus> = {}
): OnnxEmbeddingStatus {
  return {
    modelPath: "/models/bge-small.onnx",
    loaded: false,
    discoveredModels: [],
    pooling: { status: "already-pooled" },
    ...overrides,
  };
}

function embeddingConfig(
  overrides: Partial<EmbeddingConfig> = {}
): EmbeddingConfig {
  return {
    provider: "onnx",
    modelPath: "/models/bge-small.onnx",
    chunkSize: 2000,
    chunkOverlap: 200,
    ...overrides,
  };
}

function reranker(
  overrides: Partial<RerankerStatus> = {}
): RerankerStatus {
  return {
    enabled: true,
    available: true,
    loaded: false,
    modelPath: "/reranker/bge-reranker-v2-m3-int8.onnx",
    sizeBytes: 544_000_000,
    canonicalPath: "/reranker/bge-reranker-v2-m3-int8.onnx",
    mode: "standby",
    discoveredModels: [],
    ...overrides,
  };
}

describe("resolveModelName", () => {
  it("prefers a configured name", () => {
    expect(resolveModelName("text-embedding-3-small", "/models/x.onnx", [])).toBe(
      "text-embedding-3-small"
    );
  });

  it("uses the discovered repo leaf when the path matches", () => {
    const discovered: DiscoveredModel[] = [
      {
        filename: "bge-small.onnx",
        path: "/models/bge-small.onnx",
        repo: "Xenova/bge-small-en-v1.5",
        sizeBytes: 100,
        isLegacy: false,
      },
    ];
    expect(
      resolveModelName(undefined, "/models/bge-small.onnx", discovered)
    ).toBe("bge-small-en-v1.5");
  });

  it("falls back to the filename stem (extension stripped) for a legacy file", () => {
    expect(resolveModelName(undefined, "/models/bge-small.onnx", [])).toBe(
      "bge-small"
    );
  });

  it("returns null when there is no model path", () => {
    expect(resolveModelName(undefined, null, [])).toBeNull();
  });
});

describe("mapEmbeddingHealth", () => {
  it("reports running when the ONNX session is loaded", () => {
    const r = mapEmbeddingHealth(embeddingConfig(), onnxStatus({ loaded: true }));
    expect(r).toMatchObject({
      status: "running",
      provider: "onnx",
      model: "bge-small",
      loaded: true,
    });
  });

  it("reports standby when the file exists but the session is evicted", () => {
    const r = mapEmbeddingHealth(embeddingConfig(), onnxStatus({ loaded: false }));
    expect(r).toMatchObject({
      status: "standby",
      provider: "onnx",
      model: "bge-small",
      loaded: false,
    });
  });

  it("reports unload but still shows the configured model name when no ONNX model is on disk", () => {
    const r = mapEmbeddingHealth(
      embeddingConfig(),
      onnxStatus({ loaded: false, modelPath: null })
    );
    expect(r).toMatchObject({
      status: "unload",
      provider: "onnx",
      model: "bge-small",
      loaded: false,
    });
  });

  it("resolves the repo leaf as the display name when available", () => {
    const discovered: DiscoveredModel[] = [
      {
        filename: "bge-small.onnx",
        path: "/models/bge-small.onnx",
        repo: "Xenova/bge-small-en-v1.5",
        sizeBytes: 100,
        isLegacy: false,
      },
    ];
    const r = mapEmbeddingHealth(
      embeddingConfig(),
      onnxStatus({ loaded: true }),
      discovered
    );
    expect(r.model).toBe("bge-small-en-v1.5");
  });

  it("ignores a stale config.model for onnx and surfaces the on-disk model name", () => {
    // Reproduces the user-reported bug end-to-end: the on-nx provider carries a
    // stale `model` (e.g. an OpenRouter id left over from a prior provider),
    // while the real, on-disk model is `multilingual-e5-small`. The footer must
    // show the on-device model, not the stale provider's name.
    const discovered: DiscoveredModel[] = [
      {
        filename: "model_int8.onnx",
        path: "/models/embedding/Xenova--multilingual-e5-small/model_int8.onnx",
        repo: "Xenova/multilingual-e5-small",
        sizeBytes: 100,
        isLegacy: false,
      },
    ];
    const r = mapEmbeddingHealth(
      embeddingConfig({
        modelPath: "Xenova--multilingual-e5-small/model_int8.onnx",
        // Stale name carried from a previous OpenRouter configuration.
        model: "openrouter/qwen/qwen3-embedding-8b",
      }),
      onnxStatus({
        loaded: false,
        modelPath: "/models/embedding/Xenova--multilingual-e5-small/model_int8.onnx",
      }),
      discovered
    );
    expect(r.status).toBe("standby");
    expect(r.model).toBe("multilingual-e5-small");
    expect(r.model).not.toBe("openrouter/qwen/qwen3-embedding-8b");
  });

  it("reports the configured model (not a different on-disk model) when the configured path is unavailable", () => {
    // Reproduces the user-reported bug: an explicitly-configured onnx model
    // that isn't on disk must NOT surface a foreign, auto-discovered model.
    // Here the configured file is missing, yet a different model IS on disk.
    const configuredPath = "bge-small-en-v1.5.onnx";
    const discovered: DiscoveredModel[] = [
      {
        filename: "model_int8.onnx",
        path: "/models/embedding/Xenova--multilingual-e5-small/model_int8.onnx",
        repo: "Xenova/multilingual-e5-small",
        sizeBytes: 100,
        isLegacy: false,
      },
    ];
    const r = mapEmbeddingHealth(
      embeddingConfig({ modelPath: configuredPath }),
      // getOnnxEmbeddingStatus resolves the configured path strictly: null here
      // because the configured file is not on disk.
      onnxStatus({ loaded: false, modelPath: null, discoveredModels: [] }),
      discovered
    );
    expect(r.status).toBe("unload");
    // Shows the configured model's stem — never "multilingual-e5-small".
    expect(r.model).toBe("bge-small-en-v1.5");
    expect(r.model).not.toBe("multilingual-e5-small");
  });

  it("reports running for a configured openai-compatible endpoint", () => {
    const r = mapEmbeddingHealth(
      embeddingConfig({
        provider: "openai-compatible",
        baseUrl: "https://e.example/v1",
        model: "text-embedding-3-small",
        modelPath: undefined,
      }),
      null
    );
    expect(r).toMatchObject({
      status: "running",
      provider: "openai",
      model: "text-embedding-3-small",
      loaded: false,
    });
  });

  it.each([
    ["ollama", "ollama"],
    ["server", "self-host"],
  ] as const)("reports running for a configured %s provider labelled %s", (kind, label) => {
    const r = mapEmbeddingHealth(
      embeddingConfig({
        provider: kind,
        baseUrl: "http://localhost:11434",
        model: undefined,
        modelPath: undefined,
      }),
      null
    );
    expect(r.status).toBe("running");
    expect(r.provider).toBe(label);
  });

  it("reports unload for a remote provider with no endpoint", () => {
    const r = mapEmbeddingHealth(
      embeddingConfig({ provider: "openai-compatible", baseUrl: undefined }),
      null
    );
    expect(r.status).toBe("unload");
    expect(r.provider).toBe("openai");
  });
});

describe("mapRerankerHealth", () => {
  it("maps active → running", () => {
    expect(
      mapRerankerHealth(reranker({ mode: "active", loaded: true }))
    ).toMatchObject({
      status: "running",
      provider: "onnx",
      model: "bge-reranker-v2-m3-int8",
      loaded: true,
    });
  });

  it("maps standby → standby", () => {
    expect(
      mapRerankerHealth(reranker({ mode: "standby", loaded: false }))
    ).toMatchObject({ status: "standby", loaded: false });
  });

  it("maps fallback (enabled, no model) → unload", () => {
    const r = mapRerankerHealth(
      reranker({ mode: "fallback", enabled: true, modelPath: null })
    );
    expect(r.status).toBe("unload");
    expect(r.provider).toBe("onnx");
    expect(r.model).toBeNull();
    expect(r.loaded).toBe(false);
  });

  it("maps disabled → unload with provider disabled", () => {
    const r = mapRerankerHealth(
      reranker({ mode: "disabled", enabled: false, modelPath: null })
    );
    expect(r.status).toBe("unload");
    expect(r.provider).toBe("disabled");
    expect(r.loaded).toBe(false);
  });

  it("uses the discovered repo leaf as the display name", () => {
    const discovered: DiscoveredModel[] = [
      {
        filename: "bge-reranker-v2-m3-int8.onnx",
        path: "/reranker/bge-reranker-v2-m3-int8.onnx",
        repo: "BAAI/bge-reranker-v2-m3",
        sizeBytes: 544_000_000,
        isLegacy: false,
      },
    ];
    expect(
      mapRerankerHealth(
        reranker({ mode: "active", loaded: true }),
        discovered
      ).model
    ).toBe("bge-reranker-v2-m3");
  });

  it("falls back to the filename stem when no repo is discovered", () => {
    expect(
      mapRerankerHealth(reranker({ mode: "active", loaded: true })).model
    ).toBe("bge-reranker-v2-m3-int8");
  });

  it("uses the basename of the model path", () => {
    const r = mapRerankerHealth(reranker({ mode: "active", loaded: true }));
    expect(r.model).toBe(
      path.basename("/reranker/bge-reranker-v2-m3-int8.onnx", ".onnx")
    );
  });
});

describe("unloadedService", () => {
  it("defaults provider to unconfigured", () => {
    expect(unloadedService()).toMatchObject({
      status: "unload",
      provider: "unconfigured",
      model: null,
      loaded: false,
    });
  });
});
