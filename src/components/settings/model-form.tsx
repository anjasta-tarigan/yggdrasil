"use client";

import { useEffect, useState, useRef } from "react";
import {
  ArrowClockwise,
  Brain,
  FileText,
  Headphones,
  Image as ImageIcon,
  Video,
  Wrench,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type {
  Capabilities,
  CapabilitySources,
  Modality,
  ModelEntry,
} from "@/lib/ai/provider-config/schema";

export type ModelFormProps = {
  open: boolean;
  providerId: string;
  model?: ModelEntry | null;
  onSave: (entry: ModelEntry) => void;
  onClose: () => void;
};

/**
 * Format a capability number for display: null-safe, "k"-abbreviated.
 * Shared with ProviderTab via the model-form export (single formatter —
 * the duplication was a review finding).
 */
export function formatTokenCount(
  val: number | null | undefined,
): string | null {
  if (val == null || typeof val !== "number" || isNaN(val)) return null;
  if (val >= 1000) {
    return `${Math.round(val / 1000)}k`;
  }
  return String(val);
}

export function ModelForm({
  open,
  providerId,
  model,
  onSave,
  onClose,
}: ModelFormProps) {
  const [modelId, setModelId] = useState(model?.modelId ?? "");
  const [displayName, setDisplayName] = useState(model?.displayName ?? "");
  const [isDefault, setIsDefault] = useState(model?.isDefault ?? false);

  const [contextWindow, setContextWindow] = useState<number | null>(
    model?.capabilities?.contextWindow ?? null
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | null>(
    model?.capabilities?.maxOutputTokens ?? null
  );
  const [supportsToolCalls, setSupportsToolCalls] = useState<boolean | null>(
    model?.capabilities?.supportsToolCalls ?? null
  );
  const [supportsReasoning, setSupportsReasoning] = useState<boolean | null>(
    model?.capabilities?.supportsReasoning ?? null
  );
  const [inputModalities, setInputModalities] = useState<Modality[]>(
    model?.capabilities?.inputModalities ?? ["text"]
  );
  const [outputModalities, setOutputModalities] = useState<Modality[]>(
    model?.capabilities?.outputModalities ?? ["text"]
  );
  const [capabilitySources, setCapabilitySources] = useState<CapabilitySources>(
    model?.capabilitySources ?? {}
  );
  const [userOverrides, setUserOverrides] = useState<Set<string>>(new Set());

  const [detecting, setDetecting] = useState(false);
  const [matchedCatalogId, setMatchedCatalogId] = useState<string | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);

  // Keep the async detection loop reading the freshest override set
  // without re-running it on every keystroke (Rule 19: no ref writes
  // during render — the assignment lives in an effect).
  const userOverridesRef = useRef(userOverrides);
  useEffect(() => {
    userOverridesRef.current = userOverrides;
  }, [userOverrides]);

  // Countdown timer effect
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  const performDetection = async (targetModelId: string, force: boolean) => {
    const trimmedId = targetModelId.trim();
    if (!trimmedId || !providerId) return;

    setDetecting(true);
    setDetectError(null);
    try {
      const res = await fetch("/api/providers/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId,
          modelId: trimmedId,
          force,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Detection failed (HTTP ${res.status})`);
      }

      const data = await res.json();
      const detectedCaps: Partial<Capabilities> = data.capabilities ?? {};
      const detectedSources: CapabilitySources = data.capabilitySources ?? {};

      const overrides = userOverridesRef.current;

      if (!overrides.has("contextWindow") && detectedCaps.contextWindow !== undefined) {
        setContextWindow(detectedCaps.contextWindow);
      }
      if (!overrides.has("maxOutputTokens") && detectedCaps.maxOutputTokens !== undefined) {
        setMaxOutputTokens(detectedCaps.maxOutputTokens);
      }
      if (!overrides.has("supportsToolCalls") && detectedCaps.supportsToolCalls !== undefined) {
        setSupportsToolCalls(detectedCaps.supportsToolCalls);
      }
      if (!overrides.has("supportsReasoning") && detectedCaps.supportsReasoning !== undefined) {
        setSupportsReasoning(detectedCaps.supportsReasoning);
      }
      if (!overrides.has("inputModalities") && Array.isArray(detectedCaps.inputModalities)) {
        setInputModalities(detectedCaps.inputModalities);
      }
      if (!overrides.has("outputModalities") && Array.isArray(detectedCaps.outputModalities)) {
        setOutputModalities(detectedCaps.outputModalities);
      }

      setCapabilitySources((prev) => {
        const next = { ...prev };
        for (const [k, v] of Object.entries(detectedSources)) {
          if (!overrides.has(k)) {
            next[k] = v;
          }
        }
        return next;
      });

      setMatchedCatalogId(data.matchedCatalogId ?? null);
      setCountdown(60);
    } catch (err: any) {
      setDetectError(err?.message ?? "Auto-detection error");
    } finally {
      setDetecting(false);
    }
  };

  // Auto-detect effect: debounced 600ms on typing modelId (only in create mode)
  useEffect(() => {
    if (model) return; // Only auto-detect on typing when adding a new model
    const trimmed = modelId.trim();
    if (!trimmed || !providerId) return;

    const timer = setTimeout(() => {
      void performDetection(trimmed, false);
    }, 600);

    return () => clearTimeout(timer);
  }, [modelId, providerId, model]);

  const markOverride = (fieldName: string) => {
    setUserOverrides((prev) => new Set(prev).add(fieldName));
  };

  const handleToggleInputModality = (mod: Modality) => {
    markOverride("inputModalities");
    setInputModalities((prev) => {
      const exists = prev.includes(mod);
      const next = exists ? prev.filter((m) => m !== mod) : [...prev, mod];
      return next.length > 0 ? next : ["text"];
    });
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = modelId.trim();
    if (!cleanId) return;

    const finalDisplayName = displayName.trim() || cleanId;
    const finalCaps: Capabilities = {
      contextWindow,
      maxOutputTokens,
      supportsToolCalls,
      supportsReasoning,
      inputModalities: inputModalities.length > 0 ? inputModalities : ["text"],
      outputModalities: outputModalities.length > 0 ? outputModalities : ["text"],
    };

    const finalSources: CapabilitySources = { ...capabilitySources };
    for (const field of userOverrides) {
      finalSources[field] = "user";
    }

    onSave({
      modelId: cleanId,
      displayName: finalDisplayName,
      isDefault,
      capabilities: finalCaps,
      capabilitySources: finalSources,
    });
    onClose();
  };

  return (
    <Dialog onOpenChange={(isOpen) => !isOpen && onClose()} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{model ? "Edit Model" : "Add Model"}</DialogTitle>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSave}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="model-id">Model ID</FieldLabel>
              <div className="flex gap-2">
                <Input
                  disabled={Boolean(model)}
                  id="model-id"
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="e.g. gpt-4o, llama3.2"
                  required
                  value={modelId}
                />
                <Button
                  aria-label="Re-detect capabilities"
                  disabled={detecting || !modelId.trim()}
                  onClick={() => void performDetection(modelId, true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <ArrowClockwise
                    className={`size-4 ${detecting ? "animate-spin" : ""}`}
                  />
                  {countdown > 0 ? `Re-detect ${countdown}s` : "Detect"}
                </Button>
              </div>
              {detectError && (
                <p className="text-destructive text-xs">{detectError}</p>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="model-display-name">Display Name</FieldLabel>
              <Input
                id="model-display-name"
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Optional friendly name"
                value={displayName}
              />
            </Field>

            <Field className="flex items-center justify-between" orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="model-default">Default Model</FieldLabel>
                <FieldDescription>
                  Make this the default model for conversations
                </FieldDescription>
              </FieldContent>
              <Switch
                checked={isDefault}
                id="model-default"
                onCheckedChange={setIsDefault}
              />
            </Field>
          </FieldGroup>

          {/* Capabilities summary panel */}
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground">Detected Capabilities</span>
              {matchedCatalogId && (
                <Badge variant="outline">catalog: {matchedCatalogId}</Badge>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5 pt-1">
              <Badge variant="secondary">
                {formatTokenCount(contextWindow)} ctx
              </Badge>
              <Badge variant="secondary">
                {formatTokenCount(maxOutputTokens)} out
              </Badge>
              {supportsToolCalls && (
                <Badge className="gap-1" variant="secondary">
                  <Wrench className="size-3" /> Tools
                </Badge>
              )}
              {supportsReasoning && (
                <Badge className="gap-1" variant="secondary">
                  <Brain className="size-3" /> Reasoning
                </Badge>
              )}
              {inputModalities.includes("image") && (
                <Badge className="gap-1" variant="secondary">
                  <ImageIcon className="size-3" /> Image
                </Badge>
              )}
              {inputModalities.includes("audio") && (
                <Badge className="gap-1" variant="secondary">
                  <Headphones className="size-3" /> Audio
                </Badge>
              )}
              {inputModalities.includes("video") && (
                <Badge className="gap-1" variant="secondary">
                  <Video className="size-3" /> Video
                </Badge>
              )}
              {inputModalities.includes("pdf") && (
                <Badge className="gap-1" variant="secondary">
                  <FileText className="size-3" /> PDF
                </Badge>
              )}
            </div>
          </div>

          {/* Overrides */}
          <div className="space-y-3 border-t pt-3">
            <p className="font-medium text-muted-foreground text-xs">
              Manual Overrides
            </p>

            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="ctx-window">Context Window</FieldLabel>
                <Input
                  id="ctx-window"
                  min={1}
                  onChange={(e) => {
                    markOverride("contextWindow");
                    const val = e.target.value ? parseInt(e.target.value, 10) : null;
                    setContextWindow(isNaN(val as number) ? null : val);
                  }}
                  placeholder="e.g. 128000"
                  type="number"
                  value={contextWindow ?? ""}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="max-output">Max Output Tokens</FieldLabel>
                <Input
                  id="max-output"
                  min={1}
                  onChange={(e) => {
                    markOverride("maxOutputTokens");
                    const val = e.target.value ? parseInt(e.target.value, 10) : null;
                    setMaxOutputTokens(isNaN(val as number) ? null : val);
                  }}
                  placeholder="e.g. 16384"
                  type="number"
                  value={maxOutputTokens ?? ""}
                />
              </Field>
            </div>

            <Field className="flex items-center justify-between" orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="supports-tools">Supports Tool Calling</FieldLabel>
              </FieldContent>
              <Switch
                checked={supportsToolCalls ?? false}
                id="supports-tools"
                onCheckedChange={(val) => {
                  markOverride("supportsToolCalls");
                  setSupportsToolCalls(val);
                }}
              />
            </Field>

            <Field className="flex items-center justify-between" orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="supports-reasoning">Supports Reasoning</FieldLabel>
              </FieldContent>
              <Switch
                checked={supportsReasoning ?? false}
                id="supports-reasoning"
                onCheckedChange={(val) => {
                  markOverride("supportsReasoning");
                  setSupportsReasoning(val);
                }}
              />
            </Field>

            <Field>
              <FieldLabel>Input Modalities</FieldLabel>
              <div className="flex flex-wrap gap-2 pt-1">
                {(["image", "audio", "video", "pdf"] as Modality[]).map((mod) => {
                  const active = inputModalities.includes(mod);
                  return (
                    <Button
                      key={mod}
                      onClick={() => handleToggleInputModality(mod)}
                      size="sm"
                      type="button"
                      variant={active ? "default" : "outline"}
                    >
                      {mod.charAt(0).toUpperCase() + mod.slice(1)}
                    </Button>
                  );
                })}
              </div>
            </Field>
          </div>

          <DialogFooter className="mt-2">
            <Button onClick={onClose} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={!modelId.trim()} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
