"use client";

import { CheckCircle, Warning } from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/components/settings/shared";

export type GgufModelOption = {
  filename: string;
  path: string;
  sizeBytes: number;
  fitsMemory: boolean;
};

export function GgufAddDialog({
  open,
  onOpenChange,
  busy,
  error,
  serverFound,
  serverPath,
  serverVersion,
  models,
  customServerPath,
  onCustomServerPathChange,
  selectedModels,
  onSelectedModelsChange,
  onReprobe,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  error: string | null;
  /** null while the first probe is still running. */
  serverFound: boolean | null;
  serverPath: string | null;
  serverVersion: number | null;
  models: GgufModelOption[];
  customServerPath: string;
  onCustomServerPathChange: (value: string) => void;
  selectedModels: Set<string>;
  onSelectedModelsChange: (next: Set<string>) => void;
  onReprobe: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onOpenChange(false); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add GGUF Model</DialogTitle>
          <DialogDescription>
            {busy
              ? "Probing for llama-server…"
              : serverFound === false
                ? "llama-server is not installed."
                : serverFound === true && models.length > 0
                  ? "Select the GGUF model(s) to add."
                  : "No GGUF models found in data/models/GGUF-chatModel."}
          </DialogDescription>
        </DialogHeader>

        {serverFound === true && serverPath && (
          <Alert variant="default">
            <CheckCircle className="size-4 text-success" />
            <AlertTitle>llama-server detected</AlertTitle>
            <AlertDescription className="mt-1 text-sm break-all">
              {serverPath}
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <Warning className="size-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {serverFound === false && (
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
                  value={customServerPath}
                  onChange={(e) => onCustomServerPathChange(e.target.value)}
                  disabled={busy}
                  className="font-mono text-xs flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || !customServerPath}
                  onClick={() => onReprobe()}
                >
                  Re-probe
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {serverFound === true && models.length > 0 && (
          // Model list with checkboxes (multi-select).
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {models.map((m) => {
              const checked = selectedModels.has(m.filename);
              return (
                <label
                  key={m.filename}
                  className="flex items-center gap-3 p-2 border rounded cursor-pointer hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = new Set(selectedModels);
                      if (e.target.checked) next.add(m.filename);
                      else next.delete(m.filename);
                      onSelectedModelsChange(next);
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

        {serverFound === true && models.length === 0 && !busy && (
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
            {serverFound === true && serverVersion !== null && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-success" />
                llama-server build {serverVersion}
              </span>
            )}
            {serverFound === true && serverVersion === null && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-warning" />
                llama-server detected (version unknown)
              </span>
            )}
            {serverFound === false && !error && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-destructive" />
                llama-server not found
              </span>
            )}
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm()}
            disabled={busy || serverFound !== true || selectedModels.size === 0}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
