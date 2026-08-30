"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { PageView } from "@/components/app-shell/page-view";
import { SettingsSummary } from "@/components/settings/settings-summary";
import {
  AboutTab,
  DatabaseTab,
  EmbeddingTab,
  GeneralTab,
  ProviderTab,
  ToolsTab,
} from "@/components/settings/tabs";
import {
  addProvider,
  createProviderId,
  getEmbeddingSettings,
  getProviders,
  getWebSearchProviders,
  removeProvider,
  saveEmbeddingSettings,
  saveWebSearchProviders,
  type EmbeddingProviderKind,
  type ProviderConfig,
  type WebSearchProviderKind,
} from "@/lib/settings";
import { useEffect, useState } from "react";

/** The six settings tabs in rail/switcher order. */
const SETTINGS_TABS = [
  { value: "general", label: "General" },
  { value: "provider", label: "AI Provider" },
  { value: "embedding", label: "Embedding Provider" },
  { value: "database", label: "Database" },
  { value: "tools", label: "Tools" },
  { value: "about", label: "About" },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];

type SettingsSnapshot = {
  ai: { baseUrl: string | null; modelId: string; apiKeyConfigured: boolean };
  embedding: {
    provider: "server" | "openai-compatible" | "ollama";
    baseUrl: string | null;
    model: string;
    apiKeyConfigured: boolean;
    dimensions: number | null;
    chunkSize: number;
    chunkOverlap: number;
    fallback: string;
  };
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
  /** Mutable settings store persisted in the database. */
  store: {
    providers: ProviderConfig[];
    embedding: {
      provider?: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      dimensions?: number;
      chunkSize?: number;
      chunkOverlap?: number;
    };
    websearch?: {
      providers?: Array<{
        kind: WebSearchProviderKind;
        enabled: boolean;
        apiKey?: string;
        baseUrl?: string;
      }>;
    };
  };
};

/** Display metadata for the web search providers in priority order. */
const WEB_SEARCH_PROVIDER_META: Array<{
  kind: WebSearchProviderKind;
  label: string;
  /** SearXNG needs an instance URL; the others need an API key. */
  needsUrl: boolean;
  envHint: string;
}> = [
  {
    kind: "exa",
    label: "Exa",
    needsUrl: false,
    envHint: "Falls back to EXA_API_KEY when empty",
  },
  {
    kind: "firecrawl",
    label: "Firecrawl",
    needsUrl: false,
    envHint: "Falls back to FIRECRAWL_API_KEY when empty",
  },
  {
    kind: "searxng",
    label: "SearXNG (self-hosted)",
    needsUrl: true,
    envHint: "Falls back to SEARXNG_BASE_URL when empty",
  },
];

const MAINTENANCE_LABELS: Record<
  "light_sleep" | "dream_cycle" | "decay_sweep",
  string
> = {
  light_sleep: "Light sleep",
  dream_cycle: "Dream cycle",
  decay_sweep: "Deep sleep sweep",
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

  // ---- Embedding provider (used by the memory system) ----
  // Lazy initializers read the hydrated settings cache at mount —
  // SettingsView only mounts after hydration (behind the AppShell gate
  // + a user click), and the snapshot fetch below re-syncs from the
  // database.
  const [embProvider, setEmbProvider] = useState<EmbeddingProviderKind>(
    () => getEmbeddingSettings().provider ?? "server"
  );
  const [embBaseUrl, setEmbBaseUrl] = useState(
    () => getEmbeddingSettings().baseUrl ?? ""
  );
  const [embApiKey, setEmbApiKey] = useState(
    () => getEmbeddingSettings().apiKey ?? ""
  );
  const [embModel, setEmbModel] = useState(
    () => getEmbeddingSettings().model ?? ""
  );
  const [embDimensions, setEmbDimensions] = useState<number | null>(
    () => getEmbeddingSettings().dimensions ?? null
  );
  const [embeddingSaved, setEmbeddingSaved] = useState(false);
  const [embSaveError, setEmbSaveError] = useState<string | null>(null);
  const [detectBusy, setDetectBusy] = useState(false);
  const [detectResult, setDetectResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [ollamaDetectBusy, setOllamaDetectBusy] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);

  // ---- Web search provider chain (powers the web_search tool) ----
  const [wsForm, setWsForm] = useState<WebSearchForm>(() =>
    webSearchFormFromEntries(getWebSearchProviders())
  );
  const [wsSaved, setWsSaved] = useState(false);
  const [wsSaveError, setWsSaveError] = useState<string | null>(null);
  // Bumped after saving so the snapshot (status badges, effective chain)
  // is re-fetched from the server.
  const [settingsVersion, setSettingsVersion] = useState(0);

  // Active settings tab — single source of truth shared by the desktop
  // rail (TabsList) and the mobile Select switcher.
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

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
        const emb = data.store?.embedding ?? {};
        setEmbProvider(
          emb.provider === "ollama" || emb.provider === "openai-compatible"
            ? emb.provider
            : "server"
        );
        setEmbBaseUrl(typeof emb.baseUrl === "string" ? emb.baseUrl : "");
        setEmbApiKey(typeof emb.apiKey === "string" ? emb.apiKey : "");
        setEmbModel(typeof emb.model === "string" ? emb.model : "");
        setEmbDimensions(
          typeof emb.dimensions === "number" ? emb.dimensions : null
        );
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
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
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

  const saveEmbedding = async () => {
    setEmbSaveError(null);
    try {
      await saveEmbeddingSettings({
        provider: embProvider,
        baseUrl:
          embProvider === "server" ? undefined : embBaseUrl.trim() || undefined,
        apiKey:
          embProvider === "openai-compatible"
            ? embApiKey.trim() || undefined
            : undefined,
        model: embModel.trim() || undefined,
        dimensions: embDimensions ?? undefined,
        chunkSize: 2000,
        chunkOverlap: 200,
      });
      setEmbeddingSaved(true);
      window.setTimeout(() => setEmbeddingSaved(false), 2000);
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

  // Probe the configured endpoint and store the model's native vector
  // dimension.
  const detectDimensions = async () => {
    setDetectBusy(true);
    setDetectResult(null);
    try {
      const res = await fetch("/api/embeddings/detect", {
        body: JSON.stringify({
          provider: embProvider,
          baseUrl: embBaseUrl.trim() || undefined,
          apiKey: embApiKey.trim() || undefined,
          model: embModel.trim() || undefined,
        }),
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

  // While Ollama is the embedding provider, list its installed models
  // whenever the base URL looks valid.
  useEffect(() => {
    if (embProvider !== "ollama") return;
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
  }, [embProvider, embBaseUrl]);

  return (
    <PageView onBack={onBack} title="Settings">
      {loadError && (
        <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
          Could not load server configuration.
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <Tabs
            className="flex-col gap-6 lg:flex-row"
            onValueChange={(value) => setActiveTab(value as SettingsTab)}
            orientation="vertical"
            value={activeTab}
          >
            {/* Desktop rail: the tab list rendered as a vertical column.
                Mobile uses the Select below; both bind the same Tabs
                value so there is a single source of tab state. */}
            <TabsList className="hidden h-fit w-56 flex-col items-stretch gap-1 lg:flex">
              {SETTINGS_TABS.map((tab) => (
                <TabsTrigger
                  className="justify-start"
                  key={tab.value}
                  value={tab.value}
                >
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>

            {/* Mobile switcher: six segments overflow a segmented bar at
                360px, so below lg navigation is a labeled Select. */}
            <div className="mb-4 w-full lg:hidden">
              <Select
                aria-label={`Settings section: ${SETTINGS_TABS.find((t) => t.value === activeTab)?.label}`}
                onValueChange={(value) =>
                  setActiveTab(value as SettingsTab)
                }
                value={activeTab}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SETTINGS_TABS.map((tab) => (
                    <SelectItem key={tab.value} value={tab.value}>
                      {tab.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="min-w-0 flex-1">
              <TabsContent value="general">
                <GeneralTab />
              </TabsContent>

          <TabsContent className="space-y-4" value="provider">
            <ProviderTab
              addOllama={addOllama}
              addOpenaiProvider={addOpenaiProvider}
              aiConfig={settings?.ai ?? null}
              deleteProvider={deleteProvider}
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
              aiConfig={settings?.ai ?? null}
              detectBusy={detectBusy}
              detectDimensions={detectDimensions}
              detectOllamaUrl={detectOllamaUrl}
              detectResult={detectResult}
              setDetectResult={setDetectResult}
              embApiKey={embApiKey}
              embBaseUrl={embBaseUrl}
              embDimensions={embDimensions}
              setEmbDimensions={setEmbDimensions}
              embModel={embModel}
              embProvider={embProvider}
              embSaveError={embSaveError}
              embeddingSaved={embeddingSaved}
              ollamaDetectBusy={ollamaDetectBusy}
              ollamaModels={ollamaModels}
              saveEmbedding={saveEmbedding}
              setEmbApiKey={setEmbApiKey}
              setEmbBaseUrl={setEmbBaseUrl}
              setEmbModel={setEmbModel}
              setEmbProvider={setEmbProvider}
            />
          </TabsContent>

          <TabsContent value="database">
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
              saveWebSearch={saveWebSearch}
              tools={settings?.tools ?? null}
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
          </Tabs>
        </div>

        {/* Tab-reactive summary column (md+). Below md the grid stacks;
            the summary appears after the tab content, keeping every tab's
            overview reachable on mobile without a second nav pattern. */}
        <div className="min-w-0">
          <div className="hidden md:block">
            <SettingsSummary
              providers={providers}
              settings={settings}
              tab={activeTab}
            />
          </div>
        </div>
      </div>
    </PageView>
  );
}

