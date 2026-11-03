import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SettingsSnapshot } from "../snapshot";

const addProvider = vi.hoisted(() => vi.fn());
const createProviderId = vi.hoisted(() => vi.fn((prefix: string) => `${prefix}-id`));
const getProviders = vi.hoisted(() => vi.fn());
const hydrateSettings = vi.hoisted(() => vi.fn());
const removeProvider = vi.hoisted(() => vi.fn());
const saveProviders = vi.hoisted(() => vi.fn());

vi.mock("@/lib/settings", () => ({
  addProvider,
  createProviderId,
  getProviders,
  hydrateSettings,
  removeProvider,
  saveProviders,
}));

import { useProviderRegistry } from "../hooks/use-provider-registry";

type Provider = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  preset?: string;
  models?: Array<{ modelId: string; displayName?: string; isDefault?: boolean }>;
};

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "prov-1",
    name: "Local",
    kind: "llama-cpp",
    baseUrl: "http://127.0.0.1:8080",
    models: [],
    ...overrides,
  };
}

beforeEach(() => {
  getProviders.mockReturnValue([]);
  addProvider.mockResolvedValue(undefined);
  removeProvider.mockResolvedValue(undefined);
  saveProviders.mockResolvedValue(undefined);
  hydrateSettings.mockResolvedValue(undefined);
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

function renderRegistryHook(initialSnapshot: SettingsSnapshot | null = null) {
  const view = renderHook(
    ({ snap }: { snap: SettingsSnapshot | null }) =>
      useProviderRegistry({ snapshot: snap }),
    { initialProps: { snap: initialSnapshot } },
  );
  return view;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("useProviderRegistry hydration", () => {
  it("adopts the provider list from a fetched snapshot", () => {
    const hydrated = [provider({ id: "prov-a" }), provider({ id: "prov-b" })];
    const { result } = renderRegistryHook(
      snapshot({ store: { providers: hydrated } }),
    );

    expect(result.current.providers).toEqual(hydrated);
  });

  it("keeps the cached list when the snapshot has no provider array", () => {
    getProviders.mockReturnValue([provider({ id: "cached" })]);
    const { result } = renderRegistryHook(
      snapshot({ store: {} as never }),
    );

    expect(result.current.providers.map((p) => p.id)).toEqual(["cached"]);
  });
});

describe("useProviderRegistry add flows", () => {
  it("adds a detected Ollama instance once", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({
          detected: true,
          baseUrl: "http://127.0.0.1:11434",
          models: [{ name: "llama3" }],
        }),
      );
    const { result } = renderRegistryHook();

    await act(async () => {
      result.current.addOllama();
    });

    expect(addProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ollama-id",
        kind: "ollama",
        name: "Ollama (1 model)",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/ollama");
    expect(result.current.ollamaBusy).toBe(false);
    expect(result.current.ollamaError).toBeNull();
  });

  it("refuses a duplicate Ollama endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        detected: true,
        baseUrl: "http://127.0.0.1:11434",
        models: [],
      }),
    );
    const { result } = renderRegistryHook(
      snapshot({
        store: {
          providers: [
            provider({
              id: "existing",
              kind: "ollama",
              baseUrl: "http://127.0.0.1:11434",
            }),
          ],
        },
      }),
    );

    await act(async () => {
      result.current.addOllama();
    });

    expect(addProvider).not.toHaveBeenCalled();
    expect(result.current.ollamaError).toBe(
      "This Ollama instance is already added.",
    );
  });

  it("explains when no Ollama instance is running", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detected: false, baseUrl: null, models: [] }),
    );
    const { result } = renderRegistryHook();

    await act(async () => {
      result.current.addOllama();
    });

    expect(addProvider).not.toHaveBeenCalled();
    expect(result.current.ollamaError).toContain("ollama serve");
  });

  it("validates the endpoint, adds the provider, and closes the form", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ models: [{ id: "gpt-4o" }] }));
    const { result } = renderRegistryHook();

    act(() => {
      result.current.setOpenaiFormOpen(true);
      result.current.setOaName("Custom");
      result.current.setOaBaseUrl("https://api.example/v1");
      result.current.setOaApiKey("sk-test");
    });

    await act(async () => {
      result.current.addOpenaiProvider();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/providers/models",
      expect.objectContaining({ method: "POST" }),
    );
    expect(addProvider).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseUrl: "https://api.example/v1",
      id: "custom-id",
      kind: "openai-compatible",
      name: "Custom",
    });
    expect(result.current.openaiFormOpen).toBe(false);
    expect(result.current.oaName).toBe("");
  });

  it("surfaces the server's validation error and keeps the form open", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "Connection refused" }, 502),
    );
    const { result } = renderRegistryHook();

    act(() => {
      result.current.setOaBaseUrl("https://bad.example/v1");
    });

    await act(async () => {
      result.current.addOpenaiProvider();
    });

    expect(addProvider).not.toHaveBeenCalled();
    expect(result.current.oaError).toBe("Connection refused");
    expect(result.current.oaBusy).toBe(false);
  });
});

describe("useProviderRegistry edit flows", () => {
  it("routes an NVIDIA NIM provider to its dedicated dialog", () => {
    const nim = provider({ id: "nim", preset: "nvidia-nim" });
    const { result } = renderRegistryHook();

    act(() => {
      result.current.editProvider(nim as never);
    });

    expect(result.current.nimForm).toEqual({ provider: nim });
    expect(result.current.editProviderDialogOpen).toBe(false);
  });

  it("prefills the edit dialog for an ordinary provider", () => {
    const prov = provider({ id: "p", name: "Local", baseUrl: "http://x" });
    const { result } = renderRegistryHook();

    act(() => {
      result.current.editProvider(prov as never);
    });

    expect(result.current.editProviderDialogOpen).toBe(true);
    expect(result.current.editProvName).toBe("Local");
    expect(result.current.editProvBaseUrl).toBe("http://x");
    expect(result.current.editProvApiKey).toBe("");
  });

  it("requires a base URL before saving", async () => {
    const prov = provider({ id: "p", name: "Local", baseUrl: "" });
    const { result } = renderRegistryHook(
      snapshot({ store: { providers: [prov] } }),
    );

    act(() => {
      result.current.editProvider(prov as never);
    });

    await act(async () => {
      await result.current.handleSaveEditedProvider();
    });

    expect(saveProviders).not.toHaveBeenCalled();
    expect(result.current.editProvError).toBe("Base URL is required");
  });

  it("saves a renamed provider and closes the dialog", async () => {
    const prov = provider({ id: "p", name: "Old", baseUrl: "http://x" });
    const { result } = renderRegistryHook(
      snapshot({ store: { providers: [prov] } }),
    );

    act(() => {
      result.current.editProvider(prov as never);
      result.current.setEditProvName("New name");
    });

    await act(async () => {
      await result.current.handleSaveEditedProvider();
    });

    expect(saveProviders).toHaveBeenCalledWith([
      expect.objectContaining({ id: "p", name: "New name" }),
    ]);
    expect(result.current.editProviderDialogOpen).toBe(false);
    expect(result.current.editingProvider).toBeNull();
  });

  it("deletes a provider and re-reads the cache", async () => {
    getProviders.mockReturnValue([]);
    const { result } = renderRegistryHook();

    await act(async () => {
      await result.current.deleteProvider("p");
    });

    expect(removeProvider).toHaveBeenCalledWith("p");
    expect(result.current.providers).toEqual([]);
  });
});

describe("useProviderRegistry model CRUD", () => {
  it("makes the first model in an empty registry the default", async () => {
    const prov = provider({ id: "p", models: [] });
    const { result } = renderRegistryHook(
      snapshot({ store: { providers: [prov] } }),
    );

    act(() => {
      result.current.addModel("p");
    });
    expect(result.current.modelFormOpen).toBe(true);
    expect(result.current.editingModel).toBeNull();

    await act(async () => {
      await result.current.handleSaveModel({
        modelId: "llama3",
        displayName: "Llama 3",
      } as never);
    });

    const saved = saveProviders.mock.calls[0][0] as Provider[];
    expect(saved[0].models?.[0]).toMatchObject({
      modelId: "llama3",
      isDefault: true,
    });
    expect(result.current.modelFormOpen).toBe(false);
  });

  it("never auto-defaults a web-session model (Spec §15.15)", async () => {
    const prov = provider({ id: "web", kind: "web-session", models: [] });
    const { result } = renderRegistryHook(
      snapshot({ store: { providers: [prov] } }),
    );

    act(() => {
      result.current.addModel("web");
    });

    await act(async () => {
      await result.current.handleSaveModel({
        modelId: "claude-web",
        displayName: "Claude (web)",
      } as never);
    });

    const saved = saveProviders.mock.calls[0][0] as Provider[];
    expect(saved[0].models?.[0]).toMatchObject({
      modelId: "claude-web",
      isDefault: false,
    });
  });

  it("demotes the previous default when a new default is saved", async () => {
    const prov = provider({
      id: "p",
      models: [
        { modelId: "old", isDefault: true },
        { modelId: "other", isDefault: false },
      ],
    });
    const { result } = renderRegistryHook(
      snapshot({ store: { providers: [prov] } }),
    );

    act(() => {
      result.current.addModel("p");
    });

    await act(async () => {
      await result.current.handleSaveModel({
        modelId: "new",
        isDefault: true,
      } as never);
    });

    const saved = saveProviders.mock.calls[0][0] as Provider[];
    const byId = Object.fromEntries(
      (saved[0].models ?? []).map((m) => [m.modelId, m.isDefault]),
    );
    expect(byId).toEqual({ old: false, other: false, new: true });
  });

  it("edits an existing model in place", async () => {
    const prov = provider({
      id: "p",
      models: [{ modelId: "llama3", displayName: "Llama 3" }],
    });
    const { result } = renderRegistryHook(
      snapshot({ store: { providers: [prov] } }),
    );

    act(() => {
      result.current.editModel("p", { modelId: "llama3" } as never);
    });
    expect(result.current.editModel).toBeDefined();
    expect(result.current.editModel).toBeDefined();
    expect(result.current.editingModel).toEqual({ modelId: "llama3" });

    await act(async () => {
      await result.current.handleSaveModel({
        modelId: "llama3",
        displayName: "Llama 3.1",
      } as never);
    });

    const saved = saveProviders.mock.calls[0][0] as Provider[];
    expect(saved[0].models).toEqual([
      { modelId: "llama3", displayName: "Llama 3.1" },
    ]);
  });

  it("removes a model", async () => {
    const prov = provider({
      id: "p",
      models: [{ modelId: "a" }, { modelId: "b" }],
    });
    const { result } = renderRegistryHook(
      snapshot({ store: { providers: [prov] } }),
    );

    await act(async () => {
      await result.current.deleteModel("p", "a");
    });

    expect(result.current.providers[0].models).toEqual([{ modelId: "b" }]);
  });

  it("surfaces a delete failure through the add-form error channel", async () => {
    saveProviders.mockRejectedValueOnce(new Error("registry busy"));
    const prov = provider({ id: "p", models: [{ modelId: "a" }] });
    const { result } = renderRegistryHook(
      snapshot({ store: { providers: [prov] } }),
    );

    await act(async () => {
      await result.current.deleteModel("p", "a");
    });

    expect(result.current.oaError).toBe("registry busy");
  });
});
