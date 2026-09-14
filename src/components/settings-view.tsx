"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageView } from "@/components/app-shell/page-view";
import { ArrowsClockwise, Warning } from "@phosphor-icons/react";
import type { ModelKind } from "@/lib/models/types";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AboutTab,
  DatabaseTab,
  EmbeddingTab,
  GeneralTab,
  ProviderTab,
  RerankerTab,
} from "@/components/settings/tabs";
import { ToolsTab } from "@/components/settings/tools-tab";
import { PersonaTab } from "@/components/settings/persona-tab";
import { ModelForm } from "@/components/settings/model-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  MAINTENANCE_LABELS,
  SETTINGS_TABS,
  SETTINGS_TAB_INTROS,
  WEB_SEARCH_PROVIDER_META,
  type SettingsTab,
} from "@/components/settings/shared";
import {
  addProvider,
  createProviderId,
  getEmbeddingSettings,
  getProviders,
  getWebSearchProviders,
  removeProvider,
  saveEmbeddingSettings,
  saveProviders,
  saveWebSearchProviders,
  type ModelEntry,
  type ProviderConfig,
  type WebSearchProviderKind,
} from "@/lib/settings";
import { DEFAULT_SYSTEM_PERSONA, type SystemPersonaConfig } from "@/lib/persona/types";
import { useEffect, useRef, useState } from "react";

type SettingsSnapshot = {
  embedding: {
    provider?: "server" | "openai-compatible" | "ollama" | "onnx";
    providerId: string | null;
    baseUrl?: string | null;
    apiKeyEnv?: string;
    apiKeyConfigured: boolean;
    model?: string | null;
    /** ONNX model file (absolute path or filename in data/models/embedding/). */
    modelPath?: string | null;
    dimensions?: number | null;
    chunkSize?: number;
    chunkOverlap?: number;
  } | null;
  /** The new embedding model the server detected was just saved, or null. */
  embeddingModelChanged: string | null;
  database: {
    engine: string;
    driver: string;
    features: string[];
    path: string;
    sizeBytes: number;
    chatCount: number;
    messageCount: number;
    memories: { episodic: number; semantic: number; working: number };
    queue: { pending: number; completed: number; failed: number };
    /** Optional: older servers (hot-reload window) may not send it yet. */
    cognitive?: {
      daemonRunning: boolean;
      queueRunnerRunning: boolean;
      relations: number;
      unembedded: { episodic: number; semantic: number };
      lastRuns: Array<{ type: string; at: string | null }>;
      lastFailure: { type: string; error: string | null; at: string | null } | null;
    };
  };
  tools: Array<{
    name: string;
    description: string;
    configured: boolean;
    requires: string | null;
    enabled: boolean;
    disableable: boolean;
  }>;
  /** Built-in tools currently also served by released MCP duplicates. */
  mcpDuplicates?: Array<{
    tool: string;
    servers: Array<{ name: string; exposedName: string }>;
  }>;
  /** Live status of the multi-provider web search chain. */
  webSearch?: {
    providers: Array<{
      kind: WebSearchProviderKind;
      enabled: boolean;
      ready: boolean;
      coolingDown: boolean;
    }>;
    chain: WebSearchProviderKind[];
  };
  about: { name: string; version: string; stack: string };
  /** Neural reranker diagnostic status and discovered models. */
  reranker?: {
    enabled: boolean;
    available: boolean;
    loaded: boolean;
    modelPath: string | null;
    canonicalPath: string;
    mode: "active" | "standby" | "fallback" | "disabled";
    discoveredModels: Array<{ filename: string; sizeBytes: number }>;
  };
  /** ONNX embedding model diagnostic status and discovered models. */
  onnxEmbedding?: {
    modelPath: string | null;
    loaded: boolean;
    discoveredModels: Array<{ filename: string; sizeBytes: number }>;
  };
  /** Mutable settings store persisted in the database. */
  store: {
    providers: ProviderConfig[];
    websearch?: {
      providers?: Array<{
        kind: WebSearchProviderKind;
        enabled: boolean;
        apiKey?: string;
        baseUrl?: string;
      }>;
    };
    reranker?: {
      enabled: boolean;
      selectedModel?: string;
    };
  };
};

/** Form state for the three web search providers. */
type WebSearchForm = Record<
  WebSearchProviderKind,
  { enabled: boolean; apiKey: string; baseUrl: string }
>;

function emptyWebSearchForm(): WebSearchForm {
  return {
    exa: { enabled: false, apiKey: "", baseUrl: "" },
    firecrawl: { enabled: false, apiKey: "", baseUrl: "" },
    searxng: { enabled: false, apiKey: "", baseUrl: "" },
  };
}

function webSearchFormFromEntries(
  entries: Array<{
    kind: WebSearchProviderKind;
    enabled: boolean;
    apiKey?: string;
    baseUrl?: string;
  }>
): WebSearchForm {
  const form = emptyWebSearchForm();
  for (const entry of entries) {
    form[entry.kind] = {
      enabled: entry.enabled,
      apiKey: entry.apiKey ?? "",
      baseUrl: entry.baseUrl ?? "",
    };
  }
  return form;
}

/**
 * Settings rendered inside the app shell's content area (the sidebar,
 * header and status footer stay in place). Selecting any chat in the
 * sidebar — or the back button — returns to the conversation.
 *
 * Same layout contract as Skills / Plugins / Statistics: one horizontal
 * tab bar with a scrollable list, a short intro paragraph, and content
 * cards in a single centered column.
 */
export function SettingsView({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState(false);

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

  // Edit-Provider dialog flow
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);
  const [editProviderDialogOpen, setEditProviderDialogOpen] = useState(false);
  const [editProvName, setEditProvName] = useState("");
  const [editProvBaseUrl, setEditProvBaseUrl] = useState("");
  const [editProvApiKey, setEditProvApiKey] = useState("");
  const [editProvClearKey, setEditProvClearKey] = useState(false);
  const [editProvBusy, setEditProvBusy] = useState(false);
  const [editProvError, setEditProvError] = useState<string | null>(null);

  // Model Form modal state
  const [modelFormOpen, setModelFormOpen] = useState(false);
  const [modelFormTargetProviderId, setModelFormTargetProviderId] = useState<string>("");
  const [editingModel, setEditingModel] = useState<ModelEntry | null>(null);

  // ---- Embedding provider (used by the memory system) ----
  // providerId references a registry provider (spec §5.4); null means a
  // standalone endpoint configured inline below. The key is write-only:
  // non-empty stores it, empty leaves it, "clear" removes it.
  const [embProviderId, setEmbProviderId] = useState<string | null>(
    () => getEmbeddingSettings().providerId ?? null
  );
  const [embBaseUrl, setEmbBaseUrl] = useState(
    () => getEmbeddingSettings().baseUrl ?? ""
  );
  const [embApiKey, setEmbApiKey] = useState("");
  const [embModel, setEmbModel] = useState(
    () => getEmbeddingSettings().model ?? ""
  );
  const [embDimensions, setEmbDimensions] = useState<number | null>(
    () => getEmbeddingSettings().dimensions ?? null
  );
  // Server-side flag (the key value never reaches the client).
  const [embApiKeyConfigured, setEmbApiKeyConfigured] = useState(false);
  const clearEmbApiKey = () => {
    // Marked locally; the actual clear rides the next save.
    setEmbClearKey(true);
  };
  const [embClearKey, setEmbClearKey] = useState(false);
  const [embeddingSaved, setEmbeddingSaved] = useState(false);
  const [embSaveError, setEmbSaveError] = useState<string | null>(null);
  const [detectBusy, setDetectBusy] = useState(false);
  const [detectResult, setDetectResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [ollamaDetectBusy, setOllamaDetectBusy] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);

  // ---- Local ONNX embedding provider ----
  // Selected via the "__onnx__" sentinel in embProviderId (mirrors how
  // "__custom__" represents the standalone endpoint). The model file is
  // auto-discovered server-side; the user picks one discovered file.
  const [embOnnxModelPath, setEmbOnnxModelPath] = useState(
    () => getEmbeddingSettings().modelPath ?? ""
  );

  // ---- Web search provider chain (powers the web_search tool) ----
  const [wsForm, setWsForm] = useState<WebSearchForm>(() =>
    webSearchFormFromEntries(getWebSearchProviders())
  );
  const [wsSaved, setWsSaved] = useState(false);
  const [wsSaveError, setWsSaveError] = useState<string | null>(null);
  // Bumped after saving so the snapshot (status badges, effective chain)
  // is re-fetched from the server.
  const [settingsVersion, setSettingsVersion] = useState(0);

  // ---- Per-tool enable/disable (Chat tools card) ----
  // Local overlay of the server's enabled flags: flips are optimistic;
  // save persists the derived disabled list via PUT /api/settings.
  const [toolOverrides, setToolOverrides] = useState<Record<string, boolean>>(
    {}
  );
  const [toolsSaved, setToolsSaved] = useState(false);
  const [toolsSaveError, setToolsSaveError] = useState<string | null>(null);

  // ---- Neural reranker (powers cross-encoder memory search) ----
  const [rerankerEnabled, setRerankerEnabled] = useState(true);
  const [rerankerSelectedModel, setRerankerSelectedModel] = useState("");
  const [rerankerSaved, setRerankerSaved] = useState(false);
  const [rerankerSaveError, setRerankerSaveError] = useState<string | null>(null);
  const [rerankerSaving, setRerankerSaving] = useState(false);

  // Active settings tab — single source of truth for the switcher.
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

  // ---- Embedding model-change confirmation ----
  const [modelChanged, setModelChanged] = useState<string | null>(null);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState<{
    current: number;
    total: number;
    percent: number;
  }>({ current: 0, total: 0, percent: 0 });
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const loadedEmbeddingModelRef = useRef<string | null>(null);

  // ---- Model download/install notification ----
  const [installedModelNotification, setInstalledModelNotification] = useState<{
    repo: string;
    kind: ModelKind;
  } | null>(null);
  const notifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (notifTimerRef.current) {
        clearTimeout(notifTimerRef.current);
      }
    };
  }, []);

  function handleModelInstalled(kind: ModelKind, repo?: string) {
    setSettingsVersion((v) => v + 1);
    if (repo) {
      setInstalledModelNotification({ repo, kind });
      if (kind === "embedding") {
        setEmbProviderId("__onnx__");
      }
      if (notifTimerRef.current) clearTimeout(notifTimerRef.current);
      notifTimerRef.current = setTimeout(() => {
        setInstalledModelNotification((prev) => (prev?.repo === repo ? null : prev));
      }, 8000);
    }
  }

  async function handleRebuildEmbeddings() {
    setRebuildBusy(true);
    setRebuildError(null);
    setRebuildProgress({ current: 0, total: 0, percent: 0 });

    try {
      const res = await fetch("/api/maintenance/rebuild-index?stream=true", {
        method: "POST",
        headers: { Accept: "text/event-stream" },
      });
      if (!res.ok) throw new Error(String(res.status));

      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let lastResult: {
          nulledCount?: number;
          embeddedCount?: number;
          remaining?: number;
        } | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            try {
              const data = JSON.parse(trimmed.slice(5).trim());
              if (data.type === "progress") {
                const current = Number(data.current || 0);
                const total = Number(data.total || 0);
                const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
                setRebuildProgress({ current, total, percent });
              } else if (data.type === "complete") {
                lastResult = data;
                setRebuildProgress((prev) => ({
                  current: data.embeddedCount ?? prev.current,
                  total: data.nulledCount ?? prev.total,
                  percent: 100,
                }));
              } else if (data.type === "error") {
                throw new Error(data.error || "Embedding index rebuild failed");
              }
            } catch (parseErr) {
              if (
                parseErr instanceof Error &&
                parseErr.message !== "Embedding index rebuild failed"
              ) {
                // ignore malformed SSE line
              } else {
                throw parseErr;
              }
            }
          }
        }

        setMaintenanceNote(
          `Rebuilt index: re-embedded ${lastResult?.embeddedCount ?? 0} memories (${lastResult?.nulledCount ?? 0} vectors replaced). ${lastResult?.remaining ?? 0} pending.`
        );
        setModelChanged(null);
        setSettingsVersion((v) => v + 1);
      } else {
        const data = (await res.json()) as {
          nulledCount?: number;
          embeddedCount?: number;
          remaining?: number;
        };
        setRebuildProgress({
          current: data.embeddedCount ?? 0,
          total: data.nulledCount ?? data.embeddedCount ?? 0,
          percent: 100,
        });
        setMaintenanceNote(
          `Rebuilt index: re-embedded ${data.embeddedCount ?? 0} memories (${data.nulledCount ?? 0} vectors replaced). ${data.remaining ?? 0} pending.`
        );
        setModelChanged(null);
        setSettingsVersion((v) => v + 1);
      }
    } catch (error) {
      console.error(
        "[settings] Embedding index rebuild failed:",
        error instanceof Error ? error.message : String(error)
      );
      const msg = error instanceof Error ? error.message : "Embedding index rebuild failed";
      setRebuildError(msg);
      setMaintenanceNote("Embedding index rebuild failed.");
    } finally {
      setRebuildBusy(false);
    }
  }

  async function dismissModelChange() {
    try {
      const res = await fetch("/api/maintenance/dismiss-model-change", {
        method: "POST",
      });
      if (!res.ok) {
        console.error(
          "[settings] Dismiss model-change request failed:",
          res.status
        );
      }
    } catch (error) {
      console.error(
        "[settings] Dismiss model-change network error:",
        error instanceof Error ? error.message : String(error)
      );
    }
    setModelChanged(null);
  }

  // ---- System Persona tab state ----
  const [persona, setPersona] = useState<SystemPersonaConfig>(DEFAULT_SYSTEM_PERSONA);
  const [defaultPersona, setDefaultPersona] = useState<SystemPersonaConfig>(DEFAULT_SYSTEM_PERSONA);

  const fetchPersona = async (isCancelled: () => boolean) => {
    try {
      const res = await fetch("/api/settings/persona");
      if (res.ok) {
        const data = (await res.json()) as {
          persona?: SystemPersonaConfig;
          defaultPersona?: SystemPersonaConfig;
        };
        if (!isCancelled()) {
          if (data.persona) setPersona(data.persona);
          if (data.defaultPersona) setDefaultPersona(data.defaultPersona);
        }
      }
    } catch (err) {
      console.warn("[settings-view] Failed to load persona settings:", err);
    }
  };

  const handleSavePersona = async (data: { name: string; instructions: string }) => {
    try {
      const res = await fetch("/api/settings/persona", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { persona?: SystemPersonaConfig };
      if (json.persona) setPersona(json.persona);
      return true;
    } catch {
      return false;
    }
  };

  const handleResetPersona = async () => {
    try {
      const res = await fetch("/api/settings/persona/reset", {
        method: "POST",
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { persona?: SystemPersonaConfig };
      if (json.persona) setPersona(json.persona);
      return true;
    } catch {
      return false;
    }
  };

  // Manual cognitive maintenance triggers (Database tab).
  const [maintenanceBusy, setMaintenanceBusy] = useState<string | null>(null);
  const [maintenanceNote, setMaintenanceNote] = useState<string | null>(null);

  async function runMaintenancePass(
    pass: "light_sleep" | "dream_cycle" | "decay_sweep"
  ) {
    setMaintenanceBusy(pass);
    setMaintenanceNote(null);
    try {
      const res = await fetch("/api/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pass }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setMaintenanceNote(
        `${MAINTENANCE_LABELS[pass]} queued — it runs as soon as the job queue is free.`
      );
      // Refresh stats shortly after so queue counters catch up.
      setTimeout(() => setSettingsVersion((v) => v + 1), 1500);
    } catch {
      setMaintenanceNote("Could not queue the maintenance pass.");
    } finally {
      setMaintenanceBusy(null);
    }
  }

  async function runEmbeddingBackfillNow() {
    setMaintenanceBusy("backfill");
    setMaintenanceNote(null);
    try {
      const res = await fetch("/api/maintenance/backfill", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        embeddedCount?: number;
        remaining?: number;
      };
      setMaintenanceNote(
        `Backfill embedded ${data.embeddedCount ?? 0} memories; ${data.remaining ?? 0} still pending.`
      );
      setSettingsVersion((v) => v + 1);
    } catch {
      setMaintenanceNote("Embedding backfill failed.");
    } finally {
      setMaintenanceBusy(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<SettingsSnapshot>;
      })
      .then((data) => {
        if (cancelled) return;
        setSettings(data);
        // Re-sync mutable settings from the database snapshot.
        if (Array.isArray(data.store?.providers)) {
          setProviders(data.store.providers);
        }
        // The embedding block moved out of the legacy store: GET serves
        // it top-level (the redacted registry view). providerId set → a
        // registry provider supplies the endpoint; null → standalone.
        const emb = data.embedding;
        if (emb !== null) {
          if (emb.provider === "onnx") {
            // Local ONNX model: sentinel id + a discovered/selected file.
            setEmbProviderId("__onnx__");
            setEmbOnnxModelPath(
              typeof emb.modelPath === "string" ? emb.modelPath : ""
            );
          } else if (typeof emb.providerId === "string") {
            setEmbProviderId(emb.providerId);
          } else {
            setEmbProviderId(null);
            setEmbBaseUrl(typeof emb.baseUrl === "string" ? emb.baseUrl : "");
          }
          setEmbModel(typeof emb.model === "string" ? emb.model : "");
          setEmbApiKeyConfigured(Boolean(emb.apiKeyConfigured));
          setEmbDimensions(
            typeof emb.dimensions === "number" ? emb.dimensions : null
          );
          const currentKey = emb.provider === "onnx"
            ? (typeof emb.modelPath === "string" && emb.modelPath ? `onnx:${emb.modelPath}` : "onnx:default")
            : (typeof emb.model === "string" && emb.model ? emb.model : "default");
          loadedEmbeddingModelRef.current = currentKey;
        }
        // Check if the server flagged an embedding model change.
        if (data.embeddingModelChanged) {
          setModelChanged(data.embeddingModelChanged);
        }

        // Re-sync the web search chain: stored entries win; otherwise
        // mirror the env-derived defaults the server actually uses.
        const storedWs = data.store?.websearch?.providers;
        if (Array.isArray(storedWs) && storedWs.length > 0) {
          setWsForm(webSearchFormFromEntries(storedWs));
        } else if (data.webSearch) {
          setWsForm(
            webSearchFormFromEntries(
              data.webSearch.providers.map((p) => ({
                kind: p.kind,
                enabled: p.enabled,
              }))
            )
          );
        }

        // Re-sync reranker configuration from status or stored settings
        if (data.reranker) {
          setRerankerEnabled(data.reranker.enabled);
        } else if (
          data.store?.reranker &&
          typeof data.store.reranker.enabled === "boolean"
        ) {
          setRerankerEnabled(data.store.reranker.enabled);
        }
        if (data.store?.reranker?.selectedModel) {
          setRerankerSelectedModel(data.store.reranker.selectedModel);
        } else if (data.reranker?.modelPath) {
          const fullPath = data.reranker.modelPath;
          const matched = data.reranker.discoveredModels?.find(
            (m) =>
              fullPath === m.filename ||
              fullPath.endsWith("/" + m.filename) ||
              fullPath.endsWith("\\" + m.filename)
          );
          if (matched) {
            setRerankerSelectedModel(matched.filename);
          } else if (fullPath.includes("data/models/reranker/")) {
            setRerankerSelectedModel(
              fullPath.split("data/models/reranker/").pop() ?? ""
            );
          } else {
            const filename = fullPath.split(/[/\\]/).pop();
            if (filename) setRerankerSelectedModel(filename);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });

    void fetchPersona(() => cancelled);

    return () => {
      cancelled = true;
    };
  }, [settingsVersion]);

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
    setEditingProvider(provider);
    setEditProvName(provider.name);
    setEditProvBaseUrl(provider.baseUrl);
    setEditProvApiKey("");
    setEditProvClearKey(false);
    setEditProvError(null);
    setEditProviderDialogOpen(true);
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
      setProviders(updatedProviders);
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

    // Spec §5.3: the first model added to an EMPTY registry becomes the
    // default automatically.
    const registryIsEmpty = providers.every((p) => (p.models ?? []).length === 0);
    const effectiveEntry: ModelEntry =
      registryIsEmpty ? { ...entry, isDefault: true } : entry;

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

  const saveEmbedding = async () => {
    setEmbSaveError(null);
    try {
      let res: { embeddingModelChanged?: string | null } | undefined;
      if (embProviderId === "__onnx__") {
        res = await saveEmbeddingSettings({
          provider: "onnx",
          providerId: null,
          modelPath: embOnnxModelPath.trim() || undefined,
          dimensions: embDimensions ?? undefined,
          chunkSize: 2000,
          chunkOverlap: 200,
        });
      } else {
        res = await saveEmbeddingSettings({
          // providerId set → a registry provider supplies the endpoint;
          // null → the standalone baseUrl/key fields below.
          providerId: embProviderId,
          ...(embProviderId === null
            ? { baseUrl: embBaseUrl.trim() || undefined }
            : {}),
          ...(embProviderId === null && embApiKey.trim()
            ? { apiKey: embApiKey.trim() }
            : {}),
          ...(embClearKey ? { clearApiKey: true } : {}),
          model: embModel.trim() || undefined,
          dimensions: embDimensions ?? undefined,
          chunkSize: 2000,
          chunkOverlap: 200,
        });
      }
      setEmbApiKey("");
      setEmbClearKey(false);
      setEmbeddingSaved(true);
      window.setTimeout(() => setEmbeddingSaved(false), 2000);
      setSettingsVersion((v) => v + 1);

      // Trigger rebuild index warning popup when embedding model changed
      const currentModelKey = embProviderId === "__onnx__"
        ? (embOnnxModelPath.trim() ? `onnx:${embOnnxModelPath.trim()}` : "onnx:default")
        : (embModel.trim() || "default");

      if (res?.embeddingModelChanged) {
        setModelChanged(res.embeddingModelChanged);
      } else if (
        loadedEmbeddingModelRef.current &&
        loadedEmbeddingModelRef.current !== currentModelKey
      ) {
        setModelChanged(currentModelKey);
      }
      loadedEmbeddingModelRef.current = currentModelKey;
    } catch (error) {
      setEmbSaveError(
        error instanceof Error ? error.message : "Failed to save settings"
      );
    }
  };

  const updateWsForm = (
    kind: WebSearchProviderKind,
    patch: Partial<{ enabled: boolean; apiKey: string; baseUrl: string }>
  ) => {
    setWsForm((prev) => ({ ...prev, [kind]: { ...prev[kind], ...patch } }));
  };

  const saveWebSearch = async () => {
    setWsSaveError(null);
    const providers = WEB_SEARCH_PROVIDER_META.map((meta) => ({
      kind: meta.kind,
      enabled: wsForm[meta.kind].enabled,
      apiKey: wsForm[meta.kind].apiKey.trim() || undefined,
      baseUrl: wsForm[meta.kind].baseUrl.trim() || undefined,
    }));
    try {
      await saveWebSearchProviders(providers);
      setWsSaved(true);
      window.setTimeout(() => setWsSaved(false), 2000);
      setSettingsVersion((v) => v + 1);
    } catch (error) {
      setWsSaveError(
        error instanceof Error ? error.message : "Failed to save settings"
      );
    }
  };

  /**
   * Flip one tool toggle and persist immediately — no separate Save
   * button. Optimistic: the switch moves at once; on failure it rolls
   * back to the snapshot value and the error surfaces inline. This
   * removes the flip-without-saving trap entirely.
   */
  const toggleTool = (name: string, enabled: boolean) => {
    // Snapshot the pre-flip state for rollback before any setState.
    const before =
      settings?.tools.find((tool) => tool.name === name)?.enabled ?? enabled;
    const overridesBefore = { ...toolOverrides };

    setToolOverrides((prev) => ({ ...prev, [name]: enabled }));
    setToolsSaved(false);
    setToolsSaveError(null);
    setSettings((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        tools: prev.tools.map((tool) =>
          tool.name === name ? { ...tool, enabled } : tool
        ),
      };
    });

    // Disabled set = snapshot values, overlay overrides, then this flip.
    const disabled = (settings?.tools ?? [])
      .filter((tool) => {
        if (tool.name === name) return !enabled;
        const override = toolOverrides[tool.name];
        const enabledNow = override !== undefined ? override : tool.enabled;
        return !enabledNow;
      })
      .map((tool) => tool.name);

    fetch("/api/settings", {
      body: JSON.stringify({ toolToggles: { disabled } }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!res.ok) {
          throw new Error(data?.error ?? `HTTP ${res.status}`);
        }
        setToolsSaved(true);
        setToolOverrides({});
        setSettingsVersion((v) => v + 1);
        window.setTimeout(() => setToolsSaved(false), 2000);
      })
      .catch(() => {
        // Roll back the optimistic flip so the switch never lies.
        setToolOverrides(overridesBefore);
        setSettings((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            tools: prev.tools.map((tool) =>
              tool.name === name ? { ...tool, enabled: before } : tool
            ),
          };
        });
        setToolsSaveError(
          "Couldn't save the change — check your connection and try again."
        );
      });
  };

  /**
   * Flip neural reranker toggle and persist immediately with optimistic
   * rollback on failure.
   */
  const handleToggleReranker = (enabled: boolean) => {
    const before = rerankerEnabled;
    setRerankerEnabled(enabled);
    setRerankerSaved(false);
    setRerankerSaveError(null);

    setSettings((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        reranker: prev.reranker
          ? {
              ...prev.reranker,
              enabled,
              mode: enabled
                ? prev.reranker.loaded
                  ? "active"
                  : prev.reranker.available
                    ? "standby"
                    : "fallback"
                : "disabled",
            }
          : undefined,
      };
    });

    fetch("/api/settings", {
      body: JSON.stringify({
        reranker: {
          enabled,
          ...(rerankerSelectedModel
            ? { selectedModel: rerankerSelectedModel }
            : {}),
        },
      }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!res.ok) {
          throw new Error(data?.error ?? `HTTP ${res.status}`);
        }
        setRerankerSaved(true);
        setSettingsVersion((v) => v + 1);
        window.setTimeout(() => setRerankerSaved(false), 2000);
      })
      .catch((err) => {
        setRerankerEnabled(before);
        setSettings((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            reranker: prev.reranker
              ? {
                  ...prev.reranker,
                  enabled: before,
                  mode: before
                    ? prev.reranker.loaded
                      ? "active"
                      : prev.reranker.available
                        ? "standby"
                        : "fallback"
                    : "disabled",
                }
              : undefined,
          };
        });
        setRerankerSaveError(
          err instanceof Error
            ? err.message
            : "Couldn't save the change — check your connection and try again."
        );
      });
  };

  /**
   * Choose which discovered ONNX model file to use and auto-save the selection.
   */
  const handleSelectRerankerModel = (model: string) => {
    setRerankerSelectedModel(model);
    setRerankerSaved(false);
    setRerankerSaveError(null);

    fetch("/api/settings", {
      body: JSON.stringify({
        reranker: {
          enabled: rerankerEnabled,
          selectedModel: model,
        },
      }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!res.ok) {
          throw new Error(data?.error ?? `HTTP ${res.status}`);
        }
        setRerankerSaved(true);
        setSettingsVersion((v) => v + 1);
        window.setTimeout(() => setRerankerSaved(false), 2000);
      })
      .catch((err) => {
        setRerankerSaveError(
          err instanceof Error
            ? err.message
            : "Failed to save selected model."
        );
      });
  };

  /**
   * Explicit save handler for the RerankerTab Save button.
   */
  const handleSaveReranker = async () => {
    setRerankerSaving(true);
    setRerankerSaved(false);
    setRerankerSaveError(null);
    try {
      const res = await fetch("/api/settings", {
        body: JSON.stringify({
          reranker: {
            enabled: rerankerEnabled,
            ...(rerankerSelectedModel
              ? { selectedModel: rerankerSelectedModel }
              : {}),
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      setRerankerSaved(true);
      setSettingsVersion((v) => v + 1);
      window.setTimeout(() => setRerankerSaved(false), 2000);
    } catch (err) {
      setRerankerSaveError(
        err instanceof Error
          ? err.message
          : "Failed to save reranker configuration."
      );
    } finally {
      setRerankerSaving(false);
    }
  };

  // Probe the configured endpoint and store the model's native vector
  // dimension.
  const detectDimensions = async () => {
    setDetectBusy(true);
    setDetectResult(null);
    try {
      const res = await fetch("/api/embeddings/detect", {
        body: JSON.stringify(
          embProviderId === "__onnx__"
            ? { provider: "onnx", modelPath: embOnnxModelPath.trim() || undefined }
            : embProviderId
              ? {
                  // Registry provider: the key is resolved server-side.
                  providerId: embProviderId,
                  model: embModel.trim() || undefined,
                }
              : {
                  provider: embBaseUrl.trim().includes("11434")
                    ? "ollama"
                    : "openai-compatible",
                  baseUrl: embBaseUrl.trim() || undefined,
                  apiKey: embApiKey.trim() || undefined,
                  model: embModel.trim() || undefined,
                }
        ),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await res.json()) as {
        dimensions?: number;
        model?: string;
        latencyMs?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setEmbDimensions(data.dimensions ?? null);
      setDetectResult({
        ok: true,
        text: `${data.dimensions} dimensions · ${data.model} · ${data.latencyMs} ms`,
      });
    } catch (error) {
      setDetectResult({
        ok: false,
        text: error instanceof Error ? error.message : "Detection failed",
      });
    } finally {
      setDetectBusy(false);
    }
  };

  // Auto-detect a local Ollama endpoint for the embedding base URL.
  const detectOllamaUrl = () => {
    setOllamaDetectBusy(true);
    fetch("/api/ollama")
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<{
          baseUrl: string | null;
          detected: boolean;
        }>;
      })
      .then((data) => {
        if (data.detected && data.baseUrl) setEmbBaseUrl(data.baseUrl);
      })
      .catch(() => {
        /* keep whatever the user typed */
      })
      .finally(() => setOllamaDetectBusy(false));
  };

  // While a standalone endpoint that looks like Ollama is configured,
  // list its installed models so the model field offers real choices.
  useEffect(() => {
    const isStandaloneOllama =
      embProviderId === null && /11434/.test(embBaseUrl);
    if (!isStandaloneOllama) return;
    if (!/^https?:\/\//.test(embBaseUrl.trim())) return;
    let cancelled = false;
    fetch("/api/providers/models", {
      body: JSON.stringify({ baseUrl: embBaseUrl.trim(), kind: "ollama" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<{ models: Array<{ id: string }> }>;
      })
      .then((data) => {
        if (!cancelled) {
          setOllamaModels(data.models.map((m) => m.id));
        }
      })
      .catch(() => {
        if (!cancelled) setOllamaModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [embProviderId, embBaseUrl]);

  return (
    <PageView onBack={onBack} title="Settings">
      {loadError && (
        <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
          Could not load server configuration.
        </p>
      )}

      <p className="mb-4 mt-1 text-muted-foreground text-sm">
        {SETTINGS_TAB_INTROS[activeTab]}
      </p>

      <Tabs
        className="gap-4"
        onValueChange={(value) => setActiveTab(value as SettingsTab)}
        value={activeTab}
      >
        <TabsList className="w-full max-w-full overflow-x-auto">
          {SETTINGS_TABS.map((tab) => (
            <TabsTrigger className="px-3" key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="general">
          <GeneralTab />
        </TabsContent>

        <TabsContent className="space-y-4" value="persona">
          <PersonaTab
            persona={persona}
            defaultPersona={defaultPersona}
            onSave={handleSavePersona}
            onReset={handleResetPersona}
          />
        </TabsContent>

        <TabsContent className="space-y-4" value="provider">
          <ProviderTab
            addModel={addModel}
            addOllama={addOllama}
            addOpenaiProvider={addOpenaiProvider}
            deleteModel={deleteModel}
            deleteProvider={deleteProvider}
            editModel={editModel}
            editProvider={editProvider}
            oaApiKey={oaApiKey}
            oaBaseUrl={oaBaseUrl}
            oaBusy={oaBusy}
            oaError={oaError}
            oaName={oaName}
            ollamaBusy={ollamaBusy}
            ollamaError={ollamaError}
            openaiFormOpen={openaiFormOpen}
            providers={providers}
            setOaApiKey={setOaApiKey}
            setOaBaseUrl={setOaBaseUrl}
            setOaError={setOaError}
            setOaName={setOaName}
            setOpenaiFormOpen={setOpenaiFormOpen}
          />
        </TabsContent>

        <TabsContent className="space-y-4" value="embedding">
          <EmbeddingTab
            detectBusy={detectBusy}
            detectDimensions={detectDimensions}
            detectOllamaUrl={detectOllamaUrl}
            detectResult={detectResult}
            setDetectResult={setDetectResult}
            embApiKey={embApiKey}
            embApiKeyConfigured={embApiKeyConfigured}
            clearEmbApiKey={clearEmbApiKey}
            embBaseUrl={embBaseUrl}
            embDimensions={embDimensions}
            setEmbDimensions={setEmbDimensions}
            embModel={embModel}
            embProviderId={embProviderId}
            embSaveError={embSaveError}
            embeddingSaved={embeddingSaved}
            ollamaDetectBusy={ollamaDetectBusy}
            ollamaModels={ollamaModels}
            providers={providers.map((p) => ({
              id: p.id,
              name: p.name,
              kind: p.kind,
            }))}
            saveEmbedding={saveEmbedding}
            setEmbApiKey={setEmbApiKey}
            setEmbBaseUrl={setEmbBaseUrl}
            setEmbModel={setEmbModel}
            setEmbProviderId={setEmbProviderId}
            onnxDiscoveredModels={settings?.onnxEmbedding?.discoveredModels ?? []}
            onnxModelPath={embOnnxModelPath}
            onnxLoaded={settings?.onnxEmbedding?.loaded ?? false}
            setEmbOnnxModelPath={setEmbOnnxModelPath}
            onModelInstalled={(repo) => handleModelInstalled("embedding", repo)}
            installedModelNotification={installedModelNotification}
            onDismissInstallNotification={() => setInstalledModelNotification(null)}
          />
        </TabsContent>

        <TabsContent className="space-y-4" value="reranker">
          <RerankerTab
            enabled={rerankerEnabled}
            onSave={handleSaveReranker}
            onSelectModel={handleSelectRerankerModel}
            onToggleEnabled={handleToggleReranker}
            onModelInstalled={(repo) => handleModelInstalled("reranker", repo)}
            installedModelNotification={installedModelNotification}
            onDismissInstallNotification={() => setInstalledModelNotification(null)}
            reranker={settings?.reranker ?? null}
            saveError={rerankerSaveError}
            saved={rerankerSaved}
            saving={rerankerSaving}
            selectedModel={rerankerSelectedModel}
          />
        </TabsContent>

        <TabsContent className="space-y-4" value="database">
          <DatabaseTab
            database={settings?.database ?? null}
            maintenanceBusy={maintenanceBusy}
            maintenanceNote={maintenanceNote}
            runEmbeddingBackfillNow={runEmbeddingBackfillNow}
            runMaintenancePass={runMaintenancePass}
          />
        </TabsContent>

        <TabsContent className="space-y-4" value="tools">
          <ToolsTab
            mcpDuplicates={settings?.mcpDuplicates ?? []}
            saveWebSearch={saveWebSearch}
            toggleTool={toggleTool}
            tools={settings?.tools ?? null}
            toolsSaveError={toolsSaveError}
            toolsSaved={toolsSaved}
            updateWsForm={updateWsForm}
            webSearch={settings?.webSearch ?? null}
            wsForm={wsForm}
            wsSaveError={wsSaveError}
            wsSaved={wsSaved}
          />
        </TabsContent>

        <TabsContent value="about">
          <AboutTab about={settings?.about ?? null} />
        </TabsContent>
      </Tabs>

      {/* Provider Edit Dialog */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setEditProviderDialogOpen(false);
            setEditingProvider(null);
          }
        }}
        open={editProviderDialogOpen}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Provider</DialogTitle>
            <DialogDescription>
              Update provider details and credentials.
            </DialogDescription>
          </DialogHeader>

          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSaveEditedProvider();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="edit-prov-name">Provider Name</FieldLabel>
                <Input
                  id="edit-prov-name"
                  onChange={(e) => setEditProvName(e.target.value)}
                  placeholder="Provider name"
                  value={editProvName}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="edit-prov-base-url">Base URL</FieldLabel>
                <Input
                  id="edit-prov-base-url"
                  onChange={(e) => setEditProvBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  required
                  value={editProvBaseUrl}
                />
              </Field>

              {editingProvider?.kind === "openai-compatible" && (
                <Field>
                  <FieldLabel htmlFor="edit-prov-api-key">API Key</FieldLabel>
                  <Input
                    disabled={editProvClearKey}
                    id="edit-prov-api-key"
                    onChange={(e) => setEditProvApiKey(e.target.value)}
                    placeholder={
                      editingProvider.apiKeyConfigured
                        ? "•••••••• (leave blank to keep unchanged)"
                        : "Optional bearer token"
                    }
                    type="password"
                    value={editProvApiKey}
                  />
                  <FieldDescription>
                    API keys are write-only and stored securely on the server.
                  </FieldDescription>

                  {editingProvider.apiKeyConfigured && (
                    <div className="pt-2">
                      <Button
                        onClick={() => {
                          setEditProvClearKey(!editProvClearKey);
                          if (!editProvClearKey) setEditProvApiKey("");
                        }}
                        size="sm"
                        type="button"
                        variant={editProvClearKey ? "destructive" : "outline"}
                      >
                        {editProvClearKey ? "Keep existing key" : "Clear configured key"}
                      </Button>
                    </div>
                  )}
                </Field>
              )}

              {editProvError && (
                <p className="text-destructive text-xs">{editProvError}</p>
              )}
            </FieldGroup>

            <DialogFooter className="mt-2">
              <Button
                onClick={() => setEditProviderDialogOpen(false)}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={editProvBusy || !editProvBaseUrl.trim()}
                type="submit"
              >
                {editProvBusy ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Model Form Modal */}
      <ModelForm
        key={editingModel?.modelId ?? "new-model"}
        model={editingModel}
        onClose={() => {
          setModelFormOpen(false);
          setEditingModel(null);
        }}
        onSave={(entry) => void handleSaveModel(entry)}
        open={modelFormOpen}
        providerId={modelFormTargetProviderId}
      />

      {/* Embedding Model Change Confirmation Dialog */}
      <Dialog
        onOpenChange={(open) => {
          if (!open && !rebuildBusy) dismissModelChange();
        }}
        open={modelChanged !== null}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2 text-warning mb-1">
              <Warning className="size-5 shrink-0" weight="fill" />
              <DialogTitle>Rebuild embeddings?</DialogTitle>
            </div>
            <DialogDescription>
              You changed the embedding model to &quot;{modelChanged}&quot;. Existing memory vectors were generated under the
              previous model and are no longer compatible. Rebuild the index to
              re-embed all memories under the new model.
            </DialogDescription>
          </DialogHeader>

          {/* Real-time accurate Progress Bar during active rebuild */}
          {rebuildBusy && (
            <div className="space-y-2 py-2" data-testid="rebuild-progress">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground flex items-center gap-1.5">
                  <ArrowsClockwise className="size-3.5 animate-spin text-primary" />
                  Re-embedding memories…
                </span>
                <span className="font-mono text-muted-foreground text-[11px]">
                  {rebuildProgress.total > 0
                    ? `${rebuildProgress.current} / ${rebuildProgress.total} (${rebuildProgress.percent}%)`
                    : "Preparing…"}
                </span>
              </div>
              <Progress value={rebuildProgress.percent} className="h-2 rounded-full overflow-hidden" />
            </div>
          )}

          {rebuildError && (
            <Alert variant="destructive" className="py-2 text-xs">
              <AlertTitle className="text-xs font-semibold">Rebuild Failed</AlertTitle>
              <AlertDescription className="text-xs">{rebuildError}</AlertDescription>
            </Alert>
          )}

          <DialogFooter className="mt-2 flex gap-2 sm:justify-end">
            <Button
              disabled={rebuildBusy}
              onClick={() => dismissModelChange()}
              type="button"
              variant="outline"
              size="sm"
            >
              Dismiss
            </Button>
            <Button
              disabled={rebuildBusy}
              onClick={() => void handleRebuildEmbeddings()}
              type="button"
              size="sm"
            >
              {rebuildBusy ? (
                <>
                  <ArrowsClockwise className="size-3.5 mr-1.5 animate-spin" />
                  Rebuilding…
                </>
              ) : (
                "Rebuild now"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageView>
  );
}
