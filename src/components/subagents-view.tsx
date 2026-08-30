"use client";

import { Badge } from "@/components/ui/badge";
import { PageView } from "@/components/app-shell/page-view";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowsClockwise,
  PencilSimple,
  Plus,
  TrashSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

export type SubagentEntry = {
  id: string;
  name: string;
  instructions: string;
  tools: string[];
  enabled: boolean;
  model?: string;
  maxSteps: number;
  description?: string;
  createdAt: string;
  updatedAt: string;
  builtIn?: boolean;
};

export type ToolRegistryEntry = {
  key: string;
  label: string;
  description: string;
};

type SubagentsApiResponse = {
  subagents: SubagentEntry[];
  toolRegistry: ToolRegistryEntry[];
};

type SubagentForm = {
  name: string;
  instructions: string;
  tools: string[];
  enabled: boolean;
  model: string;
  maxSteps: number;
  description: string;
};

const EMPTY_FORM: SubagentForm = {
  name: "",
  instructions: "",
  tools: [],
  enabled: true,
  model: "",
  maxSteps: 12,
  description: "",
};

function validateForm(
  form: SubagentForm,
  registry: ToolRegistryEntry[]
): Partial<Record<keyof SubagentForm, string>> {
  const errors: Partial<Record<keyof SubagentForm, string>> = {};
  if (form.name.trim().length === 0) {
    errors.name = "Name is required";
  } else if (form.name.length > 128) {
    errors.name = "Name must be at most 128 characters";
  }
  if (form.instructions.trim().length === 0) {
    errors.instructions = "Instructions are required";
  } else if (form.instructions.length > 20_000) {
    errors.instructions = "Instructions must be at most 20000 characters";
  }
  if (form.tools.length === 0) {
    errors.tools = "Grant at least one tool capability";
  } else if (!form.tools.every((t) => registry.some((r) => r.key === t))) {
    errors.tools = "Unknown tool capability";
  }
  if (!Number.isFinite(form.maxSteps) || form.maxSteps < 1 || form.maxSteps > 50) {
    errors.maxSteps = "Max steps must be between 1 and 50";
  }
  if (form.description.length > 500) {
    errors.description = "Description must be at most 500 characters";
  }
  return errors;
}

export function SubagentsView({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<SubagentsApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [feedbackNote, setFeedbackNote] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SubagentForm>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<
    Partial<Record<keyof SubagentForm, string>>
  >({});
  const [saving, setSaving] = useState(false);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SubagentEntry | null>(
    null
  );

  const fetchSubagents = useCallback(async () => {
    try {
      const res = await fetch("/api/subagents", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SubagentsApiResponse;
      setData(json);
    } catch (err) {
      console.warn("Failed to fetch subagents", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSubagents();
  }, [fetchSubagents]);

  const showFeedback = (note: string, isError = false) => {
    setFeedbackNote(note);
    setFeedbackError(isError);
  };

  const openCreateDialog = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormErrors({});
    setDialogOpen(true);
  };

  const openEditDialog = (entry: SubagentEntry) => {
    setEditingId(entry.id);
    setForm({
      name: entry.name,
      instructions: entry.instructions,
      tools: entry.tools,
      enabled: entry.enabled,
      model: entry.model ?? "",
      maxSteps: entry.maxSteps,
      description: entry.description ?? "",
    });
    setFormErrors({});
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const registry = data?.toolRegistry ?? [];
    const errors = validateForm(form, registry);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    try {
      const body = editingId
        ? {
            id: editingId,
            name: form.name.trim(),
            instructions: form.instructions.trim(),
            tools: form.tools,
            enabled: form.enabled,
            model: form.model.trim(),
            maxSteps: form.maxSteps,
            description: form.description.trim(),
          }
        : {
            name: form.name.trim(),
            instructions: form.instructions.trim(),
            tools: form.tools,
            enabled: form.enabled,
            model: form.model.trim(),
            maxSteps: form.maxSteps,
            description: form.description.trim(),
          };

      const res = await fetch("/api/subagents", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { error?: string; issues?: string[] };
      if (!res.ok) {
        throw new Error(json.issues?.[0] ?? json.error ?? `HTTP ${res.status}`);
      }
      setDialogOpen(false);
      showFeedback(
        editingId
          ? `Subagent "${form.name.trim()}" updated`
          : `Subagent "${form.name.trim()}" created`
      );
      await fetchSubagents();
    } catch (err) {
      setFormErrors({
        name: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (entry: SubagentEntry) => {
    setFeedbackNote(null);
    try {
      const res = await fetch("/api/subagents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, enabled: !entry.enabled }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      showFeedback(
        `Subagent "${entry.name}" ${entry.enabled ? "disabled" : "enabled"}`
      );
      await fetchSubagents();
    } catch (err) {
      showFeedback(
        `Failed to toggle: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    }
  };

  const handleDelete = async (entry: SubagentEntry) => {
    setDeletingId(entry.id);
    setFeedbackNote(null);
    try {
      const res = await fetch(
        `/api/subagents?id=${encodeURIComponent(entry.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setConfirmDelete(null);
      showFeedback(`Subagent "${entry.name}" deleted`);
      await fetchSubagents();
    } catch (err) {
      showFeedback(
        `Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    } finally {
      setDeletingId(null);
    }
  };

  const toggleTool = (key: string) => {
    setForm((f) => ({
      ...f,
      tools: f.tools.includes(key)
        ? f.tools.filter((t) => t !== key)
        : [...f.tools, key],
    }));
  };

  return (
    <PageView
      actions={
        <>
          <Button
            className="gap-1.5"
            disabled={loading}
            onClick={() => void fetchSubagents()}
            size="sm"
            type="button"
            variant="outline"
          >
            <ArrowsClockwise
              className={loading ? "size-3.5 animate-spin" : "size-3.5"}
            />
            Refresh
          </Button>
          <Button
            className="gap-1.5"
            onClick={openCreateDialog}
            size="sm"
            type="button"
          >
            <Plus className="size-3.5" />
            Add Subagent
          </Button>
        </>
      }
      description="Specialized assistants the main model can delegate to — each runs with its own context window and tool access."
      onBack={onBack}
      title="Subagents"
    >

        {feedbackNote && (
          <div
            className={`mb-6 flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
              feedbackError
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-primary/30 bg-muted/40 text-foreground"
            }`}
          >
            <WarningCircle
              className={`size-4 shrink-0 ${feedbackError ? "text-destructive" : "text-primary"}`}
            />
            <span>{feedbackNote}</span>
          </div>
        )}

        {/* Subagent cards */}
        <div className="space-y-3">
          {(data?.subagents.length ?? 0) === 0 ? (
            <Card>
              <CardContent className="px-4 py-8 text-center text-sm text-muted-foreground">
                No subagents configured. Use “Add Subagent” to create your
                first specialist.
              </CardContent>
            </Card>
          ) : (
            data?.subagents.map((entry) => (
              <Card
                className={entry.enabled ? undefined : "opacity-70"}
                key={entry.id}
              >
                <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{entry.name}</span>
                      {entry.builtIn ? (
                        <Badge variant="outline">built-in</Badge>
                      ) : null}
                      <Badge
                        className={
                          entry.enabled
                            ? "border-green-600/30 bg-green-500/10 text-green-700 dark:text-green-400"
                            : undefined
                        }
                        variant="outline"
                      >
                        {entry.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {entry.tools.map((t) => (
                        <Badge
                          className="text-[10px]"
                          key={t}
                          variant="secondary"
                        >
                          {t}
                        </Badge>
                      ))}
                      <span className="text-[11px] text-muted-foreground">
                        · max {entry.maxSteps} steps
                        {entry.model ? ` · ${entry.model}` : ""}
                      </span>
                    </div>
                    {entry.description ? (
                      <p className="text-xs text-muted-foreground">
                        {entry.description}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Switch
                      aria-label={`Toggle ${entry.name}`}
                      checked={entry.enabled}
                      onCheckedChange={() => void handleToggleEnabled(entry)}
                    />
                    <Button
                      aria-label={`Edit ${entry.name}`}
                      onClick={() => openEditDialog(entry)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <PencilSimple className="size-4" />
                    </Button>
                    <Button
                      aria-label={`Delete ${entry.name}`}
                      onClick={() => setConfirmDelete(entry)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <TrashSimple className="size-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {/* Create / edit dialog */}
        <Dialog
          onOpenChange={(open) => setDialogOpen(open)}
          open={dialogOpen}
        >
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {editingId ? "Edit Subagent" : "Add Subagent"}
              </DialogTitle>
              <DialogDescription>
                Each subagent runs with its own context window. The main model
                sees only its final summary; you see its full work.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="sub-name">
                  Name
                </label>
                <Input
                  id="sub-name"
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder="Researcher"
                  value={form.name}
                />
                {formErrors.name ? (
                  <p className="text-xs text-destructive">{formErrors.name}</p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="sub-instructions">
                  Instructions
                </label>
                <Textarea
                  id="sub-instructions"
                  onChange={(e) =>
                    setForm((f) => ({ ...f, instructions: e.target.value }))
                  }
                  placeholder="You are a … agent. Complete the assigned task autonomously. IMPORTANT: When finished, write a clear summary as your final response."
                  rows={6}
                  value={form.instructions}
                />
                {formErrors.instructions ? (
                  <p className="text-xs text-destructive">
                    {formErrors.instructions}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    Include a summarization instruction so the main agent gets
                    a useful result.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <span className="text-sm font-medium">Tool access</span>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(data?.toolRegistry ?? []).map((t) => {
                    const active = form.tools.includes(t.key);
                    return (
                      <button
                        className={`rounded-md border p-2 text-left transition-colors ${
                          active
                            ? "border-primary/50 bg-primary/10"
                            : "hover:bg-muted/60"
                        }`}
                        key={t.key}
                        onClick={() => toggleTool(t.key)}
                        type="button"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium">{t.label}</span>
                          <Badge
                            aria-hidden
                            variant={active ? "default" : "outline"}
                          >
                            {active ? "on" : "off"}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {t.description}
                        </p>
                      </button>
                    );
                  })}
                </div>
                {formErrors.tools ? (
                  <p className="text-xs text-destructive">{formErrors.tools}</p>
                ) : null}
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="sub-model">
                    Model override (optional)
                  </label>
                  <Input
                    id="sub-model"
                    onChange={(e) =>
                      setForm((f) => ({ ...f, model: e.target.value }))
                    }
                    placeholder="Default chat model"
                    value={form.model}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    A qualified ref (providerId::modelId) or bare model id.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="sub-steps">
                    Max steps
                  </label>
                  <Input
                    id="sub-steps"
                    max={50}
                    min={1}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        maxSteps: Number(e.target.value) || 1,
                      }))
                    }
                    type="number"
                    value={form.maxSteps}
                  />
                  {formErrors.maxSteps ? (
                    <p className="text-xs text-destructive">
                      {formErrors.maxSteps}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="sub-desc">
                  Description (optional)
                </label>
                <Input
                  id="sub-desc"
                  onChange={(e) =>
                    setForm((f) => ({ ...f, description: e.target.value }))
                  }
                  placeholder="What this subagent does — shown to the main model"
                  value={form.description}
                />
                {formErrors.description ? (
                  <p className="text-xs text-destructive">
                    {formErrors.description}
                  </p>
                ) : null}
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">Enabled</p>
                  <p className="text-xs text-muted-foreground">
                    Disabled subagents get no delegation tool in chat.
                  </p>
                </div>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(checked) =>
                    setForm((f) => ({ ...f, enabled: checked }))
                  }
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                onClick={() => setDialogOpen(false)}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={saving}
                onClick={() => void handleSave()}
                type="button"
              >
                {saving
                  ? "Saving…"
                  : editingId
                    ? "Save changes"
                    : "Create subagent"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete confirmation */}
        <Dialog
          onOpenChange={(open) => {
            if (!open) setConfirmDelete(null);
          }}
          open={confirmDelete !== null}
        >
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Delete subagent</DialogTitle>
              <DialogDescription>
                Remove “{confirmDelete?.name}”? Its delegation tool disappears
                from the next chat turn.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                onClick={() => setConfirmDelete(null)}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={deletingId !== null}
                onClick={() => {
                  if (confirmDelete) void handleDelete(confirmDelete);
                }}
                type="button"
                variant="destructive"
              >
                {deletingId ? "Deleting…" : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
    </PageView>
  );
}
