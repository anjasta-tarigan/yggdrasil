"use client";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageView } from "@/components/app-shell/page-view";
import {
  addMcpServer,
  createMcpServerId,
  getMcpServers,
  removeMcpServer,
  saveMcpServers,
  type McpServerConfig,
  type McpTransportKind,
} from "@/lib/settings";
import { slugifyServerName } from "@/lib/ai/mcp/config";
import { writeMcpSecret } from "@/lib/ai/mcp/secrets";
import {
  ArrowClockwise,
  CircleNotch,
  SealCheck,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

/**
 * Dedicated MCP (Model Context Protocol) page, rendered inside the app
 * shell's content area when the sidebar's System → MCP Servers entry is
 * selected (same layout contract as SettingsView: sidebar, header and
 * status footer stay in place).
 *
 * Configured servers are connected by the chat route on every request;
 * their tools are exposed to the model prefixed with the server name.
 * Tool definitions are fingerprinted on first connection (trust on first
 * use) — later changes or new tools are withheld until re-approved here.
 */

type McpStatusEntry = {
  ok: boolean;
  error?: string;
  toolCount?: number;
  serverName?: string;
  protocolVersion?: string;
  drift?: { changed: string[]; added: string[] };
  withheld?: Array<{ tool: string; reason: string }>;
  /** Built-in-name duplicates the user released; now exposed. */
  exposedDuplicates?: string[];
  lastAttemptAt?: string;
};

type McpSnapshot = {
  servers: McpServerConfig[];
  status: Record<string, McpStatusEntry>;
  baselines: Record<string, { updatedAt: string; toolCount: number }>;
};

type McpTestResult = {
  ok: boolean;
  error?: string;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  instructions?: string;
  tools?: Array<{ name: string; description?: string }>;
};

type KeyValueRow = { key: string; value: string };

/** Marketplace response items (preset + community). */
type MarketplaceItem = {
  id: string;
  name: string;
  description: string;
  category: string;
  transport: string;
  command?: string;
  args?: string[];
  envVars?: Array<{ name: string; description: string; required: boolean }>;
  isCommunity: boolean;
};

type MarketplaceResponse = {
  presets: MarketplaceItem[];
  community: MarketplaceItem[];
  hasCommunity: boolean;
};

/** Category filter pills shown in the Marketplace tab. */
const MARKETPLACE_CATEGORIES = [
  { key: "", label: "All" },
  { key: "database", label: "Databases" },
  { key: "development", label: "Development" },
  { key: "web", label: "Web" },
  { key: "productivity", label: "Productivity" },
  { key: "system", label: "System" },
] as const;

/** Tool-name prefix for a server (matches the manager's slugging). */
const slugPrefix = (name: string) => slugifyServerName(name);

const TRANSPORT_LABELS: Record<McpTransportKind, string> = {
  http: "HTTP",
  sse: "SSE",
  stdio: "stdio",
};

function describeTarget(server: McpServerConfig): string {
  if (server.transport === "stdio") {
    return [server.command, ...(server.args ?? [])].join(" ");
  }
  return server.url ?? "";
}

function rowsToRecord(rows: KeyValueRow[]): Record<string, string> | undefined {
  const record: Record<string, string> = {};
  let count = 0;
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    record[key] = row.value;
    count += 1;
  }
  return count > 0 ? record : undefined;
}

/**
 * Build an McpServerConfig from a marketplace preset and any env vars
 * entered by the user. Sensitive env vars are written to the secret store
 * separately (writeMcpSecret) so they are not stored in the settings JSON.
 */
async function persistPresetInstall(
  preset: MarketplaceItem,
  envValues: Record<string, string>
): Promise<McpServerConfig> {
  const config: McpServerConfig = {
    enabled: true,
    id: createMcpServerId(),
    name: preset.name,
    transport: preset.transport as McpTransportKind,
  };

  if (preset.transport === "http" || preset.transport === "sse") {
    config.url = preset.command ?? "";
  } else {
    config.command = preset.command ?? "";
    if (preset.args && preset.args.length > 0) config.args = preset.args;
  }

  // Separate sensitive env vars (write to secret store) from non-sensitive
  // ones (keep in the config).
  const SENSITIVE_RE = /TOKEN|KEY|SECRET|PASSWORD/i;
  const inlineEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(envValues)) {
    if (SENSITIVE_RE.test(key)) {
      await writeMcpSecret(key, value);
    } else {
      inlineEnv[key] = value;
    }
  }
  if (config.transport === "stdio" && Object.keys(inlineEnv).length > 0) {
    config.env = inlineEnv;
  }

  await addMcpServer(config);
  return config;
}

/** McpView renders the two-tab MCP management surface. */
export function McpView({ onBack }: { onBack: () => void }) {
  const [servers, setServers] = useState<McpServerConfig[]>(() =>
    getMcpServers()
  );
  const [snapshot, setSnapshot] = useState<McpSnapshot | null>(null);
  const [loadError, setLoadError] = useState(false);

  // Add-server form state.
  const [formOpen, setFormOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formTransport, setFormTransport] =
    useState<McpTransportKind>("http");
  const [formUrl, setFormUrl] = useState("");
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [formHeaders, setFormHeaders] = useState<KeyValueRow[]>([]);
  const [formEnv, setFormEnv] = useState<KeyValueRow[]>([]);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Per-server action state.
  const [testingId, setTestingId] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, McpTestResult>
  >({});

  // Marketplace tab state.
  const [activeTab, setActiveTab] = useState<"configured" | "marketplace">(
    "configured"
  );
  const [marketplaceItems, setMarketplaceItems] = useState<MarketplaceItem[]>(
    []
  );
  const [marketplaceLoading, setMarketplaceLoading] = useState(false);
  const [marketplaceError, setMarketplaceError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("");

  // Install dialog state.
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [installPreset, setInstallPreset] =
    useState<MarketplaceItem | null>(null);
  const [installEnvValues, setInstallEnvValues] = useState<
    Record<string, string>
  >({});
  const [installBusy, setInstallBusy] = useState(false);

  const refreshSnapshot = useCallback(() => {
    fetch("/api/mcp", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<McpSnapshot>;
      })
      .then((data) => {
        setSnapshot(data);
        if (Array.isArray(data.servers)) setServers(data.servers);
      })
      .catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  const loadMarketplace = useCallback(
    async (signal?: AbortSignal) => {
      setMarketplaceLoading(true);
      setMarketplaceError(null);
      try {
        const params = new URLSearchParams();
        if (searchQuery.trim()) params.set("q", searchQuery.trim());
        if (activeCategory) params.set("category", activeCategory);
        params.set("includeCommunity", "1");

        const res = await fetch(
          `/api/mcp/marketplace?${params.toString()}`,
          { signal, cache: "no-store" }
        );
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as MarketplaceResponse;
        setMarketplaceItems(data.presets ?? []);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        console.warn("[mcp-view] marketplace fetch failed", err);
        setMarketplaceError(
          "Could not load the marketplace. Try again later."
        );
      } finally {
        setMarketplaceLoading(false);
      }
    },
    [searchQuery, activeCategory]
  );

  // Marketplace catalog fetch (legitimate external sync, not derived state).
  useEffect(() => {
    if (activeTab === "marketplace") {
      const controller = new AbortController();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadMarketplace(controller.signal);
      return () => controller.abort();
    }
  }, [activeTab, loadMarketplace]);

  const toggleEnabled = async (server: McpServerConfig, enabled: boolean) => {
    const next = servers.map((s) =>
      s.id === server.id ? { ...s, enabled } : s
    );
    setServers(next);
    try {
      await saveMcpServers(next);
    } catch {
      setServers(getMcpServers());
    }
  };

  const deleteServer = async (id: string) => {
    setServers(servers.filter((s) => s.id !== id));
    try {
      await removeMcpServer(id);
    } catch {
      setServers(getMcpServers());
    }
  };

  // Release one withheld tool from the built-in precedence policy: the
  // user explicitly wants this server's namespaced duplicate exposed to
  // the model. Applies on the next collection pass (chat request or test).
  const exposeDuplicate = async (serverId: string, toolName: string) => {
    const next = servers.map((s) =>
      s.id === serverId
        ? {
            ...s,
            allowDuplicates: Array.from(
              new Set([...(s.allowDuplicates ?? []), toolName])
            ),
          }
        : s
    );
    setServers(next);
    try {
      await saveMcpServers(next);
    } catch {
      setServers(getMcpServers());
    }
  };

  // Undo a release: the duplicate is withheld again on the next pass.
  const unexposeDuplicate = async (serverId: string, toolName: string) => {
    const next = servers.map((s) =>
      s.id === serverId
        ? {
            ...s,
            allowDuplicates: (s.allowDuplicates ?? []).filter(
              (t) => t !== toolName
            ),
          }
        : s
    );
    setServers(next);
    try {
      await saveMcpServers(next);
    } catch {
      setServers(getMcpServers());
    }
  };

  const testServer = async (id: string) => {
    setTestingId(id);
    try {
      const res = await fetch("/api/mcp/test", {
        body: JSON.stringify({ id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await res.json()) as McpTestResult;
      setTestResults((previous) => ({ ...previous, [id]: data }));
    } catch {
      setTestResults((previous) => ({
        ...previous,
        [id]: { ok: false, error: "Test request failed" },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const approveServer = async (id: string) => {
    setApprovingId(id);
    try {
      const res = await fetch("/api/mcp/approve", {
        body: JSON.stringify({ id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        setTestResults((previous) => ({
          ...previous,
          [id]: { ok: false, error: data.error ?? "Re-approval failed" },
        }));
      }
      refreshSnapshot();
    } catch {
      setTestResults((previous) => ({
        ...previous,
        [id]: { ok: false, error: "Re-approval request failed" },
      }));
    } finally {
      setApprovingId(null);
    }
  };

  const resetForm = () => {
    setFormName("");
    setFormTransport("http");
    setFormUrl("");
    setFormCommand("");
    setFormArgs("");
    setFormHeaders([]);
    setFormEnv([]);
    setFormError(null);
  };

  const submitAddServer = async () => {
    const name = formName.trim();
    if (!name) {
      setFormError("Give the server a name.");
      return;
    }

    const config: McpServerConfig = {
      enabled: true,
      id: createMcpServerId(),
      name,
      transport: formTransport,
    };

    if (formTransport === "stdio") {
      const command = formCommand.trim();
      if (!command) {
        setFormError("The stdio transport needs a command to run.");
        return;
      }
      config.command = command;
      const args = formArgs
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (args.length > 0) config.args = args;
      const env = rowsToRecord(formEnv);
      if (env) config.env = env;
    } else {
      const url = formUrl.trim();
      if (!/^https?:\/\//.test(url)) {
        setFormError("Enter an http(s) URL for the server endpoint.");
        return;
      }
      config.url = url;
      const headers = rowsToRecord(formHeaders);
      if (headers) config.headers = headers;
    }

    setFormBusy(true);
    setFormError(null);
    try {
      await addMcpServer(config);
      setServers(getMcpServers());
      setFormOpen(false);
      resetForm();
      refreshSnapshot();
      // Probe the new server right away so its status shows up.
      void testServer(config.id);
    } catch {
      setFormError("Could not save the server. Check the fields and retry.");
    } finally {
      setFormBusy(false);
    }
  };

  /** Install flow: open the env-var dialog when required vars exist,
      otherwise persist immediately and probe the new server. */
  const openInstallDialog = (preset: MarketplaceItem) => {
    if (!preset.envVars || preset.envVars.length === 0) {
      void installPresetDirect(preset);
      return;
    }
    setInstallPreset(preset);
    const initial: Record<string, string> = {};
    for (const ev of preset.envVars ?? []) {
      initial[ev.name] = "";
    }
    setInstallEnvValues(initial);
    setInstallDialogOpen(true);
  };

  /** Persist a preset with no env vars and probe it right away. */
  const installPresetDirect = async (preset: MarketplaceItem) => {
    setInstallBusy(true);
    try {
      const config = await persistPresetInstall(preset, {});
      setServers(getMcpServers());
      setActiveTab("configured");
      refreshSnapshot();
      void testServer(config.id);
    } catch (err) {
      console.warn("[mcp-view] preset install failed", err);
    } finally {
      setInstallBusy(false);
    }
  };

  /** Persist a preset install (env vars via secret store) and probe the server. */
  const confirmInstall = async () => {
    if (!installPreset) return;

    // Validate required env vars.
    for (const ev of installPreset.envVars ?? []) {
      if (ev.required && !installEnvValues[ev.name]?.trim()) {
        setFormError(`The ${ev.name} environment variable is required.`);
        return;
      }
    }

    setInstallBusy(true);
    setFormError(null);
    try {
      const config = await persistPresetInstall(
        installPreset,
        installEnvValues
      );
      setServers(getMcpServers());
      setInstallDialogOpen(false);
      setInstallPreset(null);
      setInstallEnvValues({});
      setActiveTab("configured");
      refreshSnapshot();
      // Probe the new server so its status shows up immediately.
      void testServer(config.id);
    } catch (err) {
      console.warn("[mcp-view] preset install failed", err);
      setFormError(
        err instanceof Error
          ? err.message
          : "Could not install the server. Check the fields and retry."
      );
    } finally {
      setInstallBusy(false);
    }
  };

  /** Set/unset primary capability tools (web_search / web_fetch) on a server. */
  const setServerPrimaryCapabilities = async (
    server: McpServerConfig,
    capabilities: ("web_search" | "web_fetch")[]
  ) => {
    const updated = servers.map((s) =>
      s.id === server.id
        ? { ...s, primaryCapabilities: capabilities.length > 0 ? capabilities : undefined }
        : s
    );
    setServers(updated);
    try {
      await saveMcpServers(updated);
      refreshSnapshot();
    } catch {
      setServers(getMcpServers());
    }
  };

  const renderKeyValueEditor = (
    rows: KeyValueRow[],
    setRows: (rows: KeyValueRow[]) => void,
    keyPlaceholder: string,
    valuePlaceholder: string
  ) => (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div className="flex items-center gap-2" key={index}>
          <Input
            onChange={(e) => {
              const next = [...rows];
              next[index] = { ...row, key: e.target.value };
              setRows(next);
            }}
            placeholder={keyPlaceholder}
            value={row.key}
          />
          <Input
            onChange={(e) => {
              const next = [...rows];
              next[index] = { ...row, value: e.target.value };
              setRows(next);
            }}
            placeholder={valuePlaceholder}
            value={row.value}
          />
          <Button
            onClick={() => setRows(rows.filter((_, i) => i !== index))}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        onClick={() => setRows([...rows, { key: "", value: "" }])}
        type="button"
        variant="outline"
      >
        Add entry
      </Button>
    </div>
  );

  const renderConfiguredTab = () => (
    <>
      {loadError && (
        <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
          Could not load MCP status from the server.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Configured servers</CardTitle>
          <CardDescription>
            Every enabled server contributes its tools to the next chat
            turn. Use Test connection to inspect a server without
            affecting the baseline.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {servers.length === 0 && !formOpen && (
            <p className="text-muted-foreground text-sm">
              No MCP servers configured yet.
            </p>
          )}

          {servers.map((server) => {
            const status = snapshot?.status?.[server.id];
            const baseline = snapshot?.baselines?.[server.id];
            const driftCount =
              (status?.drift?.changed.length ?? 0) +
              (status?.drift?.added.length ?? 0);
            const testResult = testResults[server.id];

            const badge = !server.enabled
              ? { label: "Disabled", variant: "outline" as const }
              : status?.drift && driftCount > 0
                ? { label: "Drift detected", variant: "destructive" as const }
                : status?.ok
                  ? {
                      label: `${status.toolCount ?? 0} tool${
                        status.toolCount === 1 ? "" : "s"
                      } active${
                        status.withheld && status.withheld.length > 0
                          ? `, ${status.withheld.length} withheld`
                          : ""
                      }`,
                      variant: "secondary" as const,
                    }
                  : status && !status.ok
                    ? { label: "Unreachable", variant: "outline" as const }
                    : {
                        label: "Not connected yet",
                        variant: "outline" as const,
                      };

            return (
              <div className="rounded-lg border p-3" key={server.id}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Switch
                      checked={server.enabled}
                      id={`mcp-${server.id}`}
                      onCheckedChange={(checked) =>
                        void toggleEnabled(server, checked)
                      }
                    />
                    <div className="min-w-0">
                      <label
                        className="cursor-pointer font-medium text-sm"
                        htmlFor={`mcp-${server.id}`}
                      >
                        {server.name}
                      </label>
                      <p
                        className="truncate text-muted-foreground text-xs"
                        title={describeTarget(server)}
                      >
                        {describeTarget(server)}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline">
                      {TRANSPORT_LABELS[server.transport]}
                    </Badge>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </div>
                </div>

                {status?.error && server.enabled && (
                  <p className="mt-2 text-destructive text-xs">
                    {status.error}
                  </p>
                )}

                {status?.drift && driftCount > 0 && (
                  <div className="mt-2 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
                    <p className="flex items-center gap-1.5 text-xs">
                      <Warning className="size-3.5 text-destructive" />
                      <span>
                        {status.drift.changed.length > 0 &&
                          `${status.drift.changed.length} tool definition(s) changed`}
                        {status.drift.changed.length > 0 &&
                          status.drift.added.length > 0 &&
                          "; "}
                        {status.drift.added.length > 0 &&
                          `${status.drift.added.length} new tool(s) appeared`}
                        . These tools are hidden from the model until you
                        re-approve the server&apos;s current definitions.
                      </span>
                    </p>
                    <Button
                      disabled={approvingId === server.id}
                      onClick={() => void approveServer(server.id)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {approvingId === server.id ? (
                        <CircleNotch className="size-3.5 animate-spin" />
                      ) : (
                        <SealCheck className="size-3.5" />
                      )}
                      Review &amp; approve current tools
                    </Button>
                  </div>
                )}

                {status?.withheld && status.withheld.length > 0 && (
                  <div className="mt-2 space-y-1 rounded-md border border-border bg-muted/40 p-2">
                    <p className="flex items-center gap-1.5 text-xs">
                      <Warning className="size-3.5 text-muted-foreground" />
                      <span>
                        {status.withheld.length} tool
                        {status.withheld.length === 1 ? "" : "s"} withheld —
                        name
                        {status.withheld.length === 1 ? "" : "s"} duplicate
                        {status.withheld.length === 1 ? "" : "s"} a local
                        tool, which takes precedence.
                      </span>
                    </p>
                    <ul className="space-y-0.5 pl-5 text-muted-foreground text-xs">
                      {status.withheld.map((w) => {
                        // Only built-in collisions are user-releasable;
                        // sandbox and delegation conflicts never are.
                        const releasable = w.reason.includes("built-in");
                        return (
                          <li className="flex items-center justify-between gap-2" key={w.tool}>
                            <span className="min-w-0">
                              <code>{w.tool}</code>
                              {" "}— {w.reason}
                            </span>
                            {releasable && (
                              <Button
                                onClick={() =>
                                  void exposeDuplicate(server.id, w.tool)
                                }
                                size="sm"
                                type="button"
                                variant="outline"
                              >
                                Expose anyway
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {status?.exposedDuplicates &&
                  status.exposedDuplicates.length > 0 && (
                    <div className="mt-2 space-y-1 rounded-md border border-success/30 bg-success/10 p-2">
                        <p className="flex items-center gap-1.5 text-xs">
                          <SealCheck className="size-3.5 text-success" />
                          <span>
                            {status.exposedDuplicates.length} duplicate tool
                            {status.exposedDuplicates.length === 1 ? "" : "s"}{" "}
                            exposed by you — the model can use both this
                            server&apos;s
                            {" "}
                            <code>{`${slugPrefix(server.name)}__…`}</code> tool and
                            the built-in, and chooses per call.
                          </span>
                        </p>
                        <ul className="space-y-0.5 pl-5 text-xs">
                          {status.exposedDuplicates.map((tool) => (
                            <li
                              className="flex items-center justify-between gap-2"
                              key={tool}
                            >
                              <code>{`${slugPrefix(server.name)}__${tool}`}</code>
                              <Button
                                onClick={() =>
                                  void unexposeDuplicate(server.id, tool)
                                }
                                size="sm"
                                type="button"
                                variant="ghost"
                              >
                                Undo
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                <div className="mt-2 flex items-center gap-2">
                  <Button
                    disabled={testingId === server.id}
                    onClick={() => void testServer(server.id)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {testingId === server.id ? (
                      <CircleNotch className="size-3.5 animate-spin" />
                    ) : (
                      <ArrowClockwise className="size-3.5" />
                    )}
                    Test connection
                  </Button>
                  <Button
                    onClick={() => void deleteServer(server.id)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash className="size-3.5" />
                    Remove
                  </Button>

                  {/* Set as primary capability toggle — shown for servers
                      that expose web_search or web_fetch tools. */}
                  {server.primaryCapabilities &&
                  server.primaryCapabilities.length > 0 ? (
                    <div className="flex items-center gap-1.5">
                      {server.primaryCapabilities.map((cap) => (
                        <span
                          className="text-xs text-muted-foreground"
                          key={cap}
                        >
                          Primary: {cap}
                        </span>
                      ))}
                    </div>
                  ) : status?.toolCount && status.toolCount > 0 ? (
                    <label className="flex items-center gap-1.5 text-xs">
                      <Switch
                        checked={
                          (server.primaryCapabilities ?? []).includes(
                            "web_search"
                          ) ||
                          (server.primaryCapabilities ?? []).includes("web_fetch")
                        }
                        onCheckedChange={(checked) =>
                          void setServerPrimaryCapabilities(
                            server,
                            checked ? ["web_search", "web_fetch"] : []
                          )
                        }
                      />
                      <span>Set as primary for web search/fetch</span>
                    </label>
                  ) : null}

                  {baseline && (
                    <span className="text-muted-foreground text-xs">
                      {baseline.toolCount} approved tool
                      {baseline.toolCount === 1 ? "" : "s"}
                    </span>
                  )}
                </div>

                {testResult && (
                  <div className="mt-2 rounded-md border bg-muted/40 p-2 text-xs">
                    {testResult.ok ? (
                      <div className="space-y-1.5">
                        <p className="font-medium">
                          Connected to{" "}
                          {testResult.serverName ?? "the server"}
                          {testResult.serverVersion
                            ? ` v${testResult.serverVersion}`
                            : ""}
                          {testResult.protocolVersion
                            ? ` (MCP ${testResult.protocolVersion})`
                            : ""}
                        </p>
                        {testResult.tools && testResult.tools.length > 0 ? (
                          <ul className="max-h-40 space-y-1 overflow-y-auto">
                            {testResult.tools.map((tool) => (
                              <li key={tool.name}>
                                <code>{tool.name}</code>
                                {tool.description ? (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    — {tool.description.split("\n")[0].slice(0, 160)}
                                  </span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-muted-foreground">
                            The server exposes no tools.
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-destructive">
                        Connection failed: {testResult.error}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {formOpen ? (
            <div className="space-y-3 rounded-lg border p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm" htmlFor="mcp-new-name">
                    Name
                  </label>
                  <Input
                    id="mcp-new-name"
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="My tools server"
                    value={formName}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm" htmlFor="mcp-new-transport">
                    Transport
                  </label>
                  <Select
                    onValueChange={(value) =>
                      setFormTransport(value as McpTransportKind)
                    }
                    value={formTransport}
                  >
                    <SelectTrigger id="mcp-new-transport">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="http">
                        HTTP (streamable, recommended)
                      </SelectItem>
                      <SelectItem value="sse">SSE (legacy remote)</SelectItem>
                      <SelectItem value="stdio">
                        stdio (local process)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {formTransport === "stdio" ? (
                <>
                  <div className="space-y-1.5">
                    <label className="text-sm" htmlFor="mcp-new-command">
                      Command
                    </label>
                    <Input
                      id="mcp-new-command"
                      onChange={(e) => setFormCommand(e.target.value)}
                      placeholder="npx -y @modelcontextprotocol/server-filesystem /path"
                      value={formCommand}
                    />
                    <p className="text-muted-foreground text-xs">
                      The executable is spawned locally with no shell. Use
                      an absolute path or a command on the server&apos;s
                      PATH.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm" htmlFor="mcp-new-args">
                      Arguments (one per line, optional)
                    </label>
                    <textarea
                      className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
                      id="mcp-new-args"
                      onChange={(e) => setFormArgs(e.target.value)}
                      placeholder={
                        "-y\n@modelcontextprotocol/server-everything"
                      }
                      rows={3}
                      value={formArgs}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-sm">
                      Environment variables (optional)
                    </span>
                    {renderKeyValueEditor(
                      formEnv,
                      setFormEnv,
                      "API_KEY",
                      "value"
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <label className="text-sm" htmlFor="mcp-new-url">
                      Server URL
                    </label>
                    <Input
                      id="mcp-new-url"
                      onChange={(e) => setFormUrl(e.target.value)}
                      placeholder="https://mcp.example.com/mcp"
                      value={formUrl}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-sm">
                      Request headers (optional, e.g. Authorization)
                    </span>
                    {renderKeyValueEditor(
                      formHeaders,
                      setFormHeaders,
                      "Authorization",
                      "Bearer …"
                    )}
                  </div>
                </>
              )}

              <div className="flex items-center gap-3">
                <Button
                  disabled={formBusy}
                  onClick={() => void submitAddServer()}
                  type="button"
                >
                  {formBusy ? (
                    <CircleNotch className="size-4 animate-spin" />
                  ) : null}
                  Add server
                </Button>
                <Button
                  onClick={() => {
                    setFormOpen(false);
                    resetForm();
                  }}
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
                {formError ? (
                  <p className="text-destructive text-xs">{formError}</p>
                ) : null}
              </div>
            </div>
          ) : (
            <Button
              onClick={() => setFormOpen(true)}
              type="button"
              variant="outline"
            >
              Add MCP server
            </Button>
          )}
        </CardContent>
      </Card>

      <p className="mt-4 text-muted-foreground text-xs">
        stdio servers run as local child processes on this machine — only
        use commands you trust. Remote servers can see every tool call the
        model makes to them; HTTP redirects are rejected by default.
      </p>
    </>
  );

  const renderMarketplaceTab = () => (
    <>
      <div className="mb-4 space-y-3">
        <Input
          aria-label="Search marketplace"
          placeholder="Search servers..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <div className="flex flex-wrap gap-1">
          {MARKETPLACE_CATEGORIES.map((cat) => (
            <Button
              key={cat.key || "all"}
              size="sm"
              type="button"
              variant={activeCategory === cat.key ? "default" : "outline"}
              onClick={() => setActiveCategory(cat.key)}
            >
              {cat.label}
            </Button>
          ))}
        </div>
      </div>

      {marketplaceLoading && (
        <p className="text-muted-foreground text-sm">Loading marketplace…</p>
      )}

      {marketplaceError && (
        <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
          {marketplaceError}
        </p>
      )}

      {!marketplaceLoading && !marketplaceError && (
        <div className="space-y-3">
          {marketplaceItems.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No servers match your search.
            </p>
          ) : (
            marketplaceItems.map((preset) => (
              <div
                className="rounded-lg border p-3"
                data-testid="preset-card"
                key={preset.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium text-sm">{preset.name}</h3>
                    <p className="text-muted-foreground text-xs">
                      {preset.description}
                    </p>
                    <Badge variant="outline" className="mt-1 text-xs">
                      {preset.category}
                    </Badge>
                  </div>
                  <Button
                    size="sm"
                    type="button"
                    onClick={() => openInstallDialog(preset)}
                  >
                    Install
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );

  return (
    <PageView onBack={onBack} title="MCP Servers">
      <Tabs
        defaultValue="configured"
        value={activeTab}
        onValueChange={(value) =>
          setActiveTab(value as "configured" | "marketplace")
        }
      >
        <div className="mb-4">
          <TabsList variant="line">
            <TabsTrigger value="configured">Configured Servers</TabsTrigger>
            <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
          </TabsList>
          <p className="mt-1 text-muted-foreground text-sm">
            Connect Model Context Protocol servers to give the assistant
            extra tools. Enabled servers are contacted on every chat request
            and their tools are exposed to the model as{" "}
            <code className="text-xs">server-name__tool-name</code>. Tool
            definitions are pinned on first connection; if a server later
            changes a definition or adds tools, those are withheld until you
            re-approve it.
          </p>
        </div>

        <TabsContent value="configured">
          {renderConfiguredTab()}
        </TabsContent>

        <TabsContent value="marketplace">
          {renderMarketplaceTab()}
        </TabsContent>
      </Tabs>

      {/* Guided install dialog: prompts for required env vars. */}
      <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Configure {installPreset?.name ?? "server"}
            </DialogTitle>
            <DialogDescription>
              This server requires environment variables. Enter them below
              before installing. Sensitive values (tokens, keys, passwords)
              are stored in the secret store, not in plain text.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            {installPreset?.envVars &&
              installPreset.envVars.length > 0 &&
              installPreset.envVars.map((ev) => (
                <div className="space-y-1" key={ev.name}>
                  <label className="text-sm" htmlFor={`env-${ev.name}`}>
                    {ev.name} {ev.required && <span className="text-destructive">*</span>}
                  </label>
                  <Input
                    id={`env-${ev.name}`}
                    type="password"
                    placeholder={ev.description}
                    value={installEnvValues[ev.name] ?? ""}
                    onChange={(e) =>
                      setInstallEnvValues({
                        ...installEnvValues,
                        [ev.name]: e.target.value,
                      })
                    }
                  />
                </div>
              ))}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setInstallDialogOpen(false);
                setFormError(null);
              }}
              type="button"
            >
              Cancel
            </Button>
            <Button
              disabled={installBusy}
              onClick={() => void confirmInstall()}
              type="button"
            >
              {installBusy ? (
                <CircleNotch className="size-4 animate-spin" />
              ) : null}
              Install &amp; test
            </Button>
          </DialogFooter>

          {formError ? (
            <p className="text-destructive text-xs">{formError}</p>
          ) : null}
        </DialogContent>
      </Dialog>
    </PageView>
  );
}
