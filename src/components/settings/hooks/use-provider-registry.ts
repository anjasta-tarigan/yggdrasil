"use client";

import { useEffect, useRef, useState } from "react";
import {
  addProvider,
  createProviderId,
  getProviders,
  hydrateSettings,
  removeProvider,
  saveProviders,
  type ModelEntry,
  type ProviderConfig,
  type ProviderWriteInput,
} from "@/lib/settings";
import type { SettingsSnapshot } from "@/components/settings/snapshot";

/**
 * Provider-registry state and handlers, owned by the settings shell.
 *
 * Covers the provider list, the add form (Ollama / GGUF / OpenAI-compatible /
 * NVIDIA NIM), the edit dialog, and model CRUD. The state lives in the shell
 * (not in `ProviderTab`) because Radix unmounts inactive tab panels — moving it
 * into the panel would discard in-progress form input on every tab switch. See
 * `docs/adr/2026-11-03-settings-view-tab-state-hooks.md`.
 */

export function useProviderRegistry({
  snapshot,
}: {
  /** The latest `GET /api/settings` snapshot, or null before the first load. */
  snapshot: SettingsSnapshot | null;
}) {
  // ---- Provider registry (all saved providers are active at once) ----
  const [providers, setProviders] = useState<ProviderConfig[]>(() =>
    getProviders()
  );

  // Add-Ollama flow: one click, endpoint + models auto-detected.
  const [ollamaBusy, setOllamaBusy] = useState(false);
  const [ollamaError, setOllamaError] = useState<string | null>(null);

  // Add-OpenAI-compatible flow: small form, validated before saving.
  const [openaiFormOpen, setOpenaiFormOpen] = useState(false);
  const [oaName, setOaName] = useState("");
  const [oaBaseUrl, setOaBaseUrl] = useState("");
  const [oaApiKey, setOaApiKey] = useState("");
  const [oaBusy, setOaBusy] = useState(false);
  const [oaError, setOaError] = useState<string | null>(null);

  const [nimForm, setNimForm] = useState<{ provider?: ProviderConfig } | null>(
    null
  );

  // Add-GGUF flow: multi-step dialog (binary status, model scan, selection).
  const [ggufDialogOpen, setGgufDialogOpen] = useState(false);
  const [ggufBusy, setGgufBusy] = useState(false);
  const [ggufError, setGgufError] = useState<string | null>(null);
  const [ggufServerFound, setGgufServerFound] = useState<boolean | null>(null);
  const [ggufServerPath, setGgufServerPath] = useState<string | null>(null);
  const [ggufServerVersion, setGgufServerVersion] = useState<number | null>(null);
  /** Optional user-configured binary path for non-PATH installs. */
  const [ggufCustomServerPath, setGgufCustomServerPath] = useState("");
  const [ggufModels, setGgufModels] = useState<
    Array<{
      filename: string;
      path: string;
      sizeBytes: number;
      fitsMemory: boolean;
    }>
  >([]);
  const [ggufSelectedModels, setGgufSelectedModels] = useState<Set<string>>(
    new Set()
  );

  // Edit-Provider dialog flow
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(
    null
  );
  const [editProviderDialogOpen, setEditProviderDialogOpen] = useState(false);
  const [editProvName, setEditProvName] = useState("");
  const [editProvBaseUrl, setEditProvBaseUrl] = useState("");
  const [editProvApiKey, setEditProvApiKey] = useState("");
  const [editProvClearKey, setEditProvClearKey] = useState(false);
  const [editProvBusy, setEditProvBusy] = useState(false);
  const [editProvError, setEditProvError] = useState<string | null>(null);

  // Model Form modal state
  const [modelFormOpen, setModelFormOpen] = useState(false);
  const [modelFormTargetProviderId, setModelFormTargetProviderId] =
    useState<string>("");
  const [editingModel, setEditingModel] = useState<ModelEntry | null>(null);

  // Re-sync the provider registry from a successful settings fetch.
  useEffect(() => {
    if (!snapshot) return;
    if (Array.isArray(snapshot.store?.providers)) {
      setProviders(snapshot.store.providers);
    }
  }, [snapshot]);

  const addOllama = () => {
    setOllamaBusy(true);
    setOllamaError(null);
    fetch("/api/ollama")
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<{
          baseUrl: string | null;
          detected: boolean;
          models: Array<{ name: string }>;
        }>;
      })
      .then(async (data) => {
        if (!data.detected || !data.baseUrl) {
          setOllamaError(
            "No Ollama instance found on this machine. Start it with `ollama serve` and try again."
          );
          return;
        }
        if (providers.some((p) => p.kind === "ollama" && p.baseUrl === data.baseUrl)) {
          setOllamaError("This Ollama instance is already added.");
          return;
        }
        await addProvider({
          baseUrl: data.baseUrl,
          id: createProviderId("ollama"),
          kind: "ollama",
          name:
            data.models.length > 0
              ? `Ollama (${data.models.length} model${data.models.length === 1 ? "" : "s"})`
              : "Ollama",
        });
        setProviders(getProviders());
      })
      .catch(() => setOllamaError("Could not reach the detection service."))
      .finally(() => setOllamaBusy(false));
  };

  // Abort controller guards against setState-after-unmount when the dialog
  // is closed mid-probe.
  const ggufAbortRef = useRef(new AbortController());

  const addGguf = () => {
    ggufAbortRef.current.abort(); // cancel any in-flight request
    ggufAbortRef.current = new AbortController();
    const aborted = ggufAbortRef.current.signal;
    setGgufError(null);
    setGgufBusy(true);
    setGgufDialogOpen(true);
    setGgufServerFound(null);
    setGgufServerPath(null);
    setGgufServerVersion(null);
    setGgufCustomServerPath("");
    setGgufModels([]);
    setGgufSelectedModels(new Set());

    // Step 1: probe for llama-server binary (PATH scan or custom path).
    const statusUrl = ggufCustomServerPath
      ? `/api/gguf/status?serverPath=${encodeURIComponent(ggufCustomServerPath)}`
      : "/api/gguf/status";
    fetch(statusUrl, { signal: aborted })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Status probe failed (HTTP ${res.status})`);
        }
        return res.json() as Promise<{
          found: boolean;
          path: string | null;
          version: number | null;
          meetsMinimum: boolean;
          error?: string;
        }>;
      })
      .then((data) => {
        if (aborted.aborted) return; // component unmounted / restarted
        if (!data.found) {
          // Binary not installed — show install banner, no model scan.
          setGgufServerFound(false);
          setGgufServerPath(null);
          return;
        }
        setGgufServerFound(data.meetsMinimum);
        setGgufServerPath(data.path);
        setGgufServerVersion(data.version);
        if (!data.meetsMinimum && data.error) {
          setGgufError(data.error);
          return;
        }
        // Step 2: scan for .gguf models on the local filesystem.
        return fetch("/api/gguf/models", { signal: aborted })
          .then((res) => res.json())
          .then((modelsData: { models: Array<{ filename: string; path: string; sizeBytes: number; fitsMemory: boolean }> }) => {
            if (aborted.aborted) return;
            setGgufModels(modelsData.models ?? []);
          });
      })
      .catch((err: unknown) => {
        if (aborted.aborted) return; // normal unmount cancellation
        // Network error or HTTP error — tell the user, don't silently
        // pretend the binary is missing.
        const msg = err instanceof Error ? err.message : "Could not probe for llama-server.";
        setGgufError(msg);
        setGgufServerFound(false);
      })
      .finally(() => {
        if (!aborted.aborted) setGgufBusy(false);
      });
  };

  /** Re-test a manually supplied llama-server path from the add-GGUF dialog. */
  const reprobeGgufServer = () => {
    fetch("/api/gguf/status?serverPath=" + encodeURIComponent(ggufCustomServerPath), {
      signal: ggufAbortRef.current.signal,
    })
      .then((r) => r.json())
      .then((data: {
        found: boolean;
        path: string | null;
        version: number | null;
        meetsMinimum: boolean;
        error?: string;
      }) => {
        if (data.found && data.path) {
          setGgufServerFound(data.meetsMinimum);
          setGgufServerPath(data.path);
          setGgufServerVersion(data.version);
          setGgufError(data.error ?? null);
        } else {
          setGgufServerFound(false);
          setGgufError(data.error ?? "Binary not found at the specified path.");
        }
      })
      .catch((err) => {
        setGgufServerFound(false);
        setGgufError(err instanceof Error ? err.message : "Probe failed.");
      });
  };

  // Abort in-flight GGUF probe/fetch on unmount to avoid setState-after-unmount.
  useEffect(() => {
    const ctrl = ggufAbortRef.current;
    return () => ctrl.abort();
  }, []);

  /** Create the GGUF provider entry from the currently selected models. */
  const ggufDialogConfirm = async () => {
    if (ggufSelectedModels.size === 0) return;
    setGgufError(null);
    const models = Array.from(ggufSelectedModels)
      .map((filename) => ggufModels.find((m) => m.filename === filename))
      .filter(Boolean) as Array<{ filename: string; path: string; sizeBytes: number; fitsMemory: boolean }>;
    const modelEntries = models.map((m) => {
      const stem = m.filename.replace(/\.gguf$/i, "");
      return {
        modelId: m.filename,
        displayName: stem,
        isDefault: models.length === 1,
        capabilities: {
          contextWindow: null,
          maxOutputTokens: null,
          inputModalities: ["text"] as ("text" | "image" | "audio" | "video" | "pdf")[],
          outputModalities: ["text"] as ("text" | "image" | "audio" | "video" | "pdf")[],
          supportsToolCalls: null,
          supportsReasoning: null,
        },
        capabilitySources: {},
      };
    });
    try {
      const ggufSettings: Record<string, unknown> = {};
      if (ggufCustomServerPath) {
        ggufSettings.serverPath = ggufCustomServerPath;
      }
      await addProvider({
        id: createProviderId("gguf"),
        kind: "gguf-model",
        name: "GGUF",
        baseUrl: "http://127.0.0.1:2301",
        gguf: ggufSettings,
        models: modelEntries,
      });
      // addProvider already updates the cache via saveProviders; re-fetch
      // explicitly to pick up the server's validated response.
      const res = await fetch("/api/providers");
      if (res.ok) {
        const data = await res.json() as { providers: ProviderConfig[] };
        setProviders(data.providers);
      } else {
        setProviders(getProviders());
      }
      setGgufDialogOpen(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not add the GGUF provider.";
      setGgufError(msg);
    }
  };

  const addOpenaiProvider = () => {
    const name = oaName.trim() || "Custom provider";
    const baseUrl = oaBaseUrl.trim();
    setOaBusy(true);
    setOaError(null);
    fetch("/api/providers/models", {
      body: JSON.stringify({
        apiKey: oaApiKey.trim() || undefined,
        baseUrl,
        kind: "openai-compatible",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(data?.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ models: Array<{ id: string }> }>;
      })
      .then(async () => {
        await addProvider({
          apiKey: oaApiKey.trim() || undefined,
          baseUrl,
          id: createProviderId("custom"),
          kind: "openai-compatible",
          name,
        });
        setProviders(getProviders());
        setOpenaiFormOpen(false);
        setOaName("");
        setOaBaseUrl("");
        setOaApiKey("");
      })
      .catch((err: unknown) =>
        setOaError(
          err instanceof Error ? err.message : "Connection failed"
        )
      )
      .finally(() => setOaBusy(false));
  };

  const deleteProvider = async (id: string) => {
    await removeProvider(id);
    setProviders(getProviders());
  };

  const editProvider = (provider: ProviderConfig) => {
    if (provider.preset === "nvidia-nim") {
      setNimForm({ provider });
      return;
    }
    setEditingProvider(provider);
    setEditProvName(provider.name);
    setEditProvBaseUrl(provider.baseUrl);
    setEditProvApiKey("");
    setEditProvClearKey(false);
    setEditProvError(null);
    setEditProviderDialogOpen(true);
  };

  /** Create or update an NVIDIA NIM provider from its dedicated dialog. */
  const saveNimProvider = async (input: ProviderWriteInput) => {
    if (nimForm?.provider) {
      await saveProviders(
        providers.map((provider) =>
          provider.id === input.id ? input : provider
        )
      );
    } else {
      await addProvider(input);
    }
    setProviders(getProviders());
  };

  const handleSaveEditedProvider = async () => {
    if (!editingProvider) return;
    const cleanName = editProvName.trim();
    const cleanBaseUrl = editProvBaseUrl.trim();
    if (!cleanBaseUrl) {
      setEditProvError("Base URL is required");
      return;
    }

    setEditProvBusy(true);
    setEditProvError(null);

    try {
      const updatedProviders = providers.map((p) => {
        if (p.id !== editingProvider.id) return p;
        const patched: ProviderConfig = {
          ...p,
          name: cleanName || p.name,
          baseUrl: cleanBaseUrl,
        };
        if (editProvApiKey.trim()) {
          (patched as ProviderConfig & {
            apiKey?: string;
            clearApiKey?: boolean;
          }).apiKey = editProvApiKey.trim();
        } else if (editProvClearKey) {
          (patched as ProviderConfig & { clearApiKey?: boolean }).clearApiKey =
            true;
        }
        return patched;
      });

      await saveProviders(updatedProviders);
      setProviders(getProviders());
      setEditProviderDialogOpen(false);
      setEditingProvider(null);
    } catch (err: unknown) {
      setEditProvError(
        err instanceof Error ? err.message : "Failed to update provider"
      );
    } finally {
      setEditProvBusy(false);
    }
  };

  /**
   * Re-read the registry after a web-provider discovery writes models
   * server-side, so a newly discovered model reaches the selectors.
   */
  const refreshProviders = () => {
    void hydrateSettings().then(() => setProviders(getProviders()));
  };

  // Model CRUD handlers
  const addModel = (providerId: string) => {
    setModelFormTargetProviderId(providerId);
    setEditingModel(null);
    setModelFormOpen(true);
  };

  const editModel = (providerId: string, model: ModelEntry) => {
    setModelFormTargetProviderId(providerId);
    setEditingModel(model);
    setModelFormOpen(true);
  };

  const deleteModel = async (providerId: string, modelId: string) => {
    const updated = providers.map((p) => {
      if (p.id !== providerId) return p;
      return {
        ...p,
        models: (p.models ?? []).filter((m) => m.modelId !== modelId),
      };
    });
    try {
      await saveProviders(updated);
      setProviders(updated);
    } catch (err) {
      // saveProviders re-syncs the cache from the server on failure;
      // surface the reason instead of an unhandled rejection.
      setOaError(err instanceof Error ? err.message : "Failed to delete model");
    }
  };

  const handleSaveModel = async (entry: ModelEntry) => {
    const targetProviderId = modelFormTargetProviderId;
    if (!targetProviderId) return;

    // Spec §15.15: a web-session model must never become the default
    // automatically — background jobs (reflection, consolidation) cannot
    // resolve its session and would fail on every run.
    const targetProvider = providers.find((p) => p.id === targetProviderId);
    const canAutoDefault = targetProvider?.kind !== "web-session";

    // Spec §5.3: the first model added to an EMPTY registry becomes the
    // default automatically.
    const registryIsEmpty = providers.every((p) => (p.models ?? []).length === 0);
    const effectiveEntry: ModelEntry =
      canAutoDefault && registryIsEmpty
        ? { ...entry, isDefault: true }
        : canAutoDefault
          ? entry
          : { ...entry, isDefault: false };

    const updated = providers.map((p) => {
      let nextModels = [...(p.models ?? [])];

      if (effectiveEntry.isDefault) {
        // Demote existing isDefault flags across all providers
        nextModels = nextModels.map((m) =>
          m.isDefault ? { ...m, isDefault: false } : m
        );
      }

      if (p.id === targetProviderId) {
        const existingIdx = nextModels.findIndex(
          (m) => m.modelId === (editingModel?.modelId ?? effectiveEntry.modelId)
        );
        if (existingIdx >= 0) {
          nextModels[existingIdx] = effectiveEntry;
        } else {
          nextModels.push(effectiveEntry);
        }
      }

      return {
        ...p,
        models: nextModels,
      };
    });

    await saveProviders(updated);
    setProviders(updated);
    setModelFormOpen(false);
    setEditingModel(null);
  };

  return {
    providers,
    ollamaBusy,
    ollamaError,
    openaiFormOpen,
    setOpenaiFormOpen,
    oaName,
    setOaName,
    oaBaseUrl,
    setOaBaseUrl,
    oaApiKey,
    setOaApiKey,
    oaBusy,
    oaError,
    setOaError,
    nimForm,
    setNimForm,
    ggufDialogOpen,
    setGgufDialogOpen,
    ggufBusy,
    ggufError,
    ggufServerFound,
    ggufServerPath,
    ggufServerVersion,
    ggufModels,
    ggufCustomServerPath,
    setGgufCustomServerPath,
    ggufSelectedModels,
    setGgufSelectedModels,
    editingProvider,
    setEditingProvider,
    editProviderDialogOpen,
    setEditProviderDialogOpen,
    editProvName,
    setEditProvName,
    editProvBaseUrl,
    setEditProvBaseUrl,
    editProvApiKey,
    setEditProvApiKey,
    editProvClearKey,
    setEditProvClearKey,
    editProvError,
    editProvBusy,
    modelFormOpen,
    setModelFormOpen,
    modelFormTargetProviderId,
    editingModel,
    setEditingModel,
    addOllama,
    addGguf,
    reprobeGgufServer,
    ggufDialogConfirm,
    addOpenaiProvider,
    deleteProvider,
    editProvider,
    saveNimProvider,
    handleSaveEditedProvider,
    refreshProviders,
    addModel,
    editModel,
    deleteModel,
    handleSaveModel,
  };
}
