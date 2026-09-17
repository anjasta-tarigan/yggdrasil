"use client";

import React, { useEffect, useState } from "react";
import {
  CircleNotch,
  PencilSimple,
  Play,
  Plus,
  Trash,
  WarningCircle,
  Wrench,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import type { HttpMethod } from "@/lib/ai/custom-tools/types";

export interface CustomToolItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schema: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
    [key: string]: unknown;
  };
  execution?: {
    type: "http";
    url: string;
    method: HttpMethod;
    headers?: Record<string, string>;
    timeoutMs?: number;
    hasSecrets?: boolean;
  };
  createdAt?: number;
  updatedAt?: number;
}

interface HeaderEntry {
  key: string;
  value: string;
}

interface CustomToolTestResult {
  ok?: boolean;
  status?: number;
  durationMs?: number;
  data?: unknown;
  error?: string;
}

const DEFAULT_SCHEMA = JSON.stringify(
  {
    type: "object",
    properties: {
      param1: {
        type: "string",
        description: "Example parameter",
      },
    },
    required: [],
  },
  null,
  2
);

// Method badge color helper
function methodBadgeVariant(method: HttpMethod): "default" | "secondary" | "outline" | "destructive" {
  switch (method) {
    case "GET":
      return "secondary";
    case "POST":
      return "default";
    case "DELETE":
      return "destructive";
    default:
      return "outline";
  }
}

export function CustomToolsTab() {
  const [tools, setTools] = useState<CustomToolItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create / Edit modal state
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<CustomToolItem | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formMethod, setFormMethod] = useState<HttpMethod>("GET");
  const [formUrl, setFormUrl] = useState("");
  const [formSchema, setFormSchema] = useState(DEFAULT_SCHEMA);
  const [formHeaders, setFormHeaders] = useState<HeaderEntry[]>([]);
  const [formTimeoutMs, setFormTimeoutMs] = useState(10000);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Test Runner drawer / modal state
  const [isTestOpen, setIsTestOpen] = useState(false);
  const [testingTool, setTestingTool] = useState<CustomToolItem | null>(null);
  const [testParams, setTestParams] = useState<Record<string, string>>({});
  const [isRunningTest, setIsRunningTest] = useState(false);
  const [testResult, setTestResult] = useState<CustomToolTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // Load tools on mount
  useEffect(() => {
    let mounted = true;
    async function loadTools() {
      try {
        setLoading(true);
        const res = await fetch("/api/custom-tools");
        if (!res.ok) {
          if (mounted) {
            setTools([]);
            setError(null);
          }
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (mounted) {
          const raw = Array.isArray(data?.tools) ? data.tools : [];
          setTools(
            raw.filter(
              (t: any) => t && typeof t === "object" && t.id && t.execution
            )
          );
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }
    loadTools();
    return () => {
      mounted = false;
    };
  }, []);

  // Toggle tool enabled state
  async function handleToggle(tool: CustomToolItem) {
    const updatedEnabled = !tool.enabled;
    // Optimistic update
    setTools((prev) =>
      prev.map((t) => (t.id === tool.id ? { ...t, enabled: updatedEnabled } : t))
    );

    try {
      const res = await fetch(`/api/custom-tools/${tool.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...tool,
          enabled: updatedEnabled,
        }),
      });
      if (!res.ok) throw new Error(`Failed to update tool: HTTP ${res.status}`);
    } catch (err) {
      // Rollback on failure
      setTools((prev) =>
        prev.map((t) => (t.id === tool.id ? { ...t, enabled: tool.enabled } : t))
      );
      setError(err instanceof Error ? err.message : "Failed to toggle tool");
    }
  }

  // Delete tool
  async function handleDelete(toolId: string) {
    if (typeof window !== "undefined" && !window.confirm("Are you sure you want to delete this custom tool?")) {
      return;
    }
    try {
      const res = await fetch(`/api/custom-tools/${toolId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Failed to delete tool: HTTP ${res.status}`);
      setTools((prev) => prev.filter((t) => t.id !== toolId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete tool");
    }
  }

  // Open editor for new tool
  function openCreateDialog() {
    setEditingTool(null);
    setFormName("");
    setFormDescription("");
    setFormMethod("GET");
    setFormUrl("");
    setFormSchema(DEFAULT_SCHEMA);
    setFormHeaders([]);
    setFormTimeoutMs(10000);
    setFormError(null);
    setIsEditorOpen(true);
  }

  // Open editor for existing tool
  function openEditDialog(tool: CustomToolItem) {
    setEditingTool(tool);
    setFormName(tool.name);
    setFormDescription(tool.description);
    setFormMethod(tool.execution?.method ?? "GET");
    setFormUrl(tool.execution?.url ?? "");
    setFormSchema(JSON.stringify(tool.schema ?? {}, null, 2));
    const hdrs: HeaderEntry[] = Object.entries(tool.execution?.headers ?? {}).map(
      ([key, value]) => ({ key, value })
    );
    setFormHeaders(hdrs);
    setFormTimeoutMs(tool.execution?.timeoutMs ?? 10000);
    setFormError(null);
    setIsEditorOpen(true);
  }

  // Save tool (create or edit)
  async function handleSaveTool(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    let parsedSchema: Record<string, unknown> = {};
    try {
      parsedSchema = JSON.parse(formSchema);
    } catch {
      setFormError("Schema must be valid JSON");
      return;
    }

    // Convert headers array to object
    const headersObj: Record<string, string> = {};
    for (const { key, value } of formHeaders) {
      const trimmedKey = key.trim();
      if (trimmedKey) {
        headersObj[trimmedKey] = value;
      }
    }

    const payload = {
      name: formName.trim(),
      description: formDescription.trim(),
      schema: parsedSchema,
      execution: {
        type: "http" as const,
        url: formUrl.trim(),
        method: formMethod,
        headers: headersObj,
        timeoutMs: Number(formTimeoutMs) || 10000,
      },
      enabled: editingTool ? editingTool.enabled : true,
    };

    setIsSaving(true);
    try {
      const isEdit = Boolean(editingTool);
      const url = isEdit
        ? `/api/custom-tools/${editingTool!.id}`
        : "/api/custom-tools";
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      if (isEdit) {
        setTools((prev) =>
          prev.map((t) => (t.id === editingTool!.id ? data.tool : t))
        );
      } else {
        setTools((prev) => [...prev, data.tool]);
      }

      setIsEditorOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save tool");
    } finally {
      setIsSaving(false);
    }
  }

  // Open test runner modal
  function openTestDialog(tool: CustomToolItem) {
    setTestingTool(tool);
    // Initial parameter values based on schema properties
    const initialParams: Record<string, string> = {};
    const props = tool.schema?.properties ?? {};
    for (const key of Object.keys(props)) {
      initialParams[key] = "";
    }
    setTestParams(initialParams);
    setTestResult(null);
    setTestError(null);
    setIsTestOpen(true);
  }

  // Execute test request
  async function handleRunTest() {
    if (!testingTool) return;
    setIsRunningTest(true);
    setTestResult(null);
    setTestError(null);

    try {
      // Build test payload matching the parameter types if possible
      const payload: Record<string, unknown> = {};
      const props = testingTool.schema?.properties ?? {};
      for (const [key, value] of Object.entries(testParams)) {
        if (value === "") continue;
        const propDef = props[key];
        if (propDef?.type === "number" || propDef?.type === "integer") {
          const num = Number(value);
          payload[key] = isNaN(num) ? value : num;
        } else if (propDef?.type === "boolean") {
          payload[key] = value === "true";
        } else {
          payload[key] = value;
        }
      }

      const res = await fetch(`/api/custom-tools/${testingTool.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        setTestError(data.error || `Error: HTTP ${res.status}`);
      }
      setTestResult(data);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "Test execution failed");
    } finally {
      setIsRunningTest(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Wrench className="size-4" />
              Custom Tools{" "}
              {tools.length > 0 && (
                <span className="font-normal text-muted-foreground text-sm">
                  ({tools.length})
                </span>
              )}
            </CardTitle>
            <CardDescription>
              Define and test user-configured HTTP tools available to assistant models.
            </CardDescription>
          </div>
          <Button onClick={openCreateDialog} size="sm" className="gap-1.5">
            <Plus className="size-3.5" />
            New Tool
          </Button>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          {error && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              <WarningCircle className="size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-xs gap-2">
              <CircleNotch className="size-4 animate-spin" />
              Loading custom tools…
            </div>
          ) : tools.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center">
              <p className="font-medium text-sm">No custom tools configured</p>
              <p className="text-muted-foreground text-xs">
                Create custom tools to connect your assistant to REST APIs and webhook integrations.
              </p>
            </div>
          ) : (
            <div className="divide-y rounded-lg border">
              {tools.map((tool) => (
                <div
                  key={tool.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex flex-col gap-1 min-w-0 pr-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm font-mono">{tool.name}</span>
                      <Badge variant={methodBadgeVariant(tool.execution?.method ?? "GET")}>
                        {tool.execution?.method ?? "GET"}
                      </Badge>
                      {tool.execution?.hasSecrets && (
                        <Badge variant="outline" className="text-[10px]">
                          Secrets Redacted
                        </Badge>
                      )}
                    </div>
                    {tool.description && (
                      <p className="text-xs text-muted-foreground line-clamp-1">
                        {tool.description}
                      </p>
                    )}
                    <span className="font-mono text-[11px] text-muted-foreground/80 truncate max-w-md">
                      {tool.execution?.url ?? ""}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                    <Switch
                      checked={tool.enabled}
                      onCheckedChange={() => handleToggle(tool)}
                      aria-label={`Toggle ${tool.name}`}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openTestDialog(tool)}
                      className="gap-1 text-xs h-8"
                    >
                      <Play className="size-3" />
                      Test
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEditDialog(tool)}
                      className="gap-1 text-xs h-8"
                    >
                      <PencilSimple className="size-3" />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleDelete(tool.id)}
                      className="text-destructive hover:text-destructive h-8 w-8"
                      aria-label={`Delete ${tool.name}`}
                    >
                      <Trash className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Create / Edit Tool Dialog ── */}
      <Dialog open={isEditorOpen} onOpenChange={setIsEditorOpen}>
        <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingTool ? `Edit Custom Tool: ${editingTool.name}` : "Create Custom Tool"}
            </DialogTitle>
            <DialogDescription>
              Configure HTTP endpoint, parameters schema, and request headers for the tool.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSaveTool} className="space-y-4 py-2">
            {formError && (
              <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
                <WarningCircle className="size-4 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <Field>
              <FieldLabel htmlFor="tool-name">Name</FieldLabel>
              <Input
                id="tool-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. weather_lookup"
                pattern="^[a-zA-Z0-9_-]{1,64}$"
                required
              />
              <FieldDescription>
                Alphanumeric characters, underscores, and dashes only (max 64 chars).
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="tool-description">Description</FieldLabel>
              <Textarea
                id="tool-description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Describe what this tool does and when the model should invoke it..."
                rows={2}
                required
              />
              <FieldDescription>
                Clear instructions help the assistant select and call this tool accurately.
              </FieldDescription>
            </Field>

            <div className="grid grid-cols-3 gap-3">
              <Field className="col-span-1">
                <FieldLabel htmlFor="tool-method">Method</FieldLabel>
                <select
                  id="tool-method"
                  aria-label="Method"
                  value={formMethod}
                  onChange={(e) => setFormMethod(e.target.value as HttpMethod)}
                  className="flex h-8 w-full rounded-md border border-input bg-transparent px-2.5 py-1 text-xs shadow-xs transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="PATCH">PATCH</option>
                  <option value="DELETE">DELETE</option>
                </select>
              </Field>

              <Field className="col-span-2">
                <FieldLabel htmlFor="tool-timeout">Timeout (ms)</FieldLabel>
                <Input
                  id="tool-timeout"
                  type="number"
                  min={1000}
                  max={60000}
                  value={formTimeoutMs}
                  onChange={(e) => setFormTimeoutMs(Number(e.target.value))}
                />
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="tool-url">URL</FieldLabel>
              <Input
                id="tool-url"
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder="https://api.example.com/v1/data?param={param}"
                required
              />
              <FieldDescription>
                Full target URL. Use {"{paramName}"} for template parameter substitution matching schema keys.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="tool-schema">JSON Schema (Parameters)</FieldLabel>
              <Textarea
                id="tool-schema"
                value={formSchema}
                onChange={(e) => setFormSchema(e.target.value)}
                rows={6}
                className="font-mono text-xs"
                placeholder='{ "type": "object", "properties": { ... } }'
                required
              />
              <FieldDescription>
                Standard JSON Schema defining tool inputs and documentation passed to the LLM.
              </FieldDescription>
            </Field>

            {/* Headers Key-Value Editor */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <FieldLabel>Headers</FieldLabel>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={() => setFormHeaders([...formHeaders, { key: "", value: "" }])}
                >
                  <Plus className="size-3" />
                  Add Header
                </Button>
              </div>

              {formHeaders.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No custom headers configured.</p>
              ) : (
                <div className="space-y-2">
                  {formHeaders.map((header, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input
                        placeholder="Header name (e.g. Authorization)"
                        value={header.key}
                        onChange={(e) => {
                          const updated = [...formHeaders];
                          updated[idx].key = e.target.value;
                          setFormHeaders(updated);
                        }}
                        className="h-8 text-xs font-mono"
                      />
                      <Input
                        placeholder="Value (e.g. Bearer token)"
                        type="password"
                        value={header.value}
                        onChange={(e) => {
                          const updated = [...formHeaders];
                          updated[idx].value = e.target.value;
                          setFormHeaders(updated);
                        }}
                        className="h-8 text-xs font-mono"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="h-8 w-8 text-destructive shrink-0"
                        onClick={() => {
                          setFormHeaders(formHeaders.filter((_, i) => i !== idx));
                        }}
                        aria-label="Remove header"
                      >
                        <Trash className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsEditorOpen(false)}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving} className="gap-1.5">
                {isSaving && <CircleNotch className="size-3.5 animate-spin" />}
                Save Tool
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Test Runner Drawer / Modal ── */}
      <Dialog open={isTestOpen} onOpenChange={setIsTestOpen}>
        <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Test Custom Tool: {testingTool?.name}</DialogTitle>
            <DialogDescription>
              Execute a test request against the target endpoint with real parameter values.
            </DialogDescription>
          </DialogHeader>

          {/* Prominent warning banner as specified */}
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-600 dark:text-amber-400 text-xs font-semibold flex items-center gap-2">
            <WarningCircle className="size-4 shrink-0" />
            <span>This fires a real network request to the target endpoint</span>
          </div>

          <div className="space-y-4 py-2">
            {/* Auto-generated parameter inputs from schema */}
            <div className="space-y-3">
              <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Parameters
              </h4>

              {testingTool &&
              testingTool.schema?.properties &&
              Object.keys(testingTool.schema.properties).length > 0 ? (
                Object.entries(testingTool.schema.properties).map(([key, propDef]) => {
                  const isRequired = testingTool.schema.required?.includes(key);
                  return (
                    <Field key={key}>
                      <FieldLabel htmlFor={`test-param-${key}`}>
                        {key} {isRequired && <span className="text-destructive">*</span>}
                      </FieldLabel>
                      <Input
                        id={`test-param-${key}`}
                        aria-label={key}
                        value={testParams[key] ?? ""}
                        onChange={(e) =>
                          setTestParams((prev) => ({
                            ...prev,
                            [key]: e.target.value,
                          }))
                        }
                        placeholder={propDef.description ?? `Enter value for ${key}`}
                      />
                      {propDef.description && (
                        <FieldDescription>{propDef.description}</FieldDescription>
                      )}
                    </Field>
                  );
                })
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  No input parameters defined in schema.
                </p>
              )}
            </div>

            <Button
              type="button"
              onClick={handleRunTest}
              disabled={isRunningTest}
              className="w-full gap-2"
            >
              {isRunningTest ? (
                <>
                  <CircleNotch className="size-4 animate-spin" />
                  Running Test…
                </>
              ) : (
                <>
                  <Play className="size-4" />
                  Run Test
                </>
              )}
            </Button>

            {/* Test Result Display */}
            {testError && (
              <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
                <WarningCircle className="size-4 shrink-0" />
                <span>{testError}</span>
              </div>
            )}

            {testResult && (
              <div className="space-y-2 rounded-lg border p-3 bg-muted/20">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Result</span>
                  <div className="flex items-center gap-2">
                    {testResult.status != null && (
                      <Badge
                        variant={
                          testResult.status >= 200 && testResult.status < 300
                            ? "secondary"
                            : "destructive"
                        }
                      >
                        Status: {testResult.status}
                      </Badge>
                    )}
                    {testResult.durationMs != null && (
                      <span className="text-[11px] text-muted-foreground font-mono">
                        {testResult.durationMs}ms
                      </span>
                    )}
                  </div>
                </div>

                <pre className="mt-2 max-h-60 overflow-auto rounded bg-muted/60 p-2.5 font-mono text-xs">
                  {JSON.stringify(
                    testResult.data ?? testResult,
                    null,
                    2
                  )}
                </pre>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ponytail: advanced visual JSON schema builder → skipped: raw JSON schema textarea is faster and supports all JSON schema keywords, add visual builder when non-technical users need schema creation.
// ponytail: execution timeout pass-through in test drawer → skipped: relies on executor default timeout, add when test runner UI supports custom test timeouts.
