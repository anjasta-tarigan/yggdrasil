"use client";

import {
  ArrowClockwise,
  Brain,
  Check,
  Database,
  FileText,
  Headphones,
  Image as ImageIcon,
  PencilSimple,
  Plus,
  Trash,
  Video,
  Wrench,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTokenCount } from "@/components/settings/model-form";
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
import { ThemeToggle } from "@/components/theme-toggle";
import {
  COGNITIVE_JOB_LABELS,
  formatBytes,
  formatCount,
  formatIsoLocal,
} from "@/components/settings/shared";
import type { ProviderConfig } from "@/lib/settings";
import type { ModelEntry } from "@/lib/ai/provider-config/schema";

// ── Small presentational helpers ──

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

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 shrink-0 rounded-full ${ok ? "bg-success" : "bg-destructive"}`}
    />
  );
}

function formatCtxOrOut(val: number | null | undefined): string | null {
  return formatTokenCount(val);
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
  editProvider?: (provider: ProviderConfig) => void;
  addModel?: (providerId: string) => void;
  editModel?: (providerId: string, model: ModelEntry) => void;
  deleteModel?: (providerId: string, modelId: string) => void;
};

export function ProviderTab({
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
  editProvider,
  addModel,
  editModel,
  deleteModel,
}: ProviderTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Providers</CardTitle>
        <CardDescription>
          Every provider you add becomes active immediately — all of their
          models appear grouped in the chat model selector.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {providers.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No extra providers yet. Add Ollama or any OpenAI-compatible
            endpoint below.
          </p>
        ) : (
          providers.map((provider) => {
            const models = provider.models ?? [];
            return (
              <div
                className="flex flex-col gap-3 rounded-lg border p-4"
                key={provider.id}
              >
                {/* Provider Header */}
                <div className="flex items-center justify-between gap-3">
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
                  <div className="flex items-center gap-1">
                    {editProvider && (
                      <Button
                        aria-label={`Edit ${provider.name}`}
                        onClick={() => editProvider(provider)}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <PencilSimple className="size-4" />
                      </Button>
                    )}
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
                </div>

                {/* Models Section */}
                <div className="flex flex-col gap-2 border-t pt-3">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-xs text-muted-foreground">
                      Models ({models.length})
                    </p>
                    <Button
                      aria-label={`Add model to ${provider.name}`}
                      onClick={() => addModel?.(provider.id)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Plus className="size-3.5" />
                      Add model
                    </Button>
                  </div>

                  {models.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      No models added yet.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {models.map((m) => {
                        const ctxStr = formatCtxOrOut(m.capabilities?.contextWindow);
                        const outStr = formatCtxOrOut(m.capabilities?.maxOutputTokens);
                        const sources = m.capabilitySources ?? {};
                        const firstSource = Object.values(sources)[0];

                        return (
                          <div
                            className="flex items-center justify-between gap-2 rounded-md bg-muted/40 p-2.5 text-xs"
                            key={m.modelId}
                          >
                            <div className="flex min-w-0 flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-foreground truncate">
                                  {m.displayName}
                                </span>
                                {m.modelId !== m.displayName && (
                                  <span className="truncate text-muted-foreground text-[11px]">
                                    ({m.modelId})
                                  </span>
                                )}
                                {m.isDefault && (
                                  <Badge variant="secondary">Default</Badge>
                                )}
                              </div>

                              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                {ctxStr && (
                                  <Badge variant="outline">{ctxStr} ctx</Badge>
                                )}
                                {outStr && (
                                  <Badge variant="outline">{outStr} out</Badge>
                                )}
                                {m.capabilities?.supportsToolCalls && (
                                  <Badge className="gap-1" variant="outline">
                                    <Wrench className="size-3" /> Tools
                                  </Badge>
                                )}
                                {m.capabilities?.supportsReasoning && (
                                  <Badge className="gap-1" variant="outline">
                                    <Brain className="size-3" /> Reasoning
                                  </Badge>
                                )}
                                {m.capabilities?.inputModalities?.includes("image") && (
                                  <Badge className="gap-1" variant="outline">
                                    <ImageIcon className="size-3" /> Image
                                  </Badge>
                                )}
                                {m.capabilities?.inputModalities?.includes("audio") && (
                                  <Badge className="gap-1" variant="outline">
                                    <Headphones className="size-3" /> Audio
                                  </Badge>
                                )}
                                {m.capabilities?.inputModalities?.includes("video") && (
                                  <Badge className="gap-1" variant="outline">
                                    <Video className="size-3" /> Video
                                  </Badge>
                                )}
                                {m.capabilities?.inputModalities?.includes("pdf") && (
                                  <Badge className="gap-1" variant="outline">
                                    <FileText className="size-3" /> PDF
                                  </Badge>
                                )}
                                {firstSource && (
                                  <Badge className="text-[10px] opacity-70" variant="ghost">
                                    {firstSource}
                                  </Badge>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              {editModel && (
                                <Button
                                  aria-label={`Edit model ${m.displayName}`}
                                  onClick={() => editModel(provider.id, m)}
                                  size="icon-sm"
                                  type="button"
                                  variant="ghost"
                                >
                                  <PencilSimple className="size-3.5" />
                                </Button>
                              )}
                              {deleteModel && (
                                <Button
                                  aria-label={`Delete model ${m.displayName}`}
                                  onClick={() => deleteModel(provider.id, m.modelId)}
                                  size="icon-sm"
                                  type="button"
                                  variant="ghost"
                                >
                                  <Trash className="size-3.5" />
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })
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
  );
}

export type EmbeddingTabProps = {
  /** Registry providers selectable as the embedding endpoint. */
  providers: Array<{ id: string; name: string; kind: string }>;
  /** Selected registry provider id; null = custom standalone endpoint. */
  embProviderId: string | null;
  setEmbProviderId: (id: string | null) => void;
  embBaseUrl: string;
  setEmbBaseUrl: (url: string) => void;
  /** Write-only: non-empty stores a new key, empty leaves it unchanged. */
  embApiKey: string;
  setEmbApiKey: (key: string) => void;
  embApiKeyConfigured: boolean;
  clearEmbApiKey: () => void;
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
  providers,
  embProviderId,
  setEmbProviderId,
  embBaseUrl,
  setEmbBaseUrl,
  embApiKey,
  setEmbApiKey,
  embApiKeyConfigured,
  clearEmbApiKey,
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
            Embeddings power memory search. Compute them on one of your
            configured providers, or a standalone OpenAI-compatible / Ollama
            endpoint. A deterministic local fallback keeps memory working when
            nothing is reachable.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel>Embedding provider</FieldLabel>
            <Select
              onValueChange={(value) => {
                setEmbProviderId(value === "__custom__" ? null : value);
                setDetectResult(null);
              }}
              value={embProviderId ?? "__custom__"}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
                <SelectItem value="__custom__">
                  Custom endpoint (standalone)
                </SelectItem>
              </SelectContent>
            </Select>
            {providers.length === 0 ? (
              <FieldDescription>
                No providers configured — add one in the Providers tab or set
                a custom endpoint below.
              </FieldDescription>
            ) : null}
          </Field>

          {embProviderId === null ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="emb-base-url">Base URL</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="emb-base-url"
                    onChange={(e) => setEmbBaseUrl(e.target.value)}
                    placeholder="http://localhost:11434 or https://api.openai.com/v1"
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
                <FieldLabel htmlFor="emb-oa-api-key">
                  API key (write-only)
                </FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="emb-oa-api-key"
                    onChange={(e) => setEmbApiKey(e.target.value)}
                    placeholder={
                      embApiKeyConfigured
                        ? "•••••• configured — type to replace"
                        : "sk-…"
                    }
                    type="password"
                    value={embApiKey}
                  />
                  {embApiKeyConfigured ? (
                    <Button
                      onClick={clearEmbApiKey}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
                <FieldDescription>
                  Stored server-side; never sent back to the browser. Leave
                  empty to keep the current key.
                </FieldDescription>
              </Field>
              {ollamaModels.length > 0 ? (
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
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor="emb-oa-model">Model</FieldLabel>
                  <Input
                    id="emb-oa-model"
                    onChange={(e) => setEmbModel(e.target.value)}
                    placeholder="text-embedding-3-small"
                    value={embModel}
                  />
                </Field>
              )}
            </FieldGroup>
          ) : (
            <Field>
              <FieldLabel htmlFor="emb-model">Model</FieldLabel>
              <Input
                id="emb-model"
                onChange={(e) => setEmbModel(e.target.value)}
                placeholder="text-embedding-3-small"
                value={embModel}
              />
              <FieldDescription>
                The endpoint and credentials come from the selected provider.
              </FieldDescription>
            </Field>
          )}
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
                  ? "text-xs text-success"
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
  const db = database;
  const dbMemories = db?.memories;
  const dbQueue = db?.queue;
  const dbCognitive = db?.cognitive;

  const tiles = db
    ? [
        { label: "Chats", value: formatCount(db.chatCount ?? 0) },
        { label: "Messages", value: formatCount(db.messageCount ?? 0) },
        {
          label: "Memories",
          value: formatCount(
            (dbMemories?.episodic ?? 0) +
              (dbMemories?.semantic ?? 0) +
              (dbMemories?.working ?? 0)
          ),
        },
        {
          label: "Queue pending",
          value: formatCount(dbQueue?.pending ?? 0),
        },
      ]
    : null;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="size-4" />
            Storage
          </CardTitle>
          <CardDescription>
            Conversations, settings and memories persist in a local SQLite
            database on this server.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {tiles && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {tiles.map((tile) => (
                <div className="rounded-lg border px-3 py-2.5" key={tile.label}>
                  <p className="text-muted-foreground text-xs">{tile.label}</p>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
                    {tile.value}
                  </p>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-1.5 text-sm">
            <ConfigRow label="Engine" value={db?.engine ?? "—"} />
            <ConfigRow label="Driver" value={db?.driver ?? "—"} />
            <ConfigRow label="Features" value={db?.features?.join(", ") ?? "—"} />
            <ConfigRow label="File" value={db?.path || "—"} />
            <ConfigRow
              label="Size"
              value={db ? formatBytes(db.sizeBytes ?? 0) : "—"}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cognitive loop</CardTitle>
          <CardDescription>
            Background services that consolidate memories and keep embeddings
            fresh. Read live from the database.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 text-muted-foreground">
              <StatusDot ok={dbCognitive?.queueRunnerRunning ?? false} />
              Queue runner
            </span>
            <span className="font-medium">
              {dbCognitive
                ? dbCognitive.queueRunnerRunning
                  ? "running"
                  : "stopped"
                : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 text-muted-foreground">
              <StatusDot ok={dbCognitive?.daemonRunning ?? false} />
              Cron daemon
            </span>
            <span className="font-medium">
              {dbCognitive
                ? dbCognitive.daemonRunning
                  ? "running"
                  : "stopped"
                : "—"}
            </span>
          </div>
          <div className="my-2 border-t" />
          <ConfigRow
            label="Memory relations"
            value={dbCognitive ? formatCount(dbCognitive.relations ?? 0) : "—"}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Maintenance</CardTitle>
          <CardDescription>
            Manual triggers for the autonomous maintenance jobs. Queued passes
            run as soon as the job queue is free.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
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
            <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-muted-foreground text-xs">
              {maintenanceNote}
            </p>
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
        <CardTitle className="flex items-center gap-2">
          {about?.name ?? "Yggdrasil"}
          {about?.version && (
            <Badge variant="secondary">v{about.version}</Badge>
          )}
        </CardTitle>
        <CardDescription>Self-hosted personal AI assistant.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 text-sm">
        <ConfigRow label="Stack" value={about?.stack ?? "—"} />
        <p className="pt-2 text-muted-foreground text-xs">
          Your data stays on your machine: chats in the browser and local
          SQLite, model calls to your own server.
        </p>
      </CardContent>
    </Card>
  );
}

export { RerankerTab, type RerankerTabProps, type RerankerInfo } from "@/components/settings/reranker-tab";

