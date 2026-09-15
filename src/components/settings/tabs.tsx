"use client";

import { useState } from "react";
import {
  ArrowClockwise,
  Brain,
  Check,
  CheckCircle,
  Database,
  FileText,
  Headphones,
  Image as ImageIcon,
  MagnifyingGlass,
  MapPin,
  NavigationArrow,
  PencilSimple,
  Plus,
  Trash,
  Video,
  Warning,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDeviceLocation } from "@/hooks/use-device-location";
import { formatTokenCount } from "@/components/settings/model-form";
import { ModelBrowserDialog } from "@/components/settings/model-browser-dialog";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
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
  const loc = useDeviceLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);

  async function handleSetManual(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    const ok = await loc.setManualLocation(searchQuery);
    setSearching(false);
    if (ok) {
      setSearchQuery("");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Appearance Card ── */}
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

      {/* ── Device Location Card ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <MapPin className="size-4 text-primary" />
                Device Location
              </CardTitle>
              <CardDescription>
                Allow the assistant to use your physical location for weather, nearby places, navigation, and time-aware queries without missing.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                id="location-toggle"
                aria-label="Toggle device location sharing"
                checked={loc.enabled}
                onCheckedChange={loc.toggleLocation}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          {loc.enabled ? (
            <div className="rounded-lg border border-border/70 bg-muted/30 p-3.5 space-y-3.5 text-xs">
              {/* Mode Selector */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-3">
                <div className="flex items-center gap-1.5 p-0.5 rounded-md bg-muted border border-border/60">
                  <button
                    type="button"
                    onClick={() => loc.setMode("gps")}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                      loc.mode === "gps"
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <NavigationArrow className="size-3.5" />
                    Auto-detect (GPS)
                  </button>
                  <button
                    type="button"
                    onClick={() => loc.setMode("manual")}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                      loc.mode === "manual"
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <MapPin className="size-3.5" />
                    Custom / Manual
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <span className="font-medium text-muted-foreground">Source:</span>
                  {loc.source === "manual_override" ? (
                    <Badge variant="outline" className="text-primary border-primary/30 bg-primary/10">
                      Manual Exact Location
                    </Badge>
                  ) : loc.status === "requesting" ? (
                    <Badge variant="outline" className="text-warning border-warning/30 bg-warning/10">
                      Requesting GPS…
                    </Badge>
                  ) : loc.status === "granted" && loc.coordinates ? (
                    <Badge variant="outline" className="text-success border-success/30 bg-success/10">
                      Device GPS Sensor
                    </Badge>
                  ) : loc.status === "denied" ? (
                    <Badge variant="outline" className="text-destructive border-destructive/30 bg-destructive/10">
                      Permission Denied
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      Network IP Approximation
                    </Badge>
                  )}

                  {loc.mode === "gps" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void loc.refreshLocation(false)}
                      disabled={loc.status === "requesting"}
                      className="h-7 text-xs gap-1.5 ml-1"
                    >
                      <ArrowClockwise className={`size-3.5 ${loc.status === "requesting" ? "animate-spin" : ""}`} />
                      Refresh
                    </Button>
                  )}
                </div>
              </div>

              {/* Manual search input */}
              {loc.mode === "manual" && (
                <form onSubmit={handleSetManual} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                      <Input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="e.g. Banyuning, Bali or Singaraja, Bali"
                        className="pl-8 h-8 text-xs font-mono"
                        disabled={searching}
                      />
                    </div>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={searching || !searchQuery.trim()}
                      className="h-8 text-xs"
                    >
                      {searching ? "Searching…" : "Set Location"}
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Set your exact physical location when your desktop browser or ISP gateway routes through another city (like Java or Surakarta).
                  </p>
                </form>
              )}

              {loc.error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
                  {loc.error}
                </div>
              )}

              {loc.coordinates && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                  <div className="flex flex-col gap-0.5 rounded-md border border-border/50 bg-background/50 p-2">
                    <span className="text-[11px] text-muted-foreground font-medium">Coordinates</span>
                    <span className="font-mono text-xs text-foreground font-semibold">
                      {loc.coordinates.latitude.toFixed(4)}°, {loc.coordinates.longitude.toFixed(4)}°
                    </span>
                    {loc.coordinates.accuracyMeters && (
                      <span className="text-[10px] text-muted-foreground">
                        Accuracy: ±{Math.round(loc.coordinates.accuracyMeters)}m
                      </span>
                    )}
                  </div>

                  <div className="flex flex-col gap-0.5 rounded-md border border-border/50 bg-background/50 p-2">
                    <span className="text-[11px] text-muted-foreground font-medium">Address / Region</span>
                    <span className="text-xs text-foreground font-medium truncate" title={loc.address?.formatted || undefined}>
                      {loc.address?.city
                        ? [loc.address.city, loc.address.region, loc.address.country].filter(Boolean).join(", ")
                        : loc.address?.formatted || "Resolving address…"}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      Timezone: {loc.timezone}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Location sharing is disabled. When queries require geographical context, the assistant falls back to approximate IP network location or system timezone.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
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
  /** ONNX embedding model auto-discovered from data/models/embedding/. */
  onnxDiscoveredModels?: Array<{ filename: string; sizeBytes: number }>;
  onnxModelPath?: string | null;
  onnxLoaded?: boolean;
  setEmbOnnxModelPath?: (path: string) => void;
  onModelInstalled?: (repo?: string) => void;
  installedModelNotification?: { repo: string; kind: "embedding" | "reranker" } | null;
  onDismissInstallNotification?: () => void;
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
  onnxDiscoveredModels = [],
  onnxModelPath = null,
  onnxLoaded = false,
  setEmbOnnxModelPath,
  onModelInstalled = () => {},
  installedModelNotification,
  onDismissInstallNotification,
}: EmbeddingTabProps) {
  return (
    <>
      {installedModelNotification && installedModelNotification.kind === "embedding" && (
        <Alert className="border-success/40 bg-success/10 text-success-foreground">
          <CheckCircle className="size-4 text-success" />
          <AlertTitle className="font-semibold text-success flex items-center justify-between">
            <span>Model Download Complete</span>
            {onDismissInstallNotification && (
              <button
                type="button"
                onClick={onDismissInstallNotification}
                className="text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors"
                aria-label="Dismiss notification"
              >
                <X className="size-3.5" />
              </button>
            )}
          </AlertTitle>
          <AlertDescription className="text-xs text-muted-foreground mt-0.5">
            Model <strong className="font-mono text-foreground">{installedModelNotification.repo}</strong> has been downloaded, verified, and is ready for use.
          </AlertDescription>
        </Alert>
      )}

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
                if (value === "__custom__") {
                  setEmbProviderId(null);
                } else if (value === "__onnx__") {
                  // onnx is a special provider — stored as a standalone
                  // config block with provider: "onnx" in the registry.
                  setEmbProviderId("__onnx__");
                } else {
                  setEmbProviderId(value);
                }
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
                <SelectItem value="__onnx__">
                  ONNX (local model)
                </SelectItem>
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

          {embProviderId === "__onnx__" ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="emb-onnx-model">ONNX model file</FieldLabel>
                {onnxDiscoveredModels.length > 0 ? (
                  <Select
                    onValueChange={(value) => {
                      setEmbOnnxModelPath?.(value);
                      setEmbDimensions(null);
                      setDetectResult(null);
                    }}
                    value={onnxModelPath ?? ""}
                  >
                    <SelectTrigger className="w-full" id="emb-onnx-model">
                      <SelectValue placeholder="Select an ONNX model…" />
                    </SelectTrigger>
                    <SelectContent>
                      {onnxDiscoveredModels.map((m) => (
                        <SelectItem key={m.filename} value={m.filename}>
                          <span className="font-mono text-xs">{m.filename}</span>{" "}
                          <span className="text-muted-foreground text-xs font-normal">
                            ({formatBytes(m.sizeBytes)})
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id="emb-onnx-model"
                    onChange={(e) => setEmbOnnxModelPath?.(e.target.value)}
                    placeholder="model.onnx"
                    value={onnxModelPath ?? ""}
                  />
                )}
                <FieldDescription>
                  Auto-discovers ONNX models in{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    data/models/embedding/
                  </code>{" "}
                  (files &ge; 50 MB). The session loads on demand and releases
                  itself after 2 minutes idle — zero RAM when unused.
                </FieldDescription>
              </Field>
              {onnxDiscoveredModels.length === 0 ? (
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
                  <div className="flex items-start gap-2">
                    <Warning className="mt-0.5 size-4 shrink-0 text-warning" />
                    <div className="flex flex-col gap-1">
                      <span className="font-medium text-foreground">
                        No ONNX embedding models discovered
                      </span>
                      <span className="text-muted-foreground text-xs">
                        Export an embedder with{" "}
                        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                          optimum-cli export onnx
                        </code>{" "}
                        (e.g. BAAI/bge-small-en-v1.5, sentence-transformers/all-MiniLM-L6-v2)
                        into{" "}
                        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                          data/models/embedding/
                        </code>
                        . The export writes both the{" "}
                        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                          .onnx
                        </code>{" "}
                        graph and its{" "}
                        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                          tokenizer.json
                        </code>{" "}
                        — both are required; without the tokenizer, memory is
                        stored unembedded rather than with meaningless vectors.
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs">
                  <StatusDot ok={onnxLoaded} />
                  <span className="text-muted-foreground">
                    {onnxLoaded
                      ? "Session loaded in memory"
                      : "Session unloaded — loads on first use"}
                  </span>
                </div>
              )}
            <div className="pt-2">
              <ModelBrowserDialog kind="embedding" onInstalled={onModelInstalled} />
            </div>
            </FieldGroup>
          ) : embProviderId === null ? (
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

