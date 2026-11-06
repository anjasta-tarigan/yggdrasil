import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SettingsSnapshot } from "../snapshot";

const saveEmbeddingSettings = vi.hoisted(() => vi.fn());
const getEmbeddingSettings = vi.hoisted(() => vi.fn());
const getProviders = vi.hoisted(() => vi.fn());

vi.mock("@/lib/settings", () => ({
  saveEmbeddingSettings,
  getEmbeddingSettings,
  getProviders,
}));

import { useEmbeddingSettings } from "../hooks/use-embedding-settings";

beforeEach(() => {
  getEmbeddingSettings.mockReturnValue({
    provider: "openai-compatible",
    providerId: null,
    baseUrl: "",
    model: "",
    dimensions: null,
    modelPath: "",
  });
  getProviders.mockReturnValue([]);
  saveEmbeddingSettings.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function snapshot(overrides: Record<string, unknown> = {}): SettingsSnapshot {
  return {
    embedding: {
      provider: "openai-compatible",
      providerId: null,
      baseUrl: "https://api.example/v1",
      apiKeyConfigured: true,
      model: "text-embedding-3-small",
      dimensions: 1536,
    },
    embeddingModelChanged: null,
    database: {
      engine: "sqlite",
      driver: "better-sqlite3",
      features: [],
      path: "data/yggdrasil.db",
      sizeBytes: 0,
      chatCount: 0,
      messageCount: 0,
      memories: { episodic: 0, semantic: 0, working: 0 },
      queue: { pending: 0, completed: 0, failed: 0 },
    },
    tools: [],
    about: { name: "Yggdrasil", version: "0.0.0", stack: "next" },
    store: { providers: [] },
    ...overrides,
  } as SettingsSnapshot;
}

function renderEmbeddingHook(initialSnapshot: SettingsSnapshot | null = null) {
  const onRefresh = vi.fn();
  const onMaintenanceNote = vi.fn();
  const view = renderHook(
    ({ snap }: { snap: SettingsSnapshot | null }) =>
      useEmbeddingSettings({ snapshot: snap, onRefresh, onMaintenanceNote }),
    { initialProps: { snap: initialSnapshot } },
  );
  return { ...view, onRefresh, onMaintenanceNote };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("useEmbeddingSettings hydration", () => {
  it("adopts a standalone remote endpoint from the snapshot", () => {
    const { result } = renderEmbeddingHook(snapshot());

    expect(result.current.embSource).toBe("remote");
    expect(result.current.embBaseUrl).toBe("https://api.example/v1");
    expect(result.current.embModel).toBe("text-embedding-3-small");
    expect(result.current.embDimensions).toBe(1536);
    expect(result.current.embApiKeyConfigured).toBe(true);
    expect(result.current.embLegacyProviderName).toBeNull();
  });

  it("prefills a legacy registry-provider block from the provider list", () => {
    const snap = snapshot({
      embedding: {
        providerId: "prov-openai",
        apiKeyConfigured: false,
        model: "text-embedding-3-large",
        dimensions: 3072,
      },
      store: {
        providers: [
          { id: "prov-openai", name: "OpenAI (prod)", baseUrl: "https://prod.example/v1" },
        ],
      },
    });

    const { result } = renderEmbeddingHook(snap);

    expect(result.current.embSource).toBe("remote");
    expect(result.current.embLegacyProviderName).toBe("OpenAI (prod)");
    expect(result.current.embBaseUrl).toBe("https://prod.example/v1");
  });

  it("switches to the local ONNX provider when the snapshot says so", () => {
    const snap = snapshot({
      embedding: {
        provider: "onnx",
        providerId: null,
        apiKeyConfigured: false,
        modelPath: "bge-small.onnx",
        dimensions: 384,
      },
    });

    const { result } = renderEmbeddingHook(snap);

    expect(result.current.embSource).toBe("onnx");
    expect(result.current.embOnnxModelPath).toBe("bge-small.onnx");
    expect(result.current.embDimensions).toBe(384);
  });

  it("opens the rebuild prompt when the server flagged a model change", () => {
    const snap = snapshot({ embeddingModelChanged: "text-embedding-3-large" });

    const { result } = renderEmbeddingHook(snap);

    expect(result.current.modelChanged).toBe("text-embedding-3-large");
  });
});

describe("useEmbeddingSettings probe and save", () => {
  it("stores the probed dimension", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ dimensions: 1024, model: "bge", latencyMs: 12 }),
      );
    const { result } = renderEmbeddingHook(snapshot());

    await act(async () => {
      await result.current.detectDimensions();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.embDimensions).toBe(1024);
    expect(result.current.detectResult?.ok).toBe(true);
    expect(result.current.detectBusy).toBe(false);
  });

  it("offers a force-save path when the probe fails, and persists nothing", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ error: "connect ECONNREFUSED" }, 502));
    const { result } = renderEmbeddingHook(snapshot());

    await act(async () => {
      await result.current.saveEmbedding();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saveEmbeddingSettings).not.toHaveBeenCalled();
    expect(result.current.embCanForceSave).toBe(true);
    expect(result.current.embSaveError).toContain("connect ECONNREFUSED");
    expect(result.current.embSaveError).toContain("save without testing");
  });

  it("probes then persists a successful save and refreshes the snapshot", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ dimensions: 1536, model: "bge", latencyMs: 9 }),
      );
    const { result, onRefresh } = renderEmbeddingHook(snapshot());

    await act(async () => {
      await result.current.saveEmbedding();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saveEmbeddingSettings).toHaveBeenCalledTimes(1);
    const payload = saveEmbeddingSettings.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      providerId: null,
      provider: "openai-compatible",
      baseUrl: "https://api.example/v1",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    expect(result.current.embeddingSaved).toBe(true);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("skips the probe on a forced save and reuses the stored dimension", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { result } = renderEmbeddingHook(snapshot());

    await act(async () => {
      await result.current.saveEmbedding(true);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveEmbeddingSettings).toHaveBeenCalledTimes(1);
    const payload = saveEmbeddingSettings.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.dimensions).toBe(1536);
  });

  it("surfaces a persistence error without marking the form saved", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ dimensions: 1536, model: "bge" }),
    );
    saveEmbeddingSettings.mockRejectedValueOnce(new Error("Unknown embedding provider"));
    const { result, onRefresh } = renderEmbeddingHook(snapshot());

    await act(async () => {
      await result.current.saveEmbedding();
    });

    expect(result.current.embSaveError).toBe("Unknown embedding provider");
    expect(result.current.embeddingSaved).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe("useEmbeddingSettings model-change dismissal", () => {
  it("clears the prompt after acknowledging it", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));
    const { result } = renderEmbeddingHook(
      snapshot({ embeddingModelChanged: "bge-large" }),
    );

    await act(async () => {
      await result.current.dismissModelChange();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/maintenance/dismiss-model-change",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(result.current.modelChanged).toBeNull();
  });
});
