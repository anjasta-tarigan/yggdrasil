import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SettingsSnapshot } from "../snapshot";

const saveSettingsPatch = vi.hoisted(() => vi.fn());

vi.mock("@/components/settings/snapshot", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/settings/snapshot")>();
  return { ...actual, saveSettingsPatch };
});

import { useRerankerSettings } from "../hooks/use-reranker-settings";

beforeEach(() => {
  saveSettingsPatch.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function snapshot(overrides: Record<string, unknown> = {}): SettingsSnapshot {
  return {
    embedding: null,
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

function renderRerankerHook(initialSnapshot: SettingsSnapshot | null = null) {
  const onRefresh = vi.fn();
  const setSnapshot = vi.fn();
  const view = renderHook(
    ({ snap }: { snap: SettingsSnapshot | null }) =>
      useRerankerSettings({ snapshot: snap, onRefresh, setSnapshot }),
    { initialProps: { snap: initialSnapshot } },
  );
  return { ...view, onRefresh, setSnapshot };
}

describe("useRerankerSettings hydration", () => {
  it("adopts the stored reranker configuration", () => {
    const { result } = renderRerankerHook(
      snapshot({
        store: {
          providers: [],
          reranker: {
            enabled: false,
            provider: "openai-compatible",
            baseUrl: "https://rerank.example/v1",
            model: "bge-reranker-v2",
            apiKeyEnv: "RERANK_KEY",
            selectedModel: "ms-marco.onnx",
            idleTimeoutMinutes: 30,
          },
        },
        reranker: { enabled: false, available: true, loaded: false },
      }),
    );

    expect(result.current.rerankerEnabled).toBe(false);
    expect(result.current.rerankerProvider).toBe("openai-compatible");
    expect(result.current.rerankerBaseUrl).toBe("https://rerank.example/v1");
    expect(result.current.rerankerRemoteModel).toBe("bge-reranker-v2");
    expect(result.current.rerankerApiKeyEnv).toBe("RERANK_KEY");
    expect(result.current.rerankerSelectedModel).toBe("ms-marco.onnx");
    expect(result.current.rerankerIdleTimeoutMinutes).toBe(30);
  });

  it("falls back to the status block when no store config exists", () => {
    const { result } = renderRerankerHook(
      snapshot({
        reranker: {
          enabled: false,
          available: true,
          loaded: false,
          provider: "onnx",
          modelPath: null,
          mode: "disabled",
          discoveredModels: [],
        },
      }),
    );

    expect(result.current.rerankerEnabled).toBe(false);
    // No stored provider → local ONNX is the default.
    expect(result.current.rerankerProvider).toBe("onnx");
  });

  it("derives the selected model filename from the loaded model path", () => {
    const { result } = renderRerankerHook(
      snapshot({
        reranker: {
          enabled: true,
          available: true,
          loaded: true,
          provider: "onnx",
          modelPath: "/home/u/data/models/reranker/bge-reranker.onnx",
          mode: "active",
          discoveredModels: [{ filename: "bge-reranker.onnx", sizeBytes: 1 }],
        },
      }),
    );

    expect(result.current.rerankerSelectedModel).toBe("bge-reranker.onnx");
  });

  it("leaves the form untouched before the first snapshot", () => {
    const { result } = renderRerankerHook(null);

    expect(result.current.rerankerEnabled).toBe(true);
    expect(result.current.rerankerIdleTimeoutMinutes).toBe(15);
  });
});

describe("useRerankerSettings enable toggle", () => {
  it("patches the status optimistically and refreshes on success", async () => {
    const { result, setSnapshot, onRefresh } = renderRerankerHook(
      snapshot({
        reranker: {
          enabled: true,
          available: true,
          loaded: true,
          provider: "onnx",
          modelPath: null,
          mode: "active",
          discoveredModels: [],
        },
      }),
    );

    await act(async () => {
      result.current.handleToggleReranker(false);
    });

    expect(result.current.rerankerEnabled).toBe(false);
    expect(result.current.rerankerSaved).toBe(true);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(saveSettingsPatch).toHaveBeenCalledWith({
      reranker: expect.objectContaining({ enabled: false, provider: "onnx" }),
    });

    // The optimistic patch must flip the status mode to "disabled".
    const updater = setSnapshot.mock.calls[0][0] as (
      prev: SettingsSnapshot | null,
    ) => SettingsSnapshot | null;
    const next = updater(
      snapshot({
        reranker: {
          enabled: true,
          available: true,
          loaded: true,
          provider: "onnx",
          modelPath: null,
          mode: "active",
          discoveredModels: [],
        },
      }),
    );
    expect(next?.reranker?.enabled).toBe(false);
    expect(next?.reranker?.mode).toBe("disabled");
  });

  it("rolls the toggle back when the save fails", async () => {
    saveSettingsPatch.mockResolvedValueOnce({ ok: false, error: "offline" });
    const { result, setSnapshot, onRefresh } = renderRerankerHook(
      snapshot({
        reranker: {
          enabled: true,
          available: true,
          loaded: true,
          provider: "onnx",
          modelPath: null,
          mode: "active",
          discoveredModels: [],
        },
      }),
    );

    await act(async () => {
      result.current.handleToggleReranker(false);
    });

    expect(result.current.rerankerEnabled).toBe(true);
    expect(result.current.rerankerSaved).toBe(false);
    expect(result.current.rerankerSaveError).toBe("offline");
    expect(onRefresh).not.toHaveBeenCalled();
    // One optimistic patch, then one rollback patch.
    expect(setSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe("useRerankerSettings auto-save handlers", () => {
  it("selects a discovered ONNX model and persists it", async () => {
    const { result, onRefresh } = renderRerankerHook(
      snapshot({
        store: {
          providers: [],
          reranker: { enabled: true, provider: "onnx", idleTimeoutMinutes: 15 },
        },
      }),
    );

    await act(async () => {
      result.current.handleSelectRerankerModel("ms-marco.onnx");
    });

    expect(result.current.rerankerSelectedModel).toBe("ms-marco.onnx");
    expect(saveSettingsPatch).toHaveBeenCalledWith({
      reranker: expect.objectContaining({
        provider: "onnx",
        selectedModel: "ms-marco.onnx",
      }),
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("clears the remote fields in the patch when switching to ONNX", async () => {
    const { result } = renderRerankerHook(
      snapshot({
        store: {
          providers: [],
          reranker: {
            enabled: true,
            provider: "openai-compatible",
            baseUrl: "https://old.example/v1",
            model: "old-model",
            apiKeyEnv: "OLD_KEY",
          },
        },
      }),
    );

    await act(async () => {
      result.current.handleRerankerProviderChange("onnx");
    });

    // The ONNX patch shape carries no remote keys; the stale values only have
    // to disappear from the form so a later switch back does not resurrect
    // them.
    expect(result.current.rerankerBaseUrl).toBe("");
    expect(result.current.rerankerRemoteModel).toBe("");
    expect(result.current.rerankerApiKeyEnv).toBe("");
    expect(saveSettingsPatch).toHaveBeenCalledWith({
      reranker: expect.objectContaining({ provider: "onnx" }),
    });
    const patch = saveSettingsPatch.mock.calls[0][0] as {
      reranker: Record<string, unknown>;
    };
    expect(patch.reranker).not.toHaveProperty("baseUrl");
    expect(patch.reranker).not.toHaveProperty("model");
    expect(patch.reranker).not.toHaveProperty("apiKeyEnv");
  });

  it("persists the idle timeout without touching the model", async () => {
    const { result } = renderRerankerHook(
      snapshot({
        store: {
          providers: [],
          reranker: {
            enabled: true,
            provider: "onnx",
            selectedModel: "ms-marco.onnx",
            idleTimeoutMinutes: 15,
          },
        },
      }),
    );

    await act(async () => {
      result.current.handleChangeRerankerIdleTimeout(45);
    });

    expect(result.current.rerankerIdleTimeoutMinutes).toBe(45);
    expect(saveSettingsPatch).toHaveBeenCalledWith({
      reranker: expect.objectContaining({
        selectedModel: "ms-marco.onnx",
        idleTimeoutMinutes: 45,
      }),
    });
  });

  it("reports a failed base-URL save without clearing the field", async () => {
    saveSettingsPatch.mockResolvedValueOnce({ ok: false, error: "bad URL" });
    const { result } = renderRerankerHook(snapshot());

    await act(async () => {
      result.current.handleRerankerBaseUrlChange("https://x.example/v1");
    });

    expect(result.current.rerankerBaseUrl).toBe("https://x.example/v1");
    expect(result.current.rerankerSaveError).toBe("bad URL");
    expect(result.current.rerankerSaved).toBe(false);
  });

  it("clears the selected model when its file is deleted and refreshes", async () => {
    const { result, onRefresh } = renderRerankerHook(
      snapshot({
        store: {
          providers: [],
          reranker: {
            enabled: true,
            provider: "onnx",
            selectedModel: "ms-marco.onnx",
          },
        },
      }),
    );

    await act(async () => {
      result.current.handleRerankerModelDeleted("ms-marco.onnx");
    });

    expect(result.current.rerankerSelectedModel).toBe("");
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("saves the full form from the explicit Save button", async () => {
    const { result, onRefresh } = renderRerankerHook(
      snapshot({
        store: {
          providers: [],
          reranker: {
            enabled: true,
            provider: "onnx",
            selectedModel: "ms-marco.onnx",
          },
        },
      }),
    );

    await act(async () => {
      await result.current.handleSaveReranker();
    });

    expect(result.current.rerankerSaving).toBe(false);
    expect(result.current.rerankerSaved).toBe(true);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("useRerankerSettings probe", () => {
  it("reports a successful remote connection", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ model: "bge-reranker", latencyMs: 7 }),
          { status: 200 },
        ),
      );
    const { result } = renderRerankerHook(
      snapshot({
        store: {
          providers: [],
          reranker: {
            enabled: true,
            provider: "openai-compatible",
            baseUrl: "https://rerank.example/v1",
            model: "bge-reranker",
          },
        },
      }),
    );

    await act(async () => {
      await result.current.runRerankerProbe();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/reranker/probe",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.current.rerankerProbeResult).toEqual({
      ok: true,
      text: "Connected · bge-reranker · 7 ms",
    });
    expect(result.current.rerankerProbeBusy).toBe(false);
  });

  it("refuses to probe without an endpoint and model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { result } = renderRerankerHook(snapshot());

    await act(async () => {
      await result.current.runRerankerProbe();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.rerankerProbeResult?.ok).toBe(false);
    expect(result.current.rerankerProbeResult?.text).toMatch(
      /required/i,
    );
  });
});
