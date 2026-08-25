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
import { Check, Database } from "@phosphor-icons/react";
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
    saveProviderSettings({ baseUrl, apiKey });
    setProviderSaved(true);
    window.setTimeout(() => setProviderSaved(false), 2000);
  };

  const clearProvider = () => {
    setBaseUrl("");
    setApiKey("");
    saveProviderSettings({});
  };

  const saveEmbedding = () => {
    saveEmbeddingSettings({ model: embeddingModel });
    setEmbeddingSaved(true);
    window.setTimeout(() => setEmbeddingSaved(false), 2000);
  };

  const providerOverridden = Boolean(baseUrl.trim() || apiKey.trim());

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
                <CardTitle>Override</CardTitle>
                <CardDescription>
                  Point this assistant at any OpenAI-compatible endpoint.
                  Overrides are stored in this browser and sent with each
                  chat request; leave blank to use the server defaults.
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
                    Kept in this browser only — never uploaded anywhere except
                    your own chat server.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button onClick={saveProvider} type="button">
                    {providerSaved ? <Check className="size-4" /> : null}
                    {providerSaved ? "Saved" : "Save override"}
                  </Button>
                  {providerOverridden && (
                    <>
                      <Button
                        onClick={clearProvider}
                        type="button"
                        variant="outline"
                      >
                        Clear
                      </Button>
                      <Badge variant="secondary">Override active</Badge>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
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
