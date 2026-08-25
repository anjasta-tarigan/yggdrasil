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
  getEmbeddingSettings,
  getProviderSettings,
  saveEmbeddingSettings,
  saveProviderSettings,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { ArrowClockwise, Check, Database } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

type SettingsSnapshot = {
  ai: { baseUrl: string | null; modelId: string; apiKeyConfigured: boolean };
  embedding: {
    baseUrl: string | null;
    model: string;
    apiKeyConfigured: boolean;
    fallback: string;
  };
  database: {
    engine: string;
    driver: string;
    features: string[];
    chatCount: number;
  };
  tools: Array<{
    name: string;
    description: string;
    configured: boolean;
    requires: string | null;
  }>;
  about: { name: string; version: string; stack: string };
};

type OllamaModel = {
  name: string;
  parameterSize: string | null;
  size: number | null;
};

type OllamaDetection = {
  baseUrl: string | null;
  detected: boolean;
  models: OllamaModel[];
};

/**
 * Settings rendered inside the app shell's content area (the sidebar,
 * header and status footer stay in place). Selecting any chat in the
 * sidebar returns to the conversation.
 */
export function SettingsView() {
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState(false);

  // AI Provider override form (persisted to localStorage, sent with chat
  // requests, honored by /api/chat ahead of the server environment).
  // Lazy initializers read localStorage at mount — SettingsView only
  // mounts after hydration (behind the AppShell gate + a user click),
  // so this never runs during SSR.
  const [baseUrl, setBaseUrl] = useState(
    () => getProviderSettings().baseUrl ?? ""
  );
  const [apiKey, setApiKey] = useState(
    () => getProviderSettings().apiKey ?? ""
  );
  const [providerSaved, setProviderSaved] = useState(false);

  // Provider kind: server default (OpenAI-compatible) or Ollama.
  const [providerKind, setProviderKind] = useState<"default" | "ollama">(
    () => (getProviderSettings().kind === "ollama" ? "ollama" : "default")
  );

  // Ollama: endpoint + models are auto-detected server-side; no API key.
  const [ollamaDetection, setOllamaDetection] =
    useState<OllamaDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectTick, setDetectTick] = useState(0);
  const [ollamaModel, setOllamaModel] = useState(
    () => getProviderSettings().ollamaModel ?? ""
  );
  const [ollamaSaved, setOllamaSaved] = useState(false);

  useEffect(() => {
    if (providerKind !== "ollama") return;
    let cancelled = false;
    setDetecting(true);
    fetch("/api/ollama")
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<OllamaDetection>;
      })
      .then((data) => {
        if (cancelled) return;
        setOllamaDetection(data);
        // Preselect the saved model, else the first detected one.
        setOllamaModel(
          (current) =>
            current || data.models[0]?.name || ""
        );
      })
      .catch(() => {
        if (!cancelled) {
          setOllamaDetection({ baseUrl: null, detected: false, models: [] });
        }
      })
      .finally(() => {
        if (!cancelled) setDetecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providerKind, detectTick]);

  // Embedding model override (stored for future embedding pipelines).
  const [embeddingModel, setEmbeddingModel] = useState(
    () => getEmbeddingSettings().model ?? ""
  );
  const [embeddingSaved, setEmbeddingSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<SettingsSnapshot>;
      })
      .then((data) => {
        if (!cancelled) setSettings(data);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveProvider = () => {
    saveProviderSettings({ baseUrl, apiKey, kind: "openai-compatible" });
    setActiveKind("default");
    setProviderSaved(true);
    window.setTimeout(() => setProviderSaved(false), 2000);
  };

  const clearProvider = () => {
    setBaseUrl("");
    setApiKey("");
    saveProviderSettings({ kind: "openai-compatible" });
    setActiveKind("default");
  };

  const useOllama = () => {
    if (!ollamaDetection?.detected || !ollamaDetection.baseUrl) return;
    saveProviderSettings({
      // OpenAI-compatible fields are kept so switching back preserves them.
      apiKey,
      baseUrl,
      kind: "ollama",
      ollamaBaseUrl: ollamaDetection.baseUrl,
      ollamaModel,
    });
    setActiveKind("ollama");
    setOllamaSaved(true);
    window.setTimeout(() => setOllamaSaved(false), 2000);
  };

  const useServerDefault = () => {
    saveProviderSettings({ apiKey, baseUrl, kind: "openai-compatible" });
    setActiveKind("default");
    setProviderKind("default");
  };

  const saveEmbedding = () => {
    saveEmbeddingSettings({ model: embeddingModel });
    setEmbeddingSaved(true);
    window.setTimeout(() => setEmbeddingSaved(false), 2000);
  };

  // What is currently persisted — drives the "active" badge. Kept in
  // state (localStorage must not be read during render).
  const [activeKind, setActiveKind] = useState<"default" | "ollama">(() =>
    getProviderSettings().kind === "ollama" ? "ollama" : "default"
  );

  const providerOverridden =
    activeKind === "ollama" || Boolean(baseUrl.trim() || apiKey.trim());

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
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
                <CardTitle>Server configuration</CardTitle>
                <CardDescription>
                  Effective values from the server environment (.env.local).
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
                <CardTitle>Provider</CardTitle>
                <CardDescription>
                  Choose where chat requests run. Settings are stored in
                  this browser and sent with each request.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <ProviderOption
                    active={providerKind === "default"}
                    description="The server's own endpoint (.env.local), or any OpenAI-compatible URL you point it at."
                    onClick={() => setProviderKind("default")}
                    title="Server default"
                  />
                  <ProviderOption
                    active={providerKind === "ollama"}
                    description="Local models via Ollama — endpoint and models are auto-detected, no API key."
                    onClick={() => setProviderKind("ollama")}
                    title="Ollama"
                  />
                </div>

                {providerOverridden && (
                  <Badge variant="secondary">
                    {activeKind === "ollama"
                      ? "Ollama active"
                      : "OpenAI-compatible override active"}
                  </Badge>
                )}
              </CardContent>
            </Card>

            {providerKind === "default" ? (
              <Card>
                <CardHeader>
                  <CardTitle>OpenAI-compatible override</CardTitle>
                  <CardDescription>
                    Optional: point the default provider at another
                    OpenAI-compatible endpoint; leave blank to use the server
                    defaults.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor="base-url">
                      Base URL
                    </label>
                    <Input
                      id="base-url"
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="http://localhost:20128/v1"
                      value={baseUrl}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor="api-key">
                      API key
                    </label>
                    <Input
                      id="api-key"
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="Bearer token (optional)"
                      type="password"
                      value={apiKey}
                    />
                    <p className="text-muted-foreground text-xs">
                      Kept in this browser only — never uploaded anywhere
                      except your own chat server.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button onClick={saveProvider} type="button">
                      {providerSaved ? <Check className="size-4" /> : null}
                      {providerSaved ? "Saved" : "Save override"}
                    </Button>
                    {(baseUrl.trim() || apiKey.trim()) && (
                      <Button
                        onClick={clearProvider}
                        type="button"
                        variant="outline"
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>Ollama</CardTitle>
                  <CardDescription>
                    No API key needed. The endpoint is auto-detected on this
                    machine and the model list is read from Ollama itself.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0 text-sm">
                      <p className="font-medium">Endpoint</p>
                      <p className="truncate text-muted-foreground text-xs">
                        {detecting
                          ? "Detecting…"
                          : (ollamaDetection?.baseUrl ?? "Not found")}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge
                        variant={
                          ollamaDetection?.detected ? "secondary" : "outline"
                        }
                      >
                        {detecting
                          ? "…"
                          : ollamaDetection?.detected
                            ? "Detected"
                            : "Not found"}
                      </Badge>
                      <Button
                        aria-label="Re-detect Ollama"
                        disabled={detecting}
                        onClick={() => setDetectTick((t) => t + 1)}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <ArrowClockwise className="size-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Model</label>
                    {ollamaDetection?.detected &&
                    ollamaDetection.models.length > 0 ? (
                      <Select
                        onValueChange={setOllamaModel}
                        value={ollamaModel || undefined}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Pick a model" />
                        </SelectTrigger>
                        <SelectContent>
                          {ollamaDetection.models.map((m) => (
                            <SelectItem key={m.name} value={m.name}>
                              {m.name}
                              {m.parameterSize ? ` · ${m.parameterSize}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        {detecting
                          ? "Looking for installed models…"
                          : "No models found — is Ollama running? Start it with `ollama serve` and pull a model."}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      disabled={
                        !ollamaDetection?.detected || !ollamaModel
                      }
                      onClick={useOllama}
                      type="button"
                    >
                      {ollamaSaved ? <Check className="size-4" /> : null}
                      {ollamaSaved ? "Saved" : "Use Ollama"}
                    </Button>
                    {activeKind === "ollama" && (
                      <Button
                        onClick={useServerDefault}
                        type="button"
                        variant="outline"
                      >
                        Use server default
                      </Button>
                    )}
                  </div>

                  {activeKind === "ollama" && (
                    <p className="text-muted-foreground text-xs">
                      While Ollama is active, the model picked here is used
                      for chat; the model selector in the chat header applies
                      to the default provider only.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── Embedding Provider ──────────────────────────────── */}
          <TabsContent className="space-y-4" value="embedding">
            <Card>
              <CardHeader>
                <CardTitle>Server configuration</CardTitle>
                <CardDescription>
                  Embeddings power memory search. They use the same endpoint
                  as the AI provider, with a local deterministic fallback
                  when it is unreachable.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                <ConfigRow
                  label="Endpoint"
                  value={
                    settings?.embedding.baseUrl
                      ? `${settings.embedding.baseUrl.replace(/\/$/, "")}/embeddings`
                      : "—"
                  }
                />
                <ConfigRow
                  label="Model"
                  value={settings?.embedding.model ?? "—"}
                />
                <ConfigRow
                  label="Fallback"
                  value={settings?.embedding.fallback ?? "—"}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Override</CardTitle>
                <CardDescription>
                  Choose the embedding model used when the endpoint supports
                  it. Stored for the memory pipeline on this device.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <label
                    className="text-sm font-medium"
                    htmlFor="embedding-model"
                  >
                    Embedding model
                  </label>
                  <Input
                    id="embedding-model"
                    onChange={(e) => setEmbeddingModel(e.target.value)}
                    placeholder="text-embedding-3-small"
                    value={embeddingModel}
                  />
                </div>
                <Button onClick={saveEmbedding} type="button">
                  {embeddingSaved ? <Check className="size-4" /> : null}
                  {embeddingSaved ? "Saved" : "Save"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Database (placeholder) ──────────────────────────── */}
          <TabsContent value="database">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="size-4" />
                  Database
                </CardTitle>
                <CardDescription>
                  Conversations and memories persist in a local SQLite
                  database. Connection settings will appear here in a future
                  release.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                <ConfigRow
                  label="Engine"
                  value={settings?.database.engine ?? "—"}
                />
                <ConfigRow
                  label="Driver"
                  value={settings?.database.driver ?? "—"}
                />
                <ConfigRow
                  label="Features"
                  value={settings?.database.features.join(", ") ?? "—"}
                />
                <ConfigRow
                  label="Stored chats"
                  value={settings ? String(settings.database.chatCount) : "—"}
                />
                <p className="pt-2 text-muted-foreground text-xs">
                  Placeholder — storage location and backup options are coming
                  soon.
                </p>
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
      <span className="truncate font-medium text-right">{value}</span>
    </div>
  );
}

/** Selectable provider card in the AI Provider tab. */
function ProviderOption({
  active,
  description,
  onClick,
  title,
}: {
  active: boolean;
  description: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "rounded-lg border p-3 text-left transition-colors",
        active
          ? "border-primary bg-primary/5"
          : "hover:border-foreground/30"
      )}
      onClick={onClick}
      type="button"
    >
      <span className="flex items-center gap-2 font-medium text-sm">
        {title}
        {active && <Check className="size-3.5 text-primary" />}
      </span>
      <span className="mt-1 block text-muted-foreground text-xs">
        {description}
      </span>
    </button>
  );
}
