"use client";

import React, { useState } from "react";
import { ModelBrowserDialog } from "@/components/settings/model-browser-dialog";
import {
  Brain,
  Check,
  CheckCircle,
  Cpu,
  DownloadSimple,
  Folder,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ModelKind } from "@/lib/models/types";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type RerankerInfo = {
  enabled: boolean;
  available: boolean;
  loaded: boolean;
  modelPath: string | null;
  sizeBytes?: number;
  canonicalPath: string;
  mode: "active" | "standby" | "fallback" | "disabled";
  discoveredModels: Array<{ filename: string; sizeBytes: number }>;
};

export type RerankerTabProps = {
  reranker: RerankerInfo | null;
  enabled: boolean;
  selectedModel: string;
  idleTimeoutMinutes?: number;
  onToggleEnabled: (enabled: boolean) => void;
  onSelectModel: (model: string) => void;
  onChangeIdleTimeoutMinutes?: (minutes: number) => void;
  onSave?: () => Promise<void>;
  onModelInstalled?: (repo?: string) => void;
  onModelDeleted?: (filename: string) => void;
  installedModelNotification?: { repo: string; kind: ModelKind } | null;
  onDismissInstallNotification?: () => void;
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
          className="border-warning/30 bg-warning/10 text-warning"
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
  idleTimeoutMinutes = 15,
  onToggleEnabled,
  onSelectModel,
  onChangeIdleTimeoutMinutes,
  onSave,
  onModelInstalled = () => {},
  onModelDeleted,
  installedModelNotification,
  onDismissInstallNotification,
  saving = false,
  saved = false,
  saveError = null,
}: RerankerTabProps) {
  const [confirmDeleteModel, setConfirmDeleteModel] = useState<{
    filename: string;
    sizeBytes: number;
  } | null>(null);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async (targetModel: { filename: string; sizeBytes: number }) => {
    setDeletingModel(targetModel.filename);
    setDeleteError(null);
    try {
      const res = await fetch("/api/models/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "reranker", model: targetModel.filename }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Failed to delete model (${res.status})`);
      }
      setConfirmDeleteModel(null);
      onModelDeleted?.(targetModel.filename);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingModel(null);
    }
  };

  const discoveredModels = reranker?.discoveredModels ?? [];
  const modelPath = reranker?.modelPath ?? null;

  // Match active model entry across absolute path, relative path, or basename
  const activeModelEntry =
    discoveredModels.find((m) => {
      if (!modelPath) return false;
      if (m.filename === modelPath) return true;
      if (
        modelPath.endsWith("/" + m.filename) ||
        modelPath.endsWith("\\" + m.filename)
      ) {
        return true;
      }
      const base = modelPath.split(/[/\\]/).pop();
      return base ? m.filename === base || m.filename.endsWith("/" + base) : false;
    }) ??
    (selectedModel
      ? discoveredModels.find(
          (m) =>
            m.filename === selectedModel ||
            m.filename.endsWith("/" + selectedModel)
        )
      : null) ??
    (discoveredModels.length === 1 ? discoveredModels[0] : null);

  const activeFilename =
    activeModelEntry?.filename ??
    (modelPath
      ? modelPath.includes("data/models/reranker/")
        ? modelPath.split("data/models/reranker/").pop() ??
          modelPath.split(/[/\\]/).pop() ??
          ""
        : modelPath.split(/[/\\]/).pop() ?? ""
      : selectedModel);

  const activeBytes =
    activeModelEntry?.sizeBytes ??
    (typeof reranker?.sizeBytes === "number" && reranker.sizeBytes > 0
      ? reranker.sizeBytes
      : null);

  const activeFileSize = activeBytes !== null ? formatBytes(activeBytes) : "—";

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
    (activeFilename &&
    discoveredModels.some((m) => m.filename === activeFilename)
      ? activeFilename
      : discoveredModels.length > 0
        ? discoveredModels[0].filename
        : "");

  return (
    <div className="flex flex-col gap-4">
      {installedModelNotification && installedModelNotification.kind === "reranker" && (
        <Alert className="border-success/40 bg-success/10 text-success">
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
            Reranker model{" "}
            <strong className="font-mono text-foreground">
              {installedModelNotification.repo}
            </strong>{" "}
            has been downloaded, verified, and is ready for use.
          </AlertDescription>
        </Alert>
      )}

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

          {enabled && (
            <Field>
              <FieldLabel htmlFor="reranker-timeout-select">
                Session lifecycle & memory timeout
              </FieldLabel>
              <Select
                disabled={saving}
                onValueChange={(val) => onChangeIdleTimeoutMinutes?.(Number(val))}
                value={String(idleTimeoutMinutes ?? 15)}
              >
                <SelectTrigger id="reranker-timeout-select" className="w-full">
                  <SelectValue placeholder="Select timeout…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">
                    5 minutes — Eco mode (frees RAM quickly, minimal resource usage)
                  </SelectItem>
                  <SelectItem value="15">
                    15 minutes — Adaptive Balanced (Recommended, keeps session warm during chatting)
                  </SelectItem>
                  <SelectItem value="30">
                    30 minutes — Extended (ideal for longer working sessions)
                  </SelectItem>
                  <SelectItem value="0">
                    Always on — Never unload (keeps model pinned in RAM for zero latency)
                  </SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>
                How long the local ONNX session stays resident in RAM after the last query. A sliding window resets the timer on each turn.
              </FieldDescription>
            </Field>
          )}

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
                            <span className="truncate font-mono text-sm font-medium" title={m.filename}>
                              {m.filename}
                            </span>
                            {isSelected && (
                              <Badge
                                className="text-[11px]"
                                variant="secondary"
                              >
                                In use
                              </Badge>
                            )}
                            {isDefault && (
                              <Badge
                                className="text-[11px]"
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
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="font-mono text-xs text-muted-foreground">
                            {formatBytes(m.sizeBytes)}
                          </span>
                          <Button
                            aria-label={`Delete ${m.filename}`}
                            className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            disabled={deletingModel === m.filename}
                            onClick={() => setConfirmDeleteModel(m)}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <Trash className="size-3.5" />
                          </Button>
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

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={confirmDeleteModel !== null}
        onOpenChange={(open) => !open && setConfirmDeleteModel(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Model</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                {confirmDeleteModel?.filename}
              </code>
              ? This will completely purge the model directory and weights (
              {formatBytes(confirmDeleteModel?.sizeBytes ?? 0)}) from disk.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-destructive text-xs">{deleteError}</p>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmDeleteModel(null)}
              disabled={deletingModel !== null}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deletingModel !== null}
              onClick={() => confirmDeleteModel && void handleDelete(confirmDeleteModel)}
            >
              {deletingModel ? "Deleting…" : "Delete Permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            value={`${idleTimeoutMinutes ?? 15} minutes (auto-unload)`}
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
