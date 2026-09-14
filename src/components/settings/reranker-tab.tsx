"use client";

import React from "react";
import { ModelBrowserDialog } from "@/components/settings/model-browser-dialog";
import {
  Brain,
  Check,
  Cpu,
  DownloadSimple,
  Folder,
  Warning,
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
import {
  Field,
  FieldDescription,
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
import { formatBytes } from "@/components/settings/shared";

export type RerankerInfo = {
  enabled: boolean;
  available: boolean;
  loaded: boolean;
  modelPath: string | null;
  canonicalPath: string;
  mode: "active" | "standby" | "fallback" | "disabled";
  discoveredModels: Array<{ filename: string; sizeBytes: number }>;
};

export type RerankerTabProps = {
  reranker: RerankerInfo | null;
  enabled: boolean;
  selectedModel: string;
  onToggleEnabled: (enabled: boolean) => void;
  onSelectModel: (model: string) => void;
  onSave?: () => Promise<void>;
  onModelInstalled?: () => void;
  saving?: boolean;
  saved?: boolean;
  saveError?: string | null;
};

function ModeBadge({
  mode,
}: {
  mode: "active" | "standby" | "fallback" | "disabled";
}) {
  switch (mode) {
    case "active":
      return (
        <Badge
          className="border-success/30 bg-success/10 text-success"
          variant="outline"
        >
          Active
        </Badge>
      );
    case "standby":
      return (
        <Badge
          className="border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400"
          variant="outline"
        >
          Standby
        </Badge>
      );
    case "fallback":
      return (
        <Badge
          className="border-warning/30 bg-warning/10 text-warning"
          variant="outline"
        >
          Fallback
        </Badge>
      );
    case "disabled":
    default:
      return <Badge variant="secondary">Disabled</Badge>;
  }
}

function ConfigRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className="truncate font-medium text-right"
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 shrink-0 rounded-full ${ok ? "bg-success" : "bg-muted-foreground/40"}`}
    />
  );
}

export function RerankerTab({
  reranker,
  enabled,
  selectedModel,
  onToggleEnabled,
  onSelectModel,
  onSave,
  onModelInstalled = () => {},
  saving = false,
  saved = false,
  saveError = null,
}: RerankerTabProps) {
  const discoveredModels = reranker?.discoveredModels ?? [];
  const modelPath = reranker?.modelPath ?? null;

  const activeFilename = modelPath
    ? modelPath.split("/").pop() ?? ""
    : selectedModel;

  const activeModelEntry = discoveredModels.find(
    (m) => m.filename === activeFilename
  );

  const activeFileSize = activeModelEntry
    ? formatBytes(activeModelEntry.sizeBytes)
    : "—";

  const mode =
    reranker?.mode ??
    (!enabled
      ? "disabled"
      : discoveredModels.length > 0
        ? "standby"
        : "fallback");

  const loaded = reranker?.loaded ?? false;

  const effectiveSelectedModel =
    selectedModel ||
    (activeFilename && discoveredModels.some((m) => m.filename === activeFilename)
      ? activeFilename
      : discoveredModels.length > 0
        ? discoveredModels[0].filename
        : "");

  return (
    <div className="flex flex-col gap-4">
      {/* On/Off Switch Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="size-4" />
            Neural reranking
          </CardTitle>
          <CardDescription>
            Cross-encoder scoring evaluates query-document pairs together,
            improving precision over pure vector similarity.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <div className="flex flex-col gap-1">
              <FieldLabel
                className="cursor-pointer font-medium"
                htmlFor="reranker-switch"
              >
                Enable neural reranker
              </FieldLabel>
              <p className="text-muted-foreground text-xs">
                When enabled, retrieved memory candidates are re-scored using
                the local ONNX cross-encoder model before being placed into context.
              </p>
            </div>
            <Switch
              aria-label="Toggle neural reranker"
              checked={enabled}
              disabled={saving}
              id="reranker-switch"
              onCheckedChange={onToggleEnabled}
            />
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-2">
              {saved && (
                <Badge
                  className="gap-1 border-success/30 bg-success/10 text-success"
                  variant="outline"
                >
                  <Check className="size-3" />
                  Saved
                </Badge>
              )}
              {saveError && (
                <span className="text-destructive text-xs">{saveError}</span>
              )}
            </div>
            {onSave && (
              <Button
                disabled={saving}
                onClick={onSave}
                size="sm"
                type="button"
              >
                {saving ? "Saving…" : "Save configuration"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Auto-discovery Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Folder className="size-4" />
            Discovered models
          </CardTitle>
          <CardDescription>
            Auto-discovers ONNX cross-encoder models in{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              data/models/reranker/
            </code>{" "}
            (files &ge; 50 MB).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {discoveredModels.length === 0 ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
                <div className="flex items-start gap-2">
                  <Warning className="mt-0.5 size-4 shrink-0 text-warning" />
                  <div className="flex flex-col gap-1">
                    <span className="font-medium text-foreground">
                      No ONNX reranker models discovered
                    </span>
                    <span className="text-muted-foreground text-xs">
                      Neural reranking is falling back to standard vector cosine
                      similarity search. Memory retrieval remains fully functional.
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-3 rounded-lg border p-4 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  <DownloadSimple className="size-4" />
                  Install the default neural reranker model
                </div>
                <p className="text-muted-foreground text-xs">
                  Download the quantized INT8 model{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    bge-reranker-v2-m3-int8.onnx
                  </code>{" "}
                  (~544 MB) into the canonical models directory:
                </p>
                <pre className="overflow-x-auto rounded bg-muted p-2.5 font-mono text-xs select-all">
                  mkdir -p data/models/reranker{"\n"}
                  curl -L -o data/models/reranker/bge-reranker-v2-m3-int8.onnx \{"\n"}
                  {"  "}https://huggingface.co/BAAI/bge-reranker-v2-m3/resolve/main/onnx/model_quantized.onnx
                </pre>
                <p className="text-muted-foreground text-xs">
                  Or export and quantize from source using Hugging Face optimum:
                </p>
                <pre className="overflow-x-auto rounded bg-muted p-2.5 font-mono text-xs select-all">
                  optimum-cli export onnx --model BAAI/bge-reranker-v2-m3 --task text-classification --opset 17 ./export{"\n"}
                  optimum-cli onnxruntime quantize --avx2 --onnx_model ./export/onnx -o data/models/reranker/bge-reranker-v2-m3-int8.onnx
                </pre>
                <p className="text-muted-foreground text-xs">
                  Once a valid ONNX file is present in{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    data/models/reranker/
                  </code>
                  , the system automatically detects and loads it without a restart.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {discoveredModels.length > 1 && (
                <Field>
                  <FieldLabel htmlFor="reranker-model-select">
                    Active model file
                  </FieldLabel>
                  <Select
                    onValueChange={onSelectModel}
                    value={effectiveSelectedModel}
                  >
                    <SelectTrigger
                      className="w-full"
                      id="reranker-model-select"
                    >
                      <SelectValue placeholder="Select model file…" />
                    </SelectTrigger>
                    <SelectContent>
                      {discoveredModels.map((m) => (
                        <SelectItem key={m.filename} value={m.filename}>
                          <span className="font-mono text-xs">{m.filename}</span>{" "}
                          <span className="text-muted-foreground text-xs font-normal">
                            ({formatBytes(m.sizeBytes)})
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Multiple models discovered. Choose which model file to use for
                    neural reranking.
                  </FieldDescription>
                </Field>
              )}

              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  Discovered model files ({discoveredModels.length})
                </span>
                <ul className="space-y-2">
                  {discoveredModels.map((m) => {
                    const isSelected =
                      effectiveSelectedModel === m.filename ||
                      activeFilename === m.filename;
                    const isDefault =
                      m.filename === "bge-reranker-v2-m3-int8.onnx";
                    return (
                      <li
                        className="flex items-center justify-between gap-3 rounded-lg border p-3"
                        key={m.filename}
                      >
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-mono text-sm font-medium">
                              {m.filename}
                            </span>
                            {isSelected && (
                              <Badge
                                className="text-[10px]"
                                variant="secondary"
                              >
                                In use
                              </Badge>
                            )}
                            {isDefault && (
                              <Badge
                                className="text-[10px]"
                                variant="outline"
                              >
                                Default
                              </Badge>
                            )}
                          </div>
                          <span className="text-muted-foreground font-mono text-xs">
                            data/models/reranker/{m.filename}
                          </span>
                        </div>
                        <div className="shrink-0 font-mono text-xs text-muted-foreground">
                          {formatBytes(m.sizeBytes)}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}
        </CardContent>
        <CardContent>
          <ModelBrowserDialog
            kind="reranker"
            onInstalled={onModelInstalled ?? (() => {})}
          />
        </CardContent>
      </Card>

      {/* Status & Diagnostics Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Cpu className="size-4" />
                Status & diagnostics
              </CardTitle>
              <CardDescription>
                Runtime execution state, memory allocation, and model details.
              </CardDescription>
            </div>
            <div>
              <ModeBadge mode={mode} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 text-muted-foreground">
              <StatusDot ok={loaded} />
              Loaded in memory
            </span>
            <span className="font-medium">
              {loaded
                ? "Yes (active session in RAM)"
                : "No (unloaded, zero RAM footprint)"}
            </span>
          </div>
          <div className="my-1 border-t" />
          <ConfigRow
            label="Mode"
            value={<span className="capitalize">{mode}</span>}
          />
          <ConfigRow
            label="Model in use"
            value={
              activeFilename ? (
                <span className="font-mono text-xs">{activeFilename}</span>
              ) : (
                "— (vector search fallback)"
              )
            }
          />
          <ConfigRow label="File size" value={activeFileSize} />
          <ConfigRow
            label="Model path"
            value={
              modelPath ? (
                <span className="font-mono text-xs">{modelPath}</span>
              ) : (
                "—"
              )
            }
          />
          <ConfigRow
            label="Idle timeout"
            value="2 minutes (auto-unload)"
          />
          <ConfigRow
            label="Canonical directory"
            value={
              <span className="font-mono text-xs">data/models/reranker/</span>
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
