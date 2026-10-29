"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowsClockwise, CheckCircle, Warning } from "@phosphor-icons/react";
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
  type EmbeddingSource,
} from "@/components/settings/tabs";
import { ToolsTab } from "@/components/settings/tools-tab";
import { PersonaTab } from "@/components/settings/persona-tab";
import { ModelForm } from "@/components/settings/model-form";
import { NimProviderDialog } from "@/components/settings/nim-provider-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
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
  formatBytes,
  type DatabaseDiagnostics,
  type SettingsTab,
} from "@/components/settings/shared";
import {
  addProvider,
  createProviderId,
  getEmbeddingSettings,
  getProviders,
  getWebSearchProviders,
  hydrateSettings,
  removeProvider,
  saveEmbeddingSettings,
  saveProviders,
  saveWebSearchProviders,
  type ModelEntry,
  type ProviderConfig,
  type WebSearchProviderKind,
} from "@/lib/settings";
import { DEFAULT_SYSTEM_PERSONA, type SystemPersonaConfig } from "@/lib/persona/types";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useCallback, useRef, useState, useSyncExternalStore } from "react";

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
    servers: Array<{ name: string; exposedName: string; primary?: boolean }>;
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
    environmentEnabled?: boolean;
    available: boolean;
    loaded: boolean;
    /** Provider kind: local ONNX or remote OpenAI-compatible endpoint. */
    provider: "onnx" | "openai-compatible";
    modelPath: string | null;
    /** Remote endpoint base URL (when provider === "openai-compatible"). */
    baseUrl?: string;
    /** Remote model name (when provider === "openai-compatible"). */
    model?: string;
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
      idleTimeoutMinutes?: number;
    };
  };
};

const MOBILE_SETTINGS_QUERY = "(max-width: 767px)";

function subscribeToMobileSettings(callback: () => void) {
  const mediaQuery = window.matchMedia(MOBILE_SETTINGS_QUERY);
  mediaQuery.addEventListener("change", callback);
  return () => mediaQuery.removeEventListener("change", callback);
}

function getMobileSettingsSnapshot() {
  return window.matchMedia(MOBILE_SETTINGS_QUERY).matches;
}

/** Form state for the three web search providers. */
type WebSearchForm = Record<
  WebSearchProviderKind,
  { enabled: boolean; apiKey: string; apiKeys: Array<{ id: string; configured: true }>; removeApiKeyIds: string[]; baseUrl: string }
>;

function emptyWebSearchForm(): WebSearchForm {
  return {
    exa: { enabled: false, apiKey: "", apiKeys: [], removeApiKeyIds: [], baseUrl: "" },
    firecrawl: { enabled: false, apiKey: "", apiKeys: [], removeApiKeyIds: [], baseUrl: "" },
    searxng: { enabled: false, apiKey: "", apiKeys: [], removeApiKeyIds: [], baseUrl: "" },
  };
}

function webSearchFormFromEntries(
  entries: Array<{
    kind: WebSearchProviderKind;
    enabled: boolean;
    apiKeys?: Array<{ id: string; configured: true }>;
    apiKeyConfigured?: boolean;
    baseUrl?: string;
  }>
): WebSearchForm {
  const form = emptyWebSearchForm();
  for (const entry of entries) {
    form[entry.kind] = {
      enabled: entry.enabled,
      apiKey: "",
      apiKeys: entry.apiKeys ?? (entry.apiKeyConfigured ? [{ id: "legacy", configured: true }] : []),
      removeApiKeyIds: [],
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
/** Shared PUT helper for settings patches — eliminates duplicated fetch("/api/settings") calls. */
async function saveSettingsPatch(
  patch: object,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/settings", {
    body: JSON.stringify(patch),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
  }
  return { ok: true };
}

/** Shared GET helper for the initial settings snapshot. */
async function loadSettingsSnapshot(): Promise<SettingsSnapshot> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as SettingsSnapshot;
}

export function SettingsView({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
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

  const [nimForm, setNimForm] = useState<{ provider?: ProviderConfig } | null>(null);

  // Add-GGUF flow: multi-step dialog (binary status, model scan, selection).
  const [ggufDialogOpen, setGgufDialogOpen] = useState(false);
  const [ggufBusy, setGgufBusy] = useState(false);
  const [ggufError, setGgufError] = useState<string | null>(null);
  const [ggufServerFound, setGgufServerFound] = useState<boolean | null>(null);
  const [ggufServerPath, setGgufServerPath] = useState<string | null>(null);
  const [ggufServerVersion, setGgufServerVersion] = useState<number | null>(null);
  /** Optional user-configured binary path for non-PATH installs. */
  const [ggufCustomServerPath, setGgufCustomServerPath] = useState("");
  const [ggufModels, setGgufModels] = useState<Array<{
    filename: string;
    path: string;
    sizeBytes: number;
    fitsMemory: boolean;
  }>>([]);
  const [ggufSelectedModels, setGgufSelectedModels] = useState<Set<string>>(new Set());

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

  // ---- Embedding source (used by the memory system) ----
  // Remote endpoints are always OpenAI-compatible; the legacy providerId /
  // `provider: "ollama"` forms remain resolvable server-side but are no
  // longer exposed as a provider dropdown. The key is write-only: non-empty
  // stores it, empty leaves it, "clear" removes it.
  const [embSource, setEmbSource] = useState<EmbeddingSource>(() => {
    const stored = getEmbeddingSettings();
    return stored.provider === "onnx" ? "onnx" : "remote";
  });
  const [embBaseUrl, setEmbBaseUrl] = useState(
    () => getEmbeddingSettings().baseUrl ?? ""
  );
  const [embLegacyProviderName, setEmbLegacyProviderName] = useState<
    string | null
  >(() => {
    const id = getEmbeddingSettings().providerId;
    if (!id) return null;
    return getProviders().find((provider) => provider.id === id)?.name ?? id;
  });
  // A legacy standalone block using Ollama's native protocol. It keeps
  // working (and keeps using /api/embed) until the endpoint is edited.
  const [embLegacyOllamaUrl, setEmbLegacyOllamaUrl] = useState<string | null>(
    () => {
      const stored = getEmbeddingSettings();
      return !stored.providerId && stored.provider === "ollama"
        ? (stored.baseUrl ?? null)
        : null;
    }
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
  const [embCanForceSave, setEmbCanForceSave] = useState(false);
  // Endpoint+model+key signature of the last successful probe. Saving
  // re-probes when this does not match the current form.
  const lastProbeKeyRef = useRef<string | null>(null);
  const [detectBusy, setDetectBusy] = useState(false);
  const [detectResult, setDetectResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  // ---- Local ONNX embedding provider ----
  // The model file is auto-discovered server-side; the user picks one.
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
  const [rerankerProvider, setRerankerProvider] = useState<"onnx" | "openai-compatible">("onnx");
  const [rerankerBaseUrl, setRerankerBaseUrl] = useState("");
  const [rerankerRemoteModel, setRerankerRemoteModel] = useState("");
  const [rerankerIdleTimeoutMinutes, setRerankerIdleTimeoutMinutes] = useState(15);
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

  // ── Responsive layout: vertical nav on desktop, horizontal on mobile ──
  const isMobile = useSyncExternalStore(
    subscribeToMobileSettings,
    getMobileSettingsSnapshot,
    () => false,
  );

  // ── Close-guard: dirty tracking + rebuild blocking ──
  const [personaDirty, setPersonaDirty] = useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  const isDirty = useMemo(() => {
    if (!settings) return false;

    // Add-provider form is dirty when any field has content.
    if (openaiFormOpen && (oaName.trim() || oaBaseUrl.trim() || oaApiKey.trim())) {
      return true;
    }

    // Embedding form changes against the server snapshot.
    const emb = settings.embedding;
    if (emb) {
      if (embApiKey.trim() || embClearKey) return true;
      const storedSource: EmbeddingSource =
        !emb.providerId && emb.provider === "onnx" ? "onnx" : "remote";
      if (embSource !== storedSource) return true;
      if (embSource === "onnx") {
        if (embOnnxModelPath !== (emb.modelPath ?? "")) return true;
        if (embDimensions !== (emb.dimensions ?? null)) return true;
      } else {
        // A legacy providerId block is displayed as its endpoint; use that
        // endpoint as the baseline so prefill alone does not look dirty.
        const baselineBaseUrl =
          emb.baseUrl ??
          (emb.providerId
            ? providers.find((p) => p.id === emb.providerId)?.baseUrl ?? ""
            : "");
        if (embBaseUrl !== baselineBaseUrl) return true;
        if (embModel !== (emb.model ?? "")) return true;
        if (embDimensions !== (emb.dimensions ?? null)) return true;
      }
    }

    // Web search form changes against the server snapshot.
    const wsSnapshot = webSearchFormFromEntries(
      settings.store?.websearch?.providers?.length
        ? settings.store.websearch.providers
        : settings.webSearch?.providers ?? []
    );
    for (const kind of Object.keys(wsForm) as WebSearchProviderKind[]) {
      if (wsForm[kind].enabled !== wsSnapshot[kind].enabled) return true;
      if (wsForm[kind].apiKey !== wsSnapshot[kind].apiKey) return true;
      if (JSON.stringify(wsForm[kind].removeApiKeyIds) !== JSON.stringify(wsSnapshot[kind].removeApiKeyIds)) return true;
      if (wsForm[kind].apiKeys.length !== wsSnapshot[kind].apiKeys.length) return true;
      if (wsForm[kind].baseUrl !== wsSnapshot[kind].baseUrl) return true;
    }

    return false;
  }, [
    settings,
    openaiFormOpen,
    oaName,
    oaBaseUrl,
    oaApiKey,
    embApiKey,
    embClearKey,
    embSource,
    embOnnxModelPath,
    embBaseUrl,
    embModel,
    embDimensions,
    providers,
    wsForm,
  ]);

  // Single chokepoint for closing the dialog: blocks during SSE rebuild,
  // confirms when there are unsaved changes via PersonaTab, otherwise closes.
  const requestClose = useCallback(() => {
    if (rebuildBusy) return; // silently blocked; inner rebuild dialog handles UX
    if (isDirty || personaDirty) {
      setConfirmDiscardOpen(true);
      return;
    }
    onOpenChange(false);
  }, [rebuildBusy, isDirty, personaDirty, onOpenChange]);

  const confirmAndClose = () => {
    setConfirmDiscardOpen(false);
    onOpenChange(false);
  };

  function handleModelInstalled(kind: ModelKind, repo?: string) {
    setSettingsVersion((v) => v + 1);
    if (repo) {
      setInstalledModelNotification({ repo, kind });
      if (kind === "embedding") {
        setEmbSource("onnx");
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
                  percent: data.remaining == null || data.remaining === 0 ? 100 : Math.min(99, prev.percent),
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
        if (lastResult?.remaining == null || lastResult.remaining === 0) setModelChanged(null);
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
          percent: data.remaining == null || data.remaining === 0 ? 100 : 0,
        });
        setMaintenanceNote(
          `Rebuilt index: re-embedded ${data.embeddedCount ?? 0} memories (${data.nulledCount ?? 0} vectors replaced). ${data.remaining ?? 0} pending.`
        );
        if (data.remaining == null || data.remaining === 0) setModelChanged(null);
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
    } catch (err) {
      console.debug(`[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`);
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
    } catch (err) {
      console.debug(`[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`);
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
    } catch (err) {
      console.debug(`[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`);
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
    } catch (err) {
      console.debug(`[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`);
      setMaintenanceNote("Embedding backfill failed.");
    } finally {
      setMaintenanceBusy(null);
    }
  }

  // Database storage maintenance (Database tab): optimize, VACUUM, reset,
  // and diagnostics. Separate busy/note state from the cognitive passes
  // above so the two groups never block each other.
  const [dbBusy, setDbBusy] = useState<string | null>(null);
  const [dbNote, setDbNote] = useState<string | null>(null);
  const [dbNoteKind, setDbNoteKind] = useState<
    "storage" | "reset" | null
  >(null);
  const [diagnostics, setDiagnostics] = useState<DatabaseDiagnostics | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);

  async function optimizeDatabase(includeVacuum: boolean) {
    setDbBusy(includeVacuum ? "vacuum" : "optimize");
    setDbNote(null);
    setDbNoteKind("storage");
    try {
      const res = await fetch("/api/maintenance/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vacuum: includeVacuum }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        vacuum?: { recoveredBytes?: number };
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setDbNote(
        data.message ??
          (includeVacuum ? "Optimized and vacuumed." : "Query planner optimized.")
      );
      // Only VACUUM changes displayed stats (sizeBytes); a planner-only
      // optimize touches no settings data, so skip the snapshot re-fetch.
      if (includeVacuum) setSettingsVersion((v) => v + 1);
    } catch (err) {
      console.debug(`[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`);
      setDbNote(
        `Storage optimization failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setDbBusy(null);
    }
  }

  async function resetDatabaseNow() {
    setDbBusy("reset");
    setDbNote(null);
    setDbNoteKind("reset");
    try {
      const res = await fetch("/api/maintenance/reset", { method: "POST" });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setDbNote(
          res.status === 409
            ? "Database is busy — try again in a few seconds."
            : `Reset failed: ${data.error ?? res.status}`
        );
        return;
      }
      setDbNote(data.message ?? "Database reset.");
      setDiagnostics(null);
      setSettingsVersion((v) => v + 1);
    } catch (err) {
      console.debug(`[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`);
      setDbNote("Database reset failed.");
    } finally {
      setDbBusy(null);
    }
  }

  async function refreshDiagnostics() {
    setDiagnosticsBusy(true);
    try {
      const res = await fetch("/api/maintenance/diagnostics");
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        ok?: boolean;
      } & DatabaseDiagnostics;
      if (!data.ok) throw new Error("diagnostics failed");
      setDiagnostics({
        metrics: data.metrics,
        slowOperations: data.slowOperations,
      });
    } catch (err) {
      console.debug(`[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`);
      setDiagnostics(null);
    } finally {
      setDiagnosticsBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadSettingsSnapshot()
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
          if (typeof emb.providerId === "string") {
            // A registry provider is authoritative even if a stale legacy
            // `provider: "onnx"` discriminator remains on the block. It is
            // shown as a direct endpoint so the next save can drop the
            // provider reference; the endpoint is prefilled from the provider.
            const providerList = Array.isArray(data.store?.providers)
              ? data.store.providers
              : [];
            const legacyProvider = providerList.find(
              (p) => p.id === emb.providerId
            );
            setEmbSource("remote");
            setEmbLegacyProviderName(
              legacyProvider?.name ?? (emb.providerId as string)
            );
            setEmbLegacyOllamaUrl(null);
            setEmbBaseUrl(legacyProvider?.baseUrl ?? "");
            setEmbOnnxModelPath("");
          } else if (emb.provider === "onnx") {
            // Local ONNX model: a discovered/selected file.
            setEmbSource("onnx");
            setEmbLegacyProviderName(null);
            setEmbLegacyOllamaUrl(null);
            setEmbOnnxModelPath(
              typeof emb.modelPath === "string" ? emb.modelPath : ""
            );
          } else {
            setEmbSource("remote");
            setEmbLegacyProviderName(null);
            setEmbLegacyOllamaUrl(
              emb.provider === "ollama" && typeof emb.baseUrl === "string"
                ? emb.baseUrl
                : null
            );
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
        const storeReranker = data.store?.reranker as
          | {
              enabled?: boolean;
              provider?: string;
              baseUrl?: string;
              model?: string;
              selectedModel?: string;
              idleTimeoutMinutes?: number;
            }
          | undefined;
        if (data.reranker) {
          setRerankerEnabled(data.reranker.enabled);
        } else if (
          storeReranker &&
          typeof storeReranker.enabled === "boolean"
        ) {
          setRerankerEnabled(storeReranker.enabled);
        }
        if (storeReranker && storeReranker.provider) {
          setRerankerProvider(
            storeReranker.provider as "onnx" | "openai-compatible"
          );
        } else {
          setRerankerProvider("onnx");
        }
        if (storeReranker && storeReranker.baseUrl) {
          setRerankerBaseUrl(storeReranker.baseUrl);
        }
        if (storeReranker && storeReranker.model) {
          setRerankerRemoteModel(storeReranker.model);
        }
        if (storeReranker && typeof storeReranker.idleTimeoutMinutes === "number") {
          setRerankerIdleTimeoutMinutes(storeReranker.idleTimeoutMinutes);
        }
        if (storeReranker && storeReranker.selectedModel) {
          setRerankerSelectedModel(storeReranker.selectedModel);
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
  }, [settingsVersion, open]);

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

  // Remote endpoints speak the OpenAI-compatible protocol by default. A
  // legacy standalone Ollama block keeps its native /api/embed protocol
  // until the user edits the base URL.
  const useLegacyOllamaProtocol =
    embSource === "remote" &&
    embLegacyOllamaUrl !== null &&
    embBaseUrl.trim() === embLegacyOllamaUrl;

  // Signature of the current probe inputs. Saving re-probes whenever this
  // does not match the last successful probe, so a stale dimension can never
  // be saved and a broken endpoint cannot be switched in silently.
  const embeddingProbeKey =
    embSource === "onnx"
      ? `onnx:${embOnnxModelPath.trim() || "default"}`
      : `${useLegacyOllamaProtocol ? "ollama" : "openai-compatible"}:${embBaseUrl.trim()}|${embModel.trim()}|${
          embApiKey.trim() ? "typed-key" : "stored-key"
        }`;

  const runEmbeddingProbe = async (): Promise<{
    ok: boolean;
    dimensions?: number;
    text: string;
  }> => {
    try {
      const res = await fetch("/api/embeddings/detect", {
        body: JSON.stringify(
          embSource === "onnx"
            ? {
                provider: "onnx",
                modelPath: embOnnxModelPath.trim() || undefined,
              }
            : {
                provider: useLegacyOllamaProtocol
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
      if (typeof data.dimensions !== "number") {
        throw new Error("The endpoint returned no vector dimensions.");
      }
      return {
        ok: true,
        dimensions: data.dimensions,
        text: `${data.dimensions} dimensions · ${data.model} · ${data.latencyMs ?? 0} ms`,
      };
    } catch (error) {
      return {
        ok: false,
        text:
          error instanceof Error
            ? error.message
            : "The connection test failed.",
      };
    }
  };

  const saveEmbedding = async (force = false) => {
    setEmbSaveError(null);
    setEmbCanForceSave(false);

    // Probe before persisting so the stored dimension belongs to the model
    // that is actually being saved. `force` skips the probe (offered by the
    // "Save without testing" fallback after a failure).
    let detectedDimensions = embDimensions ?? undefined;
    if (force) {
      // Never attach the previous model's dimension to a different model
      // when the probe could not verify it.
      const currentModelKey = embSource === "onnx"
        ? (embOnnxModelPath.trim() ? `onnx:${embOnnxModelPath.trim()}` : "onnx:default")
        : (embModel.trim() || "default");
      if (
        loadedEmbeddingModelRef.current &&
        loadedEmbeddingModelRef.current !== currentModelKey
      ) {
        detectedDimensions = undefined;
      }
    }
    if (!force && lastProbeKeyRef.current !== embeddingProbeKey) {
      setDetectBusy(true);
      setDetectResult(null);
      const probe = await runEmbeddingProbe();
      setDetectBusy(false);
      setDetectResult({ ok: probe.ok, text: probe.text });
      if (!probe.ok) {
        setEmbCanForceSave(true);
        setEmbSaveError(
          `${probe.text} Fix the settings above, or save without testing to keep the previous vectors until the endpoint works.`
        );
        return;
      }
      detectedDimensions = probe.dimensions ?? detectedDimensions;
      if (probe.dimensions) setEmbDimensions(probe.dimensions);
      lastProbeKeyRef.current = embeddingProbeKey;
    }

    try {
      let res: { embeddingModelChanged?: string | null } | undefined;
      if (embSource === "onnx") {
        res = await saveEmbeddingSettings({
          provider: "onnx",
          providerId: null,
          modelPath: embOnnxModelPath.trim() || undefined,
          dimensions: detectedDimensions,
          chunkSize: 2000,
          chunkOverlap: 200,
        });
      } else {
        res = await saveEmbeddingSettings({
          // Always standalone: no provider reference, endpoint + key live on
          // the embedding block itself.
          providerId: null,
          provider: useLegacyOllamaProtocol ? "ollama" : "openai-compatible",
          modelPath: undefined,
          poolingMode: undefined,
          baseUrl: embBaseUrl.trim() || undefined,
          ...(embApiKey.trim() ? { apiKey: embApiKey.trim() } : {}),
          ...(embClearKey ? { clearApiKey: true } : {}),
          model: embModel.trim() || undefined,
          dimensions: detectedDimensions,
          chunkSize: 2000,
          chunkOverlap: 200,
        });
      }
      setEmbApiKey("");
      setEmbClearKey(false);
      if (embClearKey) setEmbApiKeyConfigured(false);
      else if (embApiKey.trim()) setEmbApiKeyConfigured(true);
      setEmbLegacyProviderName(null);
      setEmbLegacyOllamaUrl(
        embSource === "remote" && useLegacyOllamaProtocol
          ? embBaseUrl.trim()
          : null
      );
      setEmbeddingSaved(true);
      window.setTimeout(() => setEmbeddingSaved(false), 2000);
      setSettingsVersion((v) => v + 1);

      // Trigger rebuild index warning popup when embedding model changed
      const currentModelKey = embSource === "onnx"
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
    patch: Partial<WebSearchForm[WebSearchProviderKind]>
  ) => {
    setWsForm((prev) => ({ ...prev, [kind]: { ...prev[kind], ...patch } }));
  };

  const saveWebSearch = async () => {
    setWsSaveError(null);
    const providers = WEB_SEARCH_PROVIDER_META.map((meta) => ({
      kind: meta.kind,
      enabled: wsForm[meta.kind].enabled,
      apiKeys: wsForm[meta.kind].apiKeys.filter((key) => !wsForm[meta.kind].removeApiKeyIds.includes(key.id)),
      baseUrl: wsForm[meta.kind].baseUrl.trim() || undefined,
    }));
    const keyChanges = WEB_SEARCH_PROVIDER_META
      .filter((meta) => !meta.needsUrl)
      .map(({ kind }) => ({
        kind,
        apiKeys: [
          ...providers.find((provider) => provider.kind === kind)!.apiKeys,
          ...(wsForm[kind].apiKey.trim()
            ? [{ id: `key-${crypto.randomUUID()}`, value: wsForm[kind].apiKey.trim(), configured: true as const }]
            : []),
        ],
      }));
    try {
      await saveWebSearchProviders(providers, keyChanges);
      setWsForm((previous) => Object.fromEntries(
        WEB_SEARCH_PROVIDER_META.map(({ kind }) => [kind, {
          ...previous[kind],
          apiKey: "",
          apiKeys: keyChanges.find((change) => change.kind === kind)?.apiKeys.map(({ id }) => ({ id, configured: true as const }))
            ?? providers.find((provider) => provider.kind === kind)!.apiKeys,
          removeApiKeyIds: [],
        }]),
      ) as unknown as WebSearchForm);
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

    saveSettingsPatch({ toolToggles: { disabled } })
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error ?? "Unknown error");
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
  /**
    * Build the reranker settings patch from current local state.
    */
  const buildRerankerPatch = (overrides?: { enabled?: boolean }) => ({
    reranker: {
      enabled: overrides?.enabled ?? rerankerEnabled,
      provider: rerankerProvider,
      ...(rerankerProvider === "onnx"
        ? {
            selectedModel: rerankerSelectedModel,
            idleTimeoutMinutes: rerankerIdleTimeoutMinutes,
          }
        : {
            baseUrl: rerankerBaseUrl,
            model: rerankerRemoteModel,
          }),
    },
  });

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

    saveSettingsPatch(buildRerankerPatch({ enabled }))
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error ?? "Unknown error");
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

    saveSettingsPatch({
      reranker: {
        provider: rerankerProvider,
        ...(rerankerProvider === "onnx"
          ? {
              enabled: rerankerEnabled,
              selectedModel: model,
              idleTimeoutMinutes: rerankerIdleTimeoutMinutes,
            }
          : {
              enabled: rerankerEnabled,
              baseUrl: rerankerBaseUrl,
              model: rerankerRemoteModel,
            }),
      },
    })
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error ?? "Unknown error");
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
   * Update the session idle timeout (in minutes) and auto-save the change.
   */
  const handleChangeRerankerIdleTimeout = (minutes: number) => {
    setRerankerIdleTimeoutMinutes(minutes);
    setRerankerSaved(false);
    setRerankerSaveError(null);

    saveSettingsPatch({
      reranker: {
        provider: rerankerProvider,
        ...(rerankerProvider === "onnx"
          ? {
              enabled: rerankerEnabled,
              selectedModel: rerankerSelectedModel,
              idleTimeoutMinutes: minutes,
            }
          : {
              enabled: rerankerEnabled,
              baseUrl: rerankerBaseUrl,
              model: rerankerRemoteModel,
            }),
      },
    })
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error ?? "Unknown error");
        }
        setRerankerSaved(true);
        setSettingsVersion((v) => v + 1);
        window.setTimeout(() => setRerankerSaved(false), 2000);
      })
      .catch((err) => {
        setRerankerSaveError(
          err instanceof Error
            ? err.message
            : "Failed to save idle timeout."
        );
      });
  };

  /**
   * Handle complete deletion of a model file or directory.
   */
  const handleRerankerModelDeleted = (filename: string) => {
    if (rerankerSelectedModel === filename || rerankerSelectedModel.includes(filename)) {
      setRerankerSelectedModel("");
    }
    setSettingsVersion((v) => v + 1);
  };

  /**
   * Explicit save handler for the RerankerTab Save button.
   */
  const handleSaveReranker = async () => {
    setRerankerSaving(true);
    setRerankerSaved(false);
    setRerankerSaveError(null);
    try {
      const result = await saveSettingsPatch(buildRerankerPatch());
      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error");
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

  /**
   * Switch reranker provider mode (local ONNX ↔ remote). Saves immediately.
   */
  const handleRerankerProviderChange = (next: "onnx" | "openai-compatible") => {
    setRerankerProvider(next);
    setRerankerSaved(false);
    setRerankerSaveError(null);
    saveSettingsPatch(buildRerankerPatch())
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error ?? "Unknown error");
        }
        setRerankerSaved(true);
        setSettingsVersion((v) => v + 1);
        window.setTimeout(() => setRerankerSaved(false), 2000);
      })
      .catch((err) => {
        setRerankerSaveError(
          err instanceof Error
            ? err.message
            : "Failed to save provider change."
        );
      });
  };

  /**
   * Update the remote reranker base URL. Saves immediately.
   */
  const handleRerankerBaseUrlChange = (value: string) => {
    setRerankerBaseUrl(value);
    setRerankerSaved(false);
    setRerankerSaveError(null);
    saveSettingsPatch(buildRerankerPatch())
      .then((result) => {
        if (!result.ok) throw new Error(result.error ?? "Unknown error");
        setRerankerSaved(true);
        setSettingsVersion((v) => v + 1);
        window.setTimeout(() => setRerankerSaved(false), 2000);
      })
      .catch((err) => {
        setRerankerSaveError(
          err instanceof Error
            ? err.message
            : "Failed to save base URL."
        );
      });
  };

  /**
   * Update the remote reranker model name. Saves immediately.
   */
  const handleRerankerRemoteModelChange = (value: string) => {
    setRerankerRemoteModel(value);
    setRerankerSaved(false);
    setRerankerSaveError(null);
    saveSettingsPatch(buildRerankerPatch())
      .then((result) => {
        if (!result.ok) throw new Error(result.error ?? "Unknown error");
        setRerankerSaved(true);
        setSettingsVersion((v) => v + 1);
        window.setTimeout(() => setRerankerSaved(false), 2000);
      })
      .catch((err) => {
        setRerankerSaveError(
          err instanceof Error
            ? err.message
            : "Failed to save model name."
        );
      });
  };

  // Probe the configured endpoint and store the model's native vector
  // dimension.
  const detectDimensions = async () => {
    setDetectBusy(true);
    setDetectResult(null);
    const result = await runEmbeddingProbe();
    if (result.ok && result.dimensions) {
      setEmbDimensions(result.dimensions);
      lastProbeKeyRef.current = embeddingProbeKey;
    }
    setDetectResult({ ok: result.ok, text: result.text });
    setDetectBusy(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent
          className={cn(
            // Mobile: fullscreen, no rounding, no transform offset.
            // sm:max-w-none: tailwind-merge only dedupes same-modifier
            // classes, so the base DialogContent's `sm:max-w-md` would
            // survive the unprefixed max-w-* here and cap the dialog at
            // 448px on 640–767px viewports.
            "fixed inset-0 z-50 w-full max-w-none sm:max-w-none h-full translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0",
            // Desktop: centered, floating with constrained size
            "md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:max-w-4xl md:w-[calc(100%-2rem)] md:h-[min(720px,85dvh)] md:rounded-xl",
            "overflow-hidden max-w-full",
          )}
          showCloseButton
        >
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Application settings. Press Escape to close.
          </DialogDescription>

          <Tabs
            // Mobile: column (tabs nav above, content below)
            // Desktop: row (sidebar nav left, content right, both full height)
            // min-w-0: DialogContent is a grid; without it the grid item's
            // min-content contribution (wide <pre>/URL content) sizes the
            // auto track beyond the dialog width, making the pane render
            // wider than the dialog and clipping content mid-line.
            className="flex flex-col h-full w-full min-h-0 min-w-0 gap-0 md:flex-row"
            onValueChange={(value) => setActiveTab(value as SettingsTab)}
            orientation={isMobile ? "horizontal" : "vertical"}
            value={activeTab}
          >
            {/* Desktop: sidebar nav on left (fixed width, full height, scrollable). */}
            {!isMobile && (
              // justify-start overrides the base `justify-center`: in this
              // column list it would vertically center the menu block
              // instead of running it top-to-bottom.
              <TabsList className="flex-col justify-start h-full min-h-0 w-56 shrink-0 items-start gap-1 border-r bg-muted/40 p-3 overflow-y-auto [scrollbar-gutter:stable]">
                {SETTINGS_TABS.map((tab) => (
                  <TabsTrigger
                    // flex-none overrides the base `flex-1` (needed for equal
                    // widths in horizontal mode): in this column list it would
                    // stretch each item to ~70px, overriding h-9 via
                    // flex-basis:0% + grow:1 and spacing the menu out.
                    className="flex-none h-9 rounded-md justify-start gap-2 px-3 w-full"
                    key={tab.value}
                    value={tab.value}
                  >
                    <tab.icon className="size-4 shrink-0" />
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            )}

            {/* Mobile: horizontal nav at top.
                h-auto keeps the strip sized to its 36px triggers + p-3; the
                tabs base no longer forces a height (it used to pin h-8 and
                clip this strip). justify-start: base `justify-center` +
                overflow-x makes the first tabs unreachable (scrollLeft
                cannot go negative). */}
            {isMobile && (
              <TabsList className="flex-row h-auto w-full min-w-full items-center justify-start gap-1 p-3 border-b overflow-x-auto">
                {SETTINGS_TABS.map((tab) => (
                  <TabsTrigger
                    className="h-9 rounded-md px-3 shrink-0"
                    key={tab.value}
                    value={tab.value}
                  >
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            )}

            {/* Right pane: header + scrollable content */}
            <div className="flex flex-col flex-1 min-h-0 min-w-0">
              {/* Header (desktop only; sits above the scroll container, so no sticky needed) */}
              {!isMobile && (
                <div className="shrink-0 border-b bg-popover px-6 py-4">
                  <h2 className="text-lg font-semibold">
                    {SETTINGS_TABS.find((t) => t.value === activeTab)?.label}
                  </h2>
                  <p className="text-muted-foreground text-xs mt-0.5">
                    {SETTINGS_TAB_INTROS[activeTab]}
                  </p>
                </div>
              )}

              {/* Scrollable content area.
                  overflow-x-hidden + w-full on the wrapper constrain wide <pre>
                  content so the tabpanel never stretches beyond the dialog. */}
              <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]">
                <div className={cn("w-full min-w-0", isMobile ? "px-4 py-3" : "px-6 py-4")}>
                  {loadError && (
                    <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
                      Could not load server configuration.
                    </p>
                  )}

                  {isMobile && (
                    <p className="mb-3 text-muted-foreground text-xs">
                      {SETTINGS_TAB_INTROS[activeTab]}
                    </p>
                  )}

                  <TabsContent value="general">
                    <GeneralTab />
                  </TabsContent>

                  <TabsContent className="space-y-4" value="persona">
                    <PersonaTab
                      persona={persona}
                      defaultPersona={defaultPersona}
                      onSave={handleSavePersona}
                      onReset={handleResetPersona}
                      onDirtyChange={setPersonaDirty}
                    />
                  </TabsContent>

                  <TabsContent className="space-y-4" value="provider">
                    <ProviderTab
                      addModel={addModel}
                      addOllama={addOllama}
                      addGguf={addGguf}
                      addOpenaiProvider={addOpenaiProvider}
                      addNimProvider={() => setNimForm({})}
                      deleteModel={deleteModel}
                      deleteProvider={deleteProvider}
                      editModel={editModel}
                      editProvider={editProvider}
                      onProvidersChange={() => {
                        // A web-provider discovery writes models server-side; re-read the
                        // registry so a newly discovered model reaches the selectors.
                        void hydrateSettings().then(() => setProviders(getProviders()));
                      }}
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
                      detectResult={detectResult}
                      setDetectResult={setDetectResult}
                      embApiKey={embApiKey}
                      embApiKeyConfigured={embApiKeyConfigured}
                      clearEmbApiKey={clearEmbApiKey}
                      embBaseUrl={embBaseUrl}
                      embDimensions={embDimensions}
                      setEmbDimensions={setEmbDimensions}
                      embModel={embModel}
                      embSaveError={embSaveError}
                      embCanForceSave={embCanForceSave}
                      embeddingSaved={embeddingSaved}
                      embSource={embSource}
                      setEmbSource={setEmbSource}
                      legacyProviderName={embLegacyProviderName}
                      saveEmbedding={saveEmbedding}
                      setEmbApiKey={(value) => {
                        setEmbApiKey(value);
                        // Typing a key cancels a pending clear.
                        if (value) setEmbClearKey(false);
                      }}
                      setEmbBaseUrl={setEmbBaseUrl}
                      setEmbModel={setEmbModel}
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
                      provider={rerankerProvider}
                      baseUrl={rerankerBaseUrl}
                      remoteModel={rerankerRemoteModel}
                      idleTimeoutMinutes={rerankerIdleTimeoutMinutes}
                      onChangeIdleTimeoutMinutes={handleChangeRerankerIdleTimeout}
                      onChangeProvider={handleRerankerProviderChange}
                      onChangeBaseUrl={handleRerankerBaseUrlChange}
                      onChangeRemoteModel={handleRerankerRemoteModelChange}
                      onSave={handleSaveReranker}
                      onSelectModel={handleSelectRerankerModel}
                      onToggleEnabled={handleToggleReranker}
                      onModelInstalled={(repo) => handleModelInstalled("reranker", repo)}
                      onModelDeleted={handleRerankerModelDeleted}
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
                      dbBusy={dbBusy}
                      dbNote={dbNote}
                      dbNoteKind={dbNoteKind}
                      optimizeDatabase={optimizeDatabase}
                      resetDatabaseNow={resetDatabaseNow}
                      diagnostics={diagnostics}
                      diagnosticsBusy={diagnosticsBusy}
                      refreshDiagnostics={refreshDiagnostics}
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
                </div>
              </div>
            </div>
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

      {nimForm && (
        <NimProviderDialog
          provider={nimForm.provider}
          onClose={() => setNimForm(null)}
          onSave={async (input) => {
            if (nimForm.provider) {
              await saveProviders(providers.map((provider) => provider.id === input.id ? input : provider));
            } else {
              await addProvider(input);
            }
            setProviders(getProviders());
          }}
        />
      )}

      {/* GGUF Model Add Dialog */}
      <Dialog open={ggufDialogOpen} onOpenChange={(open) => { if (!open) setGgufDialogOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add GGUF Model</DialogTitle>
            <DialogDescription>
              {ggufBusy
                ? "Probing for llama-server…"
                : ggufServerFound === false
                  ? "llama-server is not installed."
                  : ggufServerFound === true && ggufModels.length > 0
                    ? "Select the GGUF model(s) to add."
                    : "No GGUF models found in data/models/GGUF-chatModel."}
            </DialogDescription>
          </DialogHeader>

          {ggufServerFound === true && ggufServerPath && (
            <Alert variant="default">
              <CheckCircle className="size-4 text-success" />
              <AlertTitle>llama-server detected</AlertTitle>
              <AlertDescription className="mt-1 text-sm break-all">
                {ggufServerPath}
              </AlertDescription>
            </Alert>
          )}

          {ggufError && (
            <Alert variant="destructive">
              <Warning className="size-4" />
              <AlertDescription>{ggufError}</AlertDescription>
            </Alert>
          )}

          {ggufServerFound === false && (
            // Install banner: llama-server binary not found.
            <Alert>
              <Warning className="size-4" />
              <AlertTitle>llama-server not found</AlertTitle>
              <AlertDescription className="mt-2 space-y-3">
                <p>
                  Install llama-server to enable GGUF model support:
                </p>
                <a
                  href="https://llama.app/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm underline"
                >
                  Visit https://llama.app/ for installer
                </a>
                <div className="mt-2">
                  <pre className="bg-muted rounded p-2 text-xs overflow-x-auto select-all">
                    curl -LsSf https://llama.app/install.sh | sh
                  </pre>
                </div>
                <p className="text-xs">
                  If llama-server is already installed but not on your PATH,
                  enter its path below:
                </p>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    placeholder="/usr/local/bin/llama-server"
                    value={ggufCustomServerPath}
                    onChange={(e) => setGgufCustomServerPath(e.target.value)}
                    disabled={ggufBusy}
                    className="font-mono text-xs flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={ggufBusy || !ggufCustomServerPath}
                    onClick={() => {
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
                    }}
                  >
                    Re-probe
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {ggufServerFound === true && ggufModels.length > 0 && (
            // Model list with checkboxes (multi-select).
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {ggufModels.map((m) => {
                const checked = ggufSelectedModels.has(m.filename);
                return (
                  <label
                    key={m.filename}
                    className="flex items-center gap-3 p-2 border rounded cursor-pointer hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = new Set(ggufSelectedModels);
                        if (e.target.checked) next.add(m.filename);
                        else next.delete(m.filename);
                        setGgufSelectedModels(next);
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{m.filename.replace(/\.gguf$/i, "")}</div>
                      <div className="text-sm text-muted-foreground flex gap-2">
                        <span>{formatBytes(m.sizeBytes)}</span>
                        {!m.fitsMemory && (
                          <Badge variant="destructive" className="text-xs">
                            over-memory
                          </Badge>
                        )}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {ggufServerFound === true && ggufModels.length === 0 && !ggufBusy && (
            // Empty state: no models found.
            <Alert>
              <Warning className="size-4" />
              <AlertTitle>No GGUF models found</AlertTitle>
              <AlertDescription className="mt-2 space-y-2">
                <p>Download a GGUF model from Hugging Face and place it in:</p>
                <pre className="bg-muted rounded p-2 text-xs overflow-x-auto select-all">
                  data/models/GGUF-chatModel
                </pre>
              </AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {ggufServerFound === true && ggufServerVersion !== null && (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-success" />
                  llama-server build {ggufServerVersion}
                </span>
              )}
              {ggufServerFound === true && ggufServerVersion === null && (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-warning" />
                  llama-server detected (version unknown)
                </span>
              )}
              {ggufServerFound === false && !ggufError && (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-destructive" />
                  llama-server not found
                </span>
              )}
            </div>
            <Button variant="outline" onClick={() => setGgufDialogOpen(false)} disabled={ggufBusy}>
              Cancel
            </Button>
            <Button
              onClick={ggufDialogConfirm}
              disabled={ggufBusy || ggufServerFound !== true || ggufSelectedModels.size === 0}
            >
              Add
            </Button>
          </DialogFooter>
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
        providerKind={
          providers.find((p) => p.id === modelFormTargetProviderId)?.kind
        }
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

      <ConfirmDialog
        open={confirmDiscardOpen}
        onOpenChange={setConfirmDiscardOpen}
        title="Unsaved changes"
        description="You have unsaved changes. Are you sure you want to close? They will be lost."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={confirmAndClose}
      />
        </DialogContent>
      </Dialog>
    </>
  );
}
