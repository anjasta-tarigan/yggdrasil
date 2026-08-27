"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { ThemeToggle } from "@/components/theme-toggle";
import {
  addProvider,
  createProviderId,
  getEmbeddingSettings,
  getProviders,
  removeProvider,
  saveEmbeddingSettings,
  type EmbeddingProviderKind,
  type ProviderConfig,
} from "@/lib/settings";
import {
  ArrowClockwise,
  ArrowLeft,
  Check,
  Database,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";

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
  };
  tools: Array<{
    name: string;
    description: string;
    configured: boolean;
    requires: string | null;
  }>;
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
  };
};

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
  const [detectBusy, setDetectBusy] = useState(false);
  const [detectResult, setDetectResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [ollamaDetectBusy, setOllamaDetectBusy] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);

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
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Defensive views over the database stats: a snapshot fetched from an
  // older server (e.g. during hot reload) may lack the newer fields, and
  // the panel must render instead of crashing.
  const db = settings?.database;
  const dbMemories = db?.memories;
  const dbQueue = db?.queue;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <Button onClick={onBack} size="sm" type="button" variant="ghost">
            <ArrowLeft className="size-4" />
            Back to chat
          </Button>
        </div>

        {loadError && (
          <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
            Could not load server configuration.
          </p>
        )}

        <Tabs defaultValue="general">
          <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="provider">AI Provider</TabsTrigger>
            <TabsTrigger value="embedding">Embedding Provider</TabsTrigger>
            <TabsTrigger value="database">Database</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
            <TabsTrigger value="about">About</TabsTrigger>
          </TabsList>

          {/* ── General ─────────────────────────────────────────── */}
          <TabsContent value="general">
            <Card>
              <CardHeader>
                <CardTitle>Appearance</CardTitle>
                <CardDescription>
                  Theme preference applies immediately and is remembered on
                  this device.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ThemeToggle />
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── AI Provider ─────────────────────────────────────── */}
          <TabsContent className="space-y-4" value="provider">
            <Card>
              <CardHeader>
                <CardTitle>This server</CardTitle>
                <CardDescription>
                  The built-in provider from the server environment
                  (.env.local). Always available.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                <ConfigRow
                  label="Base URL"
                  value={settings?.ai.baseUrl ?? "—"}
                />
                <ConfigRow
                  label="Default model"
                  value={settings?.ai.modelId ?? "—"}
                />
                <ConfigRow
                  label="API key"
                  value={
                    settings
                      ? settings.ai.apiKeyConfigured
                        ? "Configured"
                        : "Not set"
                      : "—"
                  }
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Providers</CardTitle>
                <CardDescription>
                  Every provider you add becomes active immediately — all of
                  their models appear grouped in the chat model selector.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {providers.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No extra providers yet. Add Ollama or any
                    OpenAI-compatible endpoint below.
                  </p>
                ) : (
                  providers.map((provider) => (
                    <div
                      className="flex items-center justify-between gap-3 rounded-lg border p-3"
                      key={provider.id}
                    >
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-medium text-sm">
                          <span className="truncate">{provider.name}</span>
                          <Badge variant="outline">
                            {provider.kind === "ollama"
                              ? "Ollama"
                              : "OpenAI-compatible"}
                          </Badge>
                        </p>
                        <p className="truncate text-muted-foreground text-xs">
                          {provider.baseUrl}
                        </p>
                      </div>
                      <Button
                        aria-label={`Remove ${provider.name}`}
                        onClick={() => deleteProvider(provider.id)}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <Trash className="size-4" />
                      </Button>
                    </div>
                  ))
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    disabled={ollamaBusy}
                    onClick={addOllama}
                    type="button"
                    variant="outline"
                  >
                    {ollamaBusy ? (
                      <ArrowClockwise className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    Add Ollama
                  </Button>
                  <Button
                    onClick={() => {
                      setOpenaiFormOpen((open) => !open);
                      setOaError(null);
                    }}
                    type="button"
                    variant="outline"
                  >
                    <Plus className="size-4" />
                    Add OpenAI-compatible
                  </Button>
                </div>

                {ollamaError && (
                  <p className="text-destructive text-xs">{ollamaError}</p>
                )}

                {openaiFormOpen && (
                  <div className="space-y-3 rounded-lg border p-3">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium" htmlFor="oa-name">
                        Name
                      </label>
                      <Input
                        id="oa-name"
                        onChange={(e) => setOaName(e.target.value)}
                        placeholder="My provider"
                        value={oaName}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label
                        className="text-sm font-medium"
                        htmlFor="oa-base-url"
                      >
                        Base URL
                      </label>
                      <Input
                        id="oa-base-url"
                        onChange={(e) => setOaBaseUrl(e.target.value)}
                        placeholder="https://api.example.com/v1"
                        value={oaBaseUrl}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label
                        className="text-sm font-medium"
                        htmlFor="oa-api-key"
                      >
                        API key
                      </label>
                      <Input
                        id="oa-api-key"
                        onChange={(e) => setOaApiKey(e.target.value)}
                        placeholder="Optional bearer token"
                        type="password"
                        value={oaApiKey}
                      />
                      <p className="text-muted-foreground text-xs">
                        Kept in this browser only. The connection is tested
                        before saving.
                      </p>
                    </div>
                    {oaError && (
                      <p className="text-destructive text-xs">{oaError}</p>
                    )}
                    <Button
                      disabled={oaBusy || !oaBaseUrl.trim()}
                      onClick={addOpenaiProvider}
                      type="button"
                    >
                      {oaBusy ? "Testing connection…" : "Validate & add"}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Embedding Provider ──────────────────────────────── */}
          <TabsContent className="space-y-4" value="embedding">
            <Card>
              <CardHeader>
                <CardTitle>Provider</CardTitle>
                <CardDescription>
                  Embeddings power memory search. Choose where they are
                  computed: the built-in server endpoint, a local Ollama, or
                  any OpenAI-compatible cloud endpoint. A deterministic local
                  fallback keeps memory working when nothing is reachable.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    Embedding provider
                  </label>
                  <Select
                    onValueChange={(value) => {
                      setEmbProvider(value as EmbeddingProviderKind);
                      setDetectResult(null);
                    }}
                    value={embProvider}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="server">
                        This server (environment)
                      </SelectItem>
                      <SelectItem value="ollama">Ollama (local)</SelectItem>
                      <SelectItem value="openai-compatible">
                        OpenAI-compatible (cloud)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {embProvider === "server" ? (
                  <div className="space-y-1.5 rounded-md border p-3 text-sm">
                    <ConfigRow
                      label="Endpoint"
                      value={settings?.ai.baseUrl ?? "—"}
                    />
                    <ConfigRow
                      label="API key"
                      value={
                        settings?.ai.apiKeyConfigured
                          ? "Configured"
                          : "Not configured"
                      }
                    />
                  </div>
                ) : null}

                {embProvider === "ollama" ? (
                  <>
                    <div className="space-y-1.5">
                      <label
                        className="text-sm font-medium"
                        htmlFor="emb-base-url"
                      >
                        Base URL
                      </label>
                      <div className="flex gap-2">
                        <Input
                          id="emb-base-url"
                          onChange={(e) => setEmbBaseUrl(e.target.value)}
                          placeholder="http://localhost:11434"
                          value={embBaseUrl}
                        />
                        <Button
                          disabled={ollamaDetectBusy}
                          onClick={detectOllamaUrl}
                          type="button"
                          variant="outline"
                        >
                          <ArrowClockwise
                            className={
                              ollamaDetectBusy ? "size-4 animate-spin" : "size-4"
                            }
                          />
                          Detect
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Model</label>
                      <Select
                        onValueChange={(value) => {
                          setEmbModel(value);
                          setEmbDimensions(null);
                          setDetectResult(null);
                        }}
                        value={embModel}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select an embedding model…" />
                        </SelectTrigger>
                        <SelectContent>
                          {ollamaModels.map((m) => (
                            <SelectItem key={m} value={m}>
                              {m}
                            </SelectItem>
                          ))}
                          {embModel && !ollamaModels.includes(embModel) ? (
                            <SelectItem value={embModel}>{embModel}</SelectItem>
                          ) : null}
                        </SelectContent>
                      </Select>
                      {ollamaModels.length === 0 ? (
                        <p className="text-muted-foreground text-xs">
                          No models found at this URL — pull an embedding
                          model first (e.g. `ollama pull nomic-embed-text`).
                        </p>
                      ) : null}
                    </div>
                  </>
                ) : null}

                {embProvider === "openai-compatible" ? (
                  <>
                    <div className="space-y-1.5">
                      <label
                        className="text-sm font-medium"
                        htmlFor="emb-oa-base-url"
                      >
                        Base URL
                      </label>
                      <Input
                        id="emb-oa-base-url"
                        onChange={(e) => setEmbBaseUrl(e.target.value)}
                        placeholder="https://api.openai.com/v1"
                        value={embBaseUrl}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label
                        className="text-sm font-medium"
                        htmlFor="emb-oa-api-key"
                      >
                        API key
                      </label>
                      <Input
                        id="emb-oa-api-key"
                        onChange={(e) => setEmbApiKey(e.target.value)}
                        placeholder="sk-…"
                        type="password"
                        value={embApiKey}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label
                        className="text-sm font-medium"
                        htmlFor="emb-oa-model"
                      >
                        Model
                      </label>
                      <Input
                        id="emb-oa-model"
                        onChange={(e) => setEmbModel(e.target.value)}
                        placeholder="text-embedding-3-small"
                        value={embModel}
                      />
                    </div>
                  </>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Dimensions & chunking</CardTitle>
                <CardDescription>
                  The vector dimension is auto-detected by probing the model.
                  Long memories are split into overlapping chunks and
                  mean-pooled into one vector per memory.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">
                      Vector dimensions
                    </div>
                    <div className="text-muted-foreground text-xs">
                      Native output size of the selected model
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">
                      {embDimensions ? `${embDimensions}d` : "unknown"}
                    </Badge>
                    <Button
                      disabled={detectBusy}
                      onClick={detectDimensions}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <ArrowClockwise
                        className={
                          detectBusy ? "size-4 animate-spin" : "size-4"
                        }
                      />
                      {detectBusy ? "Detecting…" : "Auto-detect"}
                    </Button>
                  </div>
                </div>
                {detectResult ? (
                  <p
                    className={
                      detectResult.ok
                        ? "text-xs text-emerald-600 dark:text-emerald-400"
                        : "text-destructive text-xs"
                    }
                  >
                    {detectResult.text}
                  </p>
                ) : null}

                <div className="flex items-center justify-between gap-4 border-t pt-3">
                  <div>
                    <div className="text-sm font-medium">Text chunking</div>
                    <div className="text-muted-foreground text-xs">
                      Preset to recommended 2,000 chars (≈512 tokens) with 200
                      char overlap (10%)
                    </div>
                  </div>
                  <Badge variant="secondary">2,000 / 200</Badge>
                </div>

                <Button onClick={saveEmbedding} type="button">
                  {embeddingSaved ? <Check className="size-4" /> : null}
                  {embeddingSaved ? "Saved" : "Save embedding settings"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Database ───────────────────────────────────────── */}
          <TabsContent value="database">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="size-4" />
                  Database
                </CardTitle>
                <CardDescription>
                  Conversations, settings and memories persist in a local
                  SQLite database on this server. These statistics are read
                  live from the database file.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                <ConfigRow label="Engine" value={db?.engine ?? "—"} />
                <ConfigRow label="Driver" value={db?.driver ?? "—"} />
                <ConfigRow
                  label="Features"
                  value={db?.features?.join(", ") ?? "—"}
                />
                <ConfigRow label="File" value={db?.path || "—"} />
                <ConfigRow
                  label="Size"
                  value={db ? formatBytes(db.sizeBytes ?? 0) : "—"}
                />
                <div className="my-2 border-t" />
                <ConfigRow
                  label="Chats"
                  value={db ? String(db.chatCount ?? 0) : "—"}
                />
                <ConfigRow
                  label="Messages"
                  value={db ? String(db.messageCount ?? 0) : "—"}
                />
                <ConfigRow
                  label="Memories"
                  value={
                    dbMemories
                      ? `${dbMemories.episodic ?? 0} episodic · ${dbMemories.semantic ?? 0} semantic · ${dbMemories.working ?? 0} working`
                      : "—"
                  }
                />
                <ConfigRow
                  label="Job queue"
                  value={
                    dbQueue
                      ? `${dbQueue.completed ?? 0} completed · ${dbQueue.pending ?? 0} pending · ${dbQueue.failed ?? 0} failed`
                      : "—"
                  }
                />
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Tools ───────────────────────────────────────────── */}
          <TabsContent value="tools">
            <Card>
              <CardHeader>
                <CardTitle>Chat tools</CardTitle>
                <CardDescription>
                  Server-side tools the assistant can call during a
                  conversation.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(settings?.tools ?? []).map((tool) => (
                  <div
                    className="flex items-start justify-between gap-3 rounded-lg border p-3"
                    key={tool.name}
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-sm">{tool.name}</p>
                      <p className="text-muted-foreground text-xs">
                        {tool.description}
                      </p>
                      {tool.requires && (
                        <p className="mt-1 text-muted-foreground text-[11px]">
                          Requires {tool.requires}
                        </p>
                      )}
                    </div>
                    <Badge variant={tool.configured ? "secondary" : "outline"}>
                      {tool.configured ? "Ready" : "Missing key"}
                    </Badge>
                  </div>
                ))}
                {!settings && !loadError && (
                  <p className="text-muted-foreground text-sm">Loading…</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── About ───────────────────────────────────────────── */}
          <TabsContent value="about">
            <Card>
              <CardHeader>
                <CardTitle>{settings?.about.name ?? "Yggdrasil"}</CardTitle>
                <CardDescription>
                  Self-hosted personal AI assistant.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                <ConfigRow
                  label="Version"
                  value={settings?.about.version ?? "—"}
                />
                <ConfigRow
                  label="Stack"
                  value={settings?.about.stack ?? "—"}
                />
                <p className="pt-2 text-muted-foreground text-xs">
                  Your data stays on your machine: chats in the browser and
                  local SQLite, model calls to your own server.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate font-medium text-right" title={value}>
        {value}
      </span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
