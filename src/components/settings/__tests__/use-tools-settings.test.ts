import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SettingsSnapshot } from "../snapshot";

const saveSettingsPatch = vi.hoisted(() => vi.fn());
const saveWebSearchProviders = vi.hoisted(() => vi.fn());
const getWebSearchProviders = vi.hoisted(() => vi.fn());

vi.mock("@/components/settings/snapshot", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/settings/snapshot")>();
  return { ...actual, saveSettingsPatch };
});

vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return {
    ...actual,
    saveWebSearchProviders,
    getWebSearchProviders,
  };
});

import { useToolsSettings } from "../hooks/use-tools-settings";

function baseSnapshot(overrides: Record<string, unknown> = {}): SettingsSnapshot {
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
    tools: [
      {
        name: "calculator",
        description: "Math calculator",
        configured: true,
        requires: null,
        enabled: true,
        disableable: true,
      },
      {
        name: "web_search",
        description: "Web search",
        configured: true,
        requires: null,
        enabled: false,
        disableable: true,
      },
    ],
    webSearch: {
      providers: [],
      chain: [],
    },
    about: { name: "Yggdrasil", version: "0.0.0", stack: "next" },
    store: {
      providers: [],
    },
    ...overrides,
  } as SettingsSnapshot;
}

describe("useToolsSettings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    saveSettingsPatch.mockResolvedValue({ ok: true });
    saveWebSearchProviders.mockResolvedValue(undefined);
    getWebSearchProviders.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("initializes with default state when snapshot is null", () => {
    const onRefresh = vi.fn();
    const setSnapshot = vi.fn();
    const { result } = renderHook(() =>
      useToolsSettings({ snapshot: null, onRefresh, setSnapshot })
    );

    expect(result.current.wsSaved).toBe(false);
    expect(result.current.wsSaveError).toBeNull();
    expect(result.current.toolsSaved).toBe(false);
    expect(result.current.toolsSaveError).toBeNull();
    expect(result.current.wsForm.exa).toBeDefined();
    expect(result.current.wsForm.exa.enabled).toBe(false);
  });

  it("hydrates wsForm from snapshot.store.websearch.providers", () => {
    const onRefresh = vi.fn();
    const setSnapshot = vi.fn();
    const snapshot = baseSnapshot({
      store: {
        providers: [],
        websearch: {
          providers: [
            {
              kind: "exa",
              enabled: true,
              baseUrl: "https://custom.exa",
            },
          ],
        },
      },
    });

    const { result } = renderHook(() =>
      useToolsSettings({ snapshot, onRefresh, setSnapshot })
    );

    expect(result.current.wsForm.exa.enabled).toBe(true);
    expect(result.current.wsForm.exa.baseUrl).toBe("https://custom.exa");
  });

  it("hydrates wsForm from snapshot.webSearch.providers fallback", () => {
    const onRefresh = vi.fn();
    const setSnapshot = vi.fn();
    const snapshot = baseSnapshot({
      store: { providers: [] },
      webSearch: {
        providers: [
          {
            kind: "firecrawl",
            enabled: true,
            ready: true,
            coolingDown: false,
          },
        ],
        chain: ["firecrawl"],
      },
    });

    const { result } = renderHook(() =>
      useToolsSettings({ snapshot, onRefresh, setSnapshot })
    );

    expect(result.current.wsForm.firecrawl.enabled).toBe(true);
  });

  it("updates wsForm via updateWsForm", () => {
    const onRefresh = vi.fn();
    const setSnapshot = vi.fn();
    const { result } = renderHook(() =>
      useToolsSettings({ snapshot: null, onRefresh, setSnapshot })
    );

    act(() => {
      result.current.updateWsForm("exa", {
        enabled: true,
        apiKey: "new-key",
      });
    });

    expect(result.current.wsForm.exa.enabled).toBe(true);
    expect(result.current.wsForm.exa.apiKey).toBe("new-key");
  });

  it("saves web search providers, clears input key, flashes wsSaved, and refreshes", async () => {
    const onRefresh = vi.fn();
    const setSnapshot = vi.fn();
    const { result } = renderHook(() =>
      useToolsSettings({ snapshot: null, onRefresh, setSnapshot })
    );

    act(() => {
      result.current.updateWsForm("exa", {
        enabled: true,
        apiKey: "exa-secret",
      });
    });

    await act(async () => {
      await result.current.saveWebSearch();
    });

    expect(saveWebSearchProviders).toHaveBeenCalledTimes(1);
    expect(result.current.wsForm.exa.apiKey).toBe("");
    expect(result.current.wsSaved).toBe(true);
    expect(result.current.wsSaveError).toBeNull();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.wsSaved).toBe(false);
  });

  it("sets wsSaveError when saveWebSearch fails", async () => {
    saveWebSearchProviders.mockRejectedValueOnce(new Error("Network failed"));
    const onRefresh = vi.fn();
    const setSnapshot = vi.fn();
    const { result } = renderHook(() =>
      useToolsSettings({ snapshot: null, onRefresh, setSnapshot })
    );

    await act(async () => {
      await result.current.saveWebSearch();
    });

    expect(result.current.wsSaveError).toBe("Network failed");
    expect(result.current.wsSaved).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("toggles tool optimistically and persists disabled tools list", async () => {
    const onRefresh = vi.fn();
    let currentSnapshot: SettingsSnapshot | null = baseSnapshot();
    const setSnapshot = vi.fn((updater) => {
      if (typeof updater === "function") {
        currentSnapshot = updater(currentSnapshot);
      } else {
        currentSnapshot = updater;
      }
    });

    const { result } = renderHook(() =>
      useToolsSettings({ snapshot: currentSnapshot, onRefresh, setSnapshot })
    );

    await act(async () => {
      result.current.toggleTool("web_search", true);
    });

    // calculator: enabled (true), web_search: toggled from false to true -> disabled tools should be empty []
    expect(saveSettingsPatch).toHaveBeenCalledWith({
      toolToggles: { disabled: [] },
    });
    expect(setSnapshot).toHaveBeenCalled();
    expect(result.current.toolsSaved).toBe(true);
    expect(result.current.toolsSaveError).toBeNull();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.toolsSaved).toBe(false);
  });

  it("rolls back optimistic tool toggle when saveSettingsPatch fails", async () => {
    saveSettingsPatch.mockResolvedValueOnce({ ok: false, error: "Unauthorized" });
    const onRefresh = vi.fn();
    let currentSnapshot: SettingsSnapshot | null = baseSnapshot();
    const setSnapshot = vi.fn((updater) => {
      if (typeof updater === "function") {
        currentSnapshot = updater(currentSnapshot);
      } else {
        currentSnapshot = updater;
      }
    });

    const { result } = renderHook(() =>
      useToolsSettings({ snapshot: currentSnapshot, onRefresh, setSnapshot })
    );

    await act(async () => {
      result.current.toggleTool("calculator", false);
    });

    expect(saveSettingsPatch).toHaveBeenCalled();
    // Verify rollback was triggered on snapshot
    expect(setSnapshot).toHaveBeenCalledTimes(2);
    expect(result.current.toolsSaved).toBe(false);
    expect(result.current.toolsSaveError).toContain("Couldn't save the change");
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("rolls back optimistic tool toggle when saveSettingsPatch throws", async () => {
    saveSettingsPatch.mockRejectedValueOnce(new Error("Connection reset"));
    const onRefresh = vi.fn();
    let currentSnapshot: SettingsSnapshot | null = baseSnapshot();
    const setSnapshot = vi.fn((updater) => {
      if (typeof updater === "function") {
        currentSnapshot = updater(currentSnapshot);
      } else {
        currentSnapshot = updater;
      }
    });

    const { result } = renderHook(() =>
      useToolsSettings({ snapshot: currentSnapshot, onRefresh, setSnapshot })
    );

    await act(async () => {
      result.current.toggleTool("calculator", false);
    });

    expect(setSnapshot).toHaveBeenCalledTimes(2);
    expect(result.current.toolsSaveError).toContain("Couldn't save the change");
  });
});
