"use client";

import {
  ArrowClockwise,
  Check,
  Database,
  Plus,
  Trash,
} from "@phosphor-icons/react";
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
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ThemeToggle } from "@/components/theme-toggle";
import type {
  EmbeddingProviderKind,
  ProviderConfig,
  WebSearchProviderKind,
} from "@/lib/settings";

// ── Constants & helpers (moved from settings-view.tsx) ──

/** Display metadata for the web search providers in priority order. */
const WEB_SEARCH_PROVIDER_META: Array<{
  kind: WebSearchProviderKind;
  label: string;
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

const WEB_SEARCH_LABELS: Record<WebSearchProviderKind, string> = {
  exa: "Exa",
  firecrawl: "Firecrawl",
  searxng: "SearXNG",
};

/** Human labels for cognitive job types in the last-run list. */
const COGNITIVE_JOB_LABELS: Record<string, string> = {
  ingest_turn: "Turn ingestion",
  reflect_turn: "Reflection",
  sleep_consolidation: "Light sleep",
  dream_graph_discovery: "Dream cycle",
  decay_sweep: "Deep sleep sweep",
  scheduled_reminder: "Reminders",
};

function formatIsoLocal(iso: string | null | undefined): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "never";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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

// ── Tab components ──

export function GeneralTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Theme preference applies immediately and is remembered on this device.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ThemeToggle />
      </CardContent>
    </Card>
  );
}

export type ProviderTabProps = {
  aiConfig: { baseUrl: string | null; modelId: string; apiKeyConfigured: boolean } | null;
  providers: ProviderConfig[];
  addOllama: () => void;
  ollamaBusy: boolean;
  ollamaError: string | null;
  openaiFormOpen: boolean;
  setOpenaiFormOpen: (open: boolean) => void;
  oaName: string;
  setOaName: (name: string) => void;
  oaBaseUrl: string;
  setOaBaseUrl: (url: string) => void;
  oaApiKey: string;
  setOaApiKey: (key: string) => void;
  oaBusy: boolean;
  oaError: string | null;
  setOaError: (error: string | null) => void;
  addOpenaiProvider: () => void;
  deleteProvider: (id: string) => void;
};

export function ProviderTab({
  aiConfig,
  providers,
  addOllama,
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
  addOpenaiProvider,
  deleteProvider,
}: ProviderTabProps) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>This server</CardTitle>
          <CardDescription>
            The built-in provider from the server environment (.env.local).
            Always available.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5 text-sm">
          <ConfigRow label="Base URL" value={aiConfig?.baseUrl ?? "—"} />
          <ConfigRow label="Default model" value={aiConfig?.modelId ?? "—"} />
          <ConfigRow
            label="API key"
            value={
              aiConfig
                ? aiConfig.apiKeyConfigured
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
            Every provider you add becomes active immediately — all of their
            models appear grouped in the chat model selector.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {providers.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No extra providers yet. Add Ollama or any OpenAI-compatible
              endpoint below.
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
                setOpenaiFormOpen(!openaiFormOpen);
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
            <div className="flex flex-col gap-4 rounded-lg border p-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="oa-name">Name</FieldLabel>
                  <Input
                    id="oa-name"
                    onChange={(e) => setOaName(e.target.value)}
                    placeholder="My provider"
                    value={oaName}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="oa-base-url">Base URL</FieldLabel>
                  <Input
                    id="oa-base-url"
                    onChange={(e) => setOaBaseUrl(e.target.value)}
                    placeholder="https://api.example.com/v1"
                    value={oaBaseUrl}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="oa-api-key">API key</FieldLabel>
                  <Input
                    id="oa-api-key"
                    onChange={(e) => setOaApiKey(e.target.value)}
                    placeholder="Optional bearer token"
                    type="password"
                    value={oaApiKey}
                  />
                  <FieldDescription>
                    Kept in this browser only. The connection is tested before
                    saving.
                  </FieldDescription>
                </Field>
                {oaError && (
                  <p className="text-destructive text-xs">{oaError}</p>
                )}
              </FieldGroup>
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
    </>
  );
}

export type EmbeddingTabProps = {
  aiConfig: { baseUrl: string | null; apiKeyConfigured: boolean } | null;
  embProvider: EmbeddingProviderKind;
  setEmbProvider: (provider: EmbeddingProviderKind) => void;
  embBaseUrl: string;
  setEmbBaseUrl: (url: string) => void;
  embApiKey: string;
  setEmbApiKey: (key: string) => void;
  embModel: string;
  setEmbModel: (model: string) => void;
  embDimensions: number | null;
  setEmbDimensions: (dimensions: number | null) => void;
  embeddingSaved: boolean;
  embSaveError: string | null;
  saveEmbedding: () => Promise<void>;
  detectBusy: boolean;
  detectDimensions: () => Promise<void>;
  detectResult: { ok: boolean; text: string } | null;
  setDetectResult: (result: { ok: boolean; text: string } | null) => void;
  ollamaDetectBusy: boolean;
  detectOllamaUrl: () => void;
  ollamaModels: string[];
};

export function EmbeddingTab({
  aiConfig,
  embProvider,
  setEmbProvider,
  embBaseUrl,
  setEmbBaseUrl,
  embApiKey,
  setEmbApiKey,
  embModel,
  setEmbModel,
  embDimensions,
  setEmbDimensions,
  embeddingSaved,
  embSaveError,
  saveEmbedding,
  detectBusy,
  detectDimensions,
  detectResult,
  setDetectResult,
  ollamaDetectBusy,
  detectOllamaUrl,
  ollamaModels,
}: EmbeddingTabProps) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Provider</CardTitle>
          <CardDescription>
            Embeddings power memory search. Choose where they are computed: the
            built-in server endpoint, a local Ollama, or any OpenAI-compatible
            cloud endpoint. A deterministic local fallback keeps memory working
            when nothing is reachable.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel>Embedding provider</FieldLabel>
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
          </Field>

          {embProvider === "server" ? (
            <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
              <ConfigRow label="Endpoint" value={aiConfig?.baseUrl ?? "—"} />
              <ConfigRow
                label="API key"
                value={
                  aiConfig?.apiKeyConfigured
                    ? "Configured"
                    : "Not configured"
                }
              />
            </div>
          ) : null}

          {embProvider === "ollama" ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="emb-base-url">Base URL</FieldLabel>
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
              </Field>
              <Field>
                <FieldLabel>Model</FieldLabel>
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
                  <FieldDescription>
                    No models found at this URL — pull an embedding model first
                    (e.g. `ollama pull nomic-embed-text`).
                  </FieldDescription>
                ) : null}
              </Field>
            </FieldGroup>
          ) : null}

          {embProvider === "openai-compatible" ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="emb-oa-base-url">Base URL</FieldLabel>
                <Input
                  id="emb-oa-base-url"
                  onChange={(e) => setEmbBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  value={embBaseUrl}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="emb-oa-api-key">API key</FieldLabel>
                <Input
                  id="emb-oa-api-key"
                  onChange={(e) => setEmbApiKey(e.target.value)}
                  placeholder="sk-…"
                  type="password"
                  value={embApiKey}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="emb-oa-model">Model</FieldLabel>
                <Input
                  id="emb-oa-model"
                  onChange={(e) => setEmbModel(e.target.value)}
                  placeholder="text-embedding-3-small"
                  value={embModel}
                />
              </Field>
            </FieldGroup>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dimensions & chunking</CardTitle>
          <CardDescription>
            The vector dimension is auto-detected by probing the model. Long
            memories are split into overlapping chunks and mean-pooled into one
            vector per memory.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Vector dimensions</FieldLabel>
              <FieldDescription>
                Native output size of the selected model
              </FieldDescription>
            </FieldContent>
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
          </Field>
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

          <Field className="border-t pt-4" orientation="horizontal">
            <FieldContent>
              <FieldLabel>Text chunking</FieldLabel>
              <FieldDescription>
                Preset to recommended 2,000 chars (≈512 tokens) with 200 char
                overlap (10%)
              </FieldDescription>
            </FieldContent>
            <Badge variant="secondary">2,000 / 200</Badge>
          </Field>

          <div className="flex items-center gap-3">
            <Button onClick={saveEmbedding} type="button">
              {embeddingSaved ? <Check className="size-4" /> : null}
              {embeddingSaved ? "Saved" : "Save embedding settings"}
            </Button>
            {embSaveError ? (
              <p className="text-destructive text-xs">{embSaveError}</p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

export type DatabaseTabProps = {
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
    cognitive?: {
      daemonRunning: boolean;
      queueRunnerRunning: boolean;
      relations: number;
      unembedded: { episodic: number; semantic: number };
      lastRuns: Array<{ type: string; at: string | null }>;
      lastFailure: { type: string; error: string | null; at: string | null } | null;
    };
  } | null;
  maintenanceBusy: string | null;
  maintenanceNote: string | null;
  runMaintenancePass: (
    pass: "light_sleep" | "dream_cycle" | "decay_sweep"
  ) => Promise<void>;
  runEmbeddingBackfillNow: () => Promise<void>;
};

export function DatabaseTab({
  database,
  maintenanceBusy,
  maintenanceNote,
  runMaintenancePass,
  runEmbeddingBackfillNow,
}: DatabaseTabProps) {
  // Local alias: the JSX below reads `db.*` stats heavily.
  const db = database;
  const dbMemories = db?.memories;
  const dbQueue = db?.queue;
  const dbCognitive = db?.cognitive;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="size-4" />
          Database
        </CardTitle>
        <CardDescription>
          Conversations, settings and memories persist in a local SQLite
          database on this server. These statistics are read live from the
          database file.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 text-sm">
        <ConfigRow label="Engine" value={db?.engine ?? "—"} />
        <ConfigRow label="Driver" value={db?.driver ?? "—"} />
        <ConfigRow label="Features" value={db?.features?.join(", ") ?? "—"} />
        <ConfigRow label="File" value={db?.path || "—"} />
        <ConfigRow
          label="Size"
          value={db ? formatBytes(db.sizeBytes ?? 0) : "—"}
        />
        <div className="my-2 border-t" />
        <ConfigRow label="Chats" value={db ? String(db.chatCount ?? 0) : "—"} />
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
        <div className="my-2 border-t" />
        <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Cognitive loop
        </p>
        <ConfigRow
          label="Background services"
          value={
            dbCognitive
              ? `queue runner ${dbCognitive.queueRunnerRunning ? "running" : "stopped"} · cron daemon ${dbCognitive.daemonRunning ? "running" : "stopped"}`
              : "—"
          }
        />
        <ConfigRow
          label="Memory relations"
          value={dbCognitive ? String(dbCognitive.relations ?? 0) : "—"}
        />
        <ConfigRow
          label="Embedding backlog"
          value={
            dbCognitive?.unembedded
              ? `${dbCognitive.unembedded.episodic ?? 0} episodic · ${dbCognitive.unembedded.semantic ?? 0} semantic`
              : "—"
          }
        />
        {Array.isArray(dbCognitive?.lastRuns) &&
          dbCognitive.lastRuns.map((run) => (
            <ConfigRow
              key={run.type}
              label={`Last ${COGNITIVE_JOB_LABELS[run.type] ?? run.type}`}
              value={formatIsoLocal(run.at)}
            />
          ))}
        <ConfigRow
          label="Last failure"
          value={
            dbCognitive?.lastFailure
              ? `${dbCognitive.lastFailure.type}: ${dbCognitive.lastFailure.error ?? "unknown error"} (${formatIsoLocal(dbCognitive.lastFailure.at)})`
              : "none"
          }
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={maintenanceBusy !== null}
            onClick={() => void runMaintenancePass("light_sleep")}
            size="sm"
            type="button"
            variant="outline"
          >
            {maintenanceBusy === "light_sleep"
              ? "Queuing…"
              : "Run light sleep"}
          </Button>
          <Button
            disabled={maintenanceBusy !== null}
            onClick={() => void runMaintenancePass("dream_cycle")}
            size="sm"
            type="button"
            variant="outline"
          >
            {maintenanceBusy === "dream_cycle"
              ? "Queuing…"
              : "Run dream cycle"}
          </Button>
          <Button
            disabled={maintenanceBusy !== null}
            onClick={() => void runMaintenancePass("decay_sweep")}
            size="sm"
            type="button"
            variant="outline"
          >
            {maintenanceBusy === "decay_sweep"
              ? "Queuing…"
              : "Run decay sweep"}
          </Button>
          <Button
            disabled={maintenanceBusy !== null}
            onClick={() => void runEmbeddingBackfillNow()}
            size="sm"
            type="button"
            variant="outline"
          >
            {maintenanceBusy === "backfill"
              ? "Backfilling…"
              : "Backfill embeddings"}
          </Button>
        </div>
        {maintenanceNote && (
          <p className="mt-2 rounded-md border px-3 py-2 text-muted-foreground text-xs">
            {maintenanceNote}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export type ToolsTabProps = {
  tools: Array<{
    name: string;
    description: string;
    configured: boolean;
    requires: string | null;
  }> | null;
  webSearch: {
    providers: Array<{
      kind: WebSearchProviderKind;
      enabled: boolean;
      ready: boolean;
      coolingDown: boolean;
    }>;
    chain: WebSearchProviderKind[];
  } | null;
  wsForm: Record<
    WebSearchProviderKind,
    { enabled: boolean; apiKey: string; baseUrl: string }
  >;
  updateWsForm: (
    kind: WebSearchProviderKind,
    patch: Partial<{ enabled: boolean; apiKey: string; baseUrl: string }>
  ) => void;
  wsSaved: boolean;
  wsSaveError: string | null;
  saveWebSearch: () => Promise<void>;
};

export function ToolsTab({
  tools,
  webSearch,
  wsForm,
  updateWsForm,
  wsSaved,
  wsSaveError,
  saveWebSearch,
}: ToolsTabProps) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Web search providers</CardTitle>
          <CardDescription>
            The web_search tool tries enabled providers in priority order — Exa,
            then Firecrawl, then SearXNG — and automatically falls back when one
            fails or returns nothing. A provider that hits a quota or auth error
            is put on a 15-minute cooldown so an exhausted key is not hammered
            on every search.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {WEB_SEARCH_PROVIDER_META.map((meta) => {
            const status = webSearch?.providers.find(
              (p) => p.kind === meta.kind
            );
            const form = wsForm[meta.kind];
            const badge = status?.coolingDown
              ? { label: "Cooling down", variant: "outline" as const }
              : status?.ready
                ? { label: "Ready", variant: "secondary" as const }
                : {
                    label: meta.needsUrl ? "Needs URL" : "Missing key",
                    variant: "outline" as const,
                  };
            return (
              <div className="flex flex-col gap-3 rounded-lg border p-3" key={meta.kind}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Switch
                      checked={form.enabled}
                      id={`ws-${meta.kind}`}
                      onCheckedChange={(checked) =>
                        updateWsForm(meta.kind, { enabled: checked })
                      }
                    />
                    <FieldLabel className="cursor-pointer" htmlFor={`ws-${meta.kind}`}>
                      {meta.label}
                    </FieldLabel>
                  </div>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </div>
                {form.enabled && (
                  <Field>
                    {meta.needsUrl ? (
                      <>
                        <Input
                          id={`ws-${meta.kind}-url`}
                          onChange={(e) =>
                            updateWsForm(meta.kind, {
                              baseUrl: e.target.value,
                            })
                          }
                          placeholder="http://localhost:8080"
                          value={form.baseUrl}
                        />
                        <FieldDescription>
                          SearXNG instance URL — enable the JSON format on the
                          instance (search.formats: [html, json]).{" "}
                          {meta.envHint}.
                        </FieldDescription>
                      </>
                    ) : (
                      <>
                        <Input
                          id={`ws-${meta.kind}-key`}
                          onChange={(e) =>
                            updateWsForm(meta.kind, {
                              apiKey: e.target.value,
                            })
                          }
                          placeholder="API key override (optional)"
                          type="password"
                          value={form.apiKey}
                        />
                        <FieldDescription>{meta.envHint}.</FieldDescription>
                      </>
                    )}
                  </Field>
                )}
              </div>
            );
          })}

          {webSearch && (
            <p className="text-muted-foreground text-xs">
              Fallback order:{" "}
              {webSearch.chain.length > 0
                ? webSearch.chain
                    .map((kind) => WEB_SEARCH_LABELS[kind])
                    .join(" → ")
                : "no provider ready"}
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={saveWebSearch} type="button">
              {wsSaved ? <Check className="size-4" /> : null}
              {wsSaved ? "Saved" : "Save web search settings"}
            </Button>
            {wsSaveError ? (
              <p className="text-destructive text-xs">{wsSaveError}</p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Chat tools</CardTitle>
          <CardDescription>
            Server-side tools the assistant can call during a conversation.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(tools ?? []).map((tool) => (
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
          {!tools && (
            <p className="text-muted-foreground text-sm">Loading…</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export type AboutTabProps = {
  about: { name: string; version: string; stack: string } | null;
};

export function AboutTab({ about }: AboutTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{about?.name ?? "Yggdrasil"}</CardTitle>
        <CardDescription>Self-hosted personal AI assistant.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 text-sm">
        <ConfigRow label="Version" value={about?.version ?? "—"} />
        <ConfigRow label="Stack" value={about?.stack ?? "—"} />
        <p className="pt-2 text-muted-foreground text-xs">
          Your data stays on your machine: chats in the browser and local
          SQLite, model calls to your own server.
        </p>
      </CardContent>
    </Card>
  );
}