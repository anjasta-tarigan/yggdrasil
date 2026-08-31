"use client";

import {
  Check,
  Lock,
  MagnifyingGlass,
  SlidersHorizontal,
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  WEB_SEARCH_LABELS,
  WEB_SEARCH_PROVIDER_META,
} from "@/components/settings/shared";
import type { WebSearchProviderKind } from "@/lib/settings";
import { useMemo, useState } from "react";

/**
 * Tools tab — chat tool toggles. The web_search tool carries its own
 * provider configuration in a dialog opened from its row; the provider
 * setup (keys, URLs, fallback chain) is not a separate card.
 *
 * Row layout follows the app-wide list contract: content on the left,
 * status + controls on the right. Status uses the dot language
 * (emerald = ready, amber = cooling down, muted = not configured).
 */

export type ToolsTabProps = {
  tools: Array<{
    name: string;
    description: string;
    configured: boolean;
    requires: string | null;
    /** Current toggle state from the server (false = user disabled it). */
    enabled: boolean;
    /** False for protected tools the UI renders locked. */
    disableable: boolean;
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
  /** Optimistically flip one tool's enabled flag in local state. */
  toggleTool: (name: string, enabled: boolean) => void;
  /** Persist the current disabled set; resolves on success/failure. */
  saveToolToggles: () => Promise<void>;
  toolsSaved: boolean;
  toolsSaveError: string | null;
};

/** Status dot colors for a web search provider row. */
function wsDotClass(ready: boolean, coolingDown: boolean): string {
  if (coolingDown) return "bg-amber-500";
  if (ready) return "bg-emerald-500";
  return "bg-muted-foreground/40";
}

/** Props for the shared provider configuration body. */
type WsConfigProps = Pick<
  ToolsTabProps,
  | "webSearch"
  | "wsForm"
  | "updateWsForm"
  | "wsSaved"
  | "wsSaveError"
  | "saveWebSearch"
>;

/**
 * Web search provider configuration — provider rows with dots, badges,
 * key/URL inputs and the numbered fallback chain. Rendered inside the
 * web_search tool's Configure dialog.
 */
function WebSearchConfigBody({
  webSearch,
  wsForm,
  updateWsForm,
  wsSaved,
  wsSaveError,
  saveWebSearch,
}: WsConfigProps) {
  return (
    <div className="flex flex-col gap-3">
      <ul className="space-y-2">
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
            <li className="flex flex-col gap-3 rounded-lg border p-3" key={meta.kind}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`inline-block size-2 shrink-0 rounded-full ${wsDotClass(status?.ready ?? false, status?.coolingDown ?? false)}`}
                  />
                  <FieldLabel className="cursor-pointer" htmlFor={`ws-${meta.kind}`}>
                    {meta.label}
                  </FieldLabel>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                  <Switch
                    checked={form.enabled}
                    id={`ws-${meta.kind}`}
                    onCheckedChange={(checked) =>
                      updateWsForm(meta.kind, { enabled: checked })
                    }
                  />
                </div>
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
            </li>
          );
        })}
      </ul>

      {webSearch && (
        <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
          Fallback order:
          {webSearch.chain.length > 0 ? (
            webSearch.chain.map((kind, i) => (
              <span className="flex items-center gap-1.5" key={kind}>
                {i > 0 && <span aria-hidden="true">→</span>}
                <Badge variant="outline">
                  {i + 1} {WEB_SEARCH_LABELS[kind]}
                </Badge>
              </span>
            ))
          ) : (
            <span>no provider ready</span>
          )}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={() => void saveWebSearch()} type="button">
          {wsSaved ? <Check className="size-4" /> : null}
          {wsSaved ? "Saved" : "Save web search settings"}
        </Button>
        {wsSaveError ? (
          <p className="text-destructive text-xs">{wsSaveError}</p>
        ) : null}
      </div>
    </div>
  );
}

export function ToolsTab({
  tools,
  webSearch,
  wsForm,
  updateWsForm,
  wsSaved,
  wsSaveError,
  saveWebSearch,
  toggleTool,
  saveToolToggles,
  toolsSaved,
  toolsSaveError,
}: ToolsTabProps) {
  const [filter, setFilter] = useState("");
  const [wsDialogOpen, setWsDialogOpen] = useState(false);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q || !tools) return tools ?? [];
    return tools.filter((tool) =>
      `${tool.name} ${tool.description}`.toLowerCase().includes(q)
    );
  }, [filter, tools]);

  const enabledCount = useMemo(
    () => (tools ?? []).filter((t) => t.enabled).length,
    [tools]
  );
  const protectedCount = useMemo(
    () => (tools ?? []).filter((t) => !t.disableable).length,
    [tools]
  );

  return (
    <>
      {/* ── Chat tools ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="size-4" />
            Chat tools{" "}
            {tools && (
              <span className="font-normal text-muted-foreground">
                ({tools.length})
              </span>
            )}
          </CardTitle>
          <CardDescription>
            {tools
              ? `${enabledCount} enabled · ${protectedCount} protected. Toggle each tool the assistant may call; disabled tools are hidden from the model.`
              : "Toggle each tool the assistant may call."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {tools && tools.length > 0 && (
            <div className="relative w-full sm:w-64">
              <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Filter tools"
                className="pl-8"
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter tools…"
                value={filter}
              />
            </div>
          )}

          {tools === null && (
            <div className="space-y-2" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div className="rounded-lg border p-3" key={i}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1.5">
                      <div className="h-4 w-32 rounded-sm bg-muted" />
                      <div className="h-3 w-52 rounded-sm bg-muted/80" />
                    </div>
                    <div className="h-5 w-14 rounded-sm bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {tools !== null && visible.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center">
              <p className="font-medium text-sm">No tools match</p>
              <p className="text-muted-foreground text-xs">
                Nothing matches “{filter.trim()}”.
              </p>
            </div>
          )}

          {visible.length > 0 && (
            <ul className="space-y-2">
              {visible.map((tool) => (
                <li
                  className={
                    tool.enabled
                      ? "flex items-center justify-between gap-3 rounded-lg border p-3"
                      : "flex items-center justify-between gap-3 rounded-lg border border-dashed bg-muted/20 p-3 opacity-75"
                  }
                  key={tool.name}
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 font-medium text-sm">
                      <span className="truncate">{tool.name}</span>
                      {tool.requires && (
                        <span className="text-muted-foreground text-xs">
                          requires {tool.requires}
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
                      {tool.description}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={tool.configured ? "secondary" : "outline"}>
                      {tool.configured ? "Ready" : "Missing key"}
                    </Badge>
                    {tool.name === "web_search" && (
                      <Button
                        aria-label="Configure web search providers"
                        onClick={() => setWsDialogOpen(true)}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <SlidersHorizontal className="size-4" />
                      </Button>
                    )}
                    {tool.disableable ? (
                      <Switch
                        aria-label={`Toggle tool ${tool.name}`}
                        checked={tool.enabled}
                        id={`tool-${tool.name}`}
                        onCheckedChange={(checked) =>
                          toggleTool(tool.name, checked)
                        }
                      />
                    ) : (
                      <span
                        className="flex size-7 items-center justify-center text-muted-foreground/70"
                        title="Protected tool — always on"
                      >
                        <Lock className="size-4" />
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-3 pt-1">
            <Button onClick={() => void saveToolToggles()} size="sm" type="button">
              {toolsSaved ? <Check className="size-4" /> : null}
              {toolsSaved ? "Saved" : "Save tool settings"}
            </Button>
            {toolsSaveError ? (
              <p className="text-destructive text-xs">{toolsSaveError}</p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* ── Web search provider configuration dialog ──────────── */}
      <Dialog onOpenChange={setWsDialogOpen} open={wsDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Web search providers</DialogTitle>
            <DialogDescription>
              The web_search tool tries enabled providers in priority order and
              automatically falls back when one fails or returns nothing. A
              provider that hits a quota or auth error is put on a 15-minute
              cooldown so an exhausted key is not hammered on every search.
            </DialogDescription>
          </DialogHeader>
          <WebSearchConfigBody
            saveWebSearch={saveWebSearch}
            updateWsForm={updateWsForm}
            webSearch={webSearch}
            wsForm={wsForm}
            wsSaveError={wsSaveError}
            wsSaved={wsSaved}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
