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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  ArrowLeft,
  CircleNotch,
  DownloadSimple,
  PuzzlePiece,
  Storefront,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Plugins page — browse Claude Code plugin marketplaces
 * (`.claude-plugin/marketplace.json` catalogs), install plugins and
 * manage the installed set. The official Anthropic marketplace is
 * pre-seeded; any GitHub-hosted marketplace can be added.
 *
 * Consumed plugin components: skills → Skills system, commands → chat
 * slash-commands, MCP servers → MCP registry (registered disabled).
 * Hooks/themes/LSP are ignored and never executed.
 */

type MarketplaceRow = {
  id: string;
  name: string;
  description: string | null;
  ownerName: string | null;
  lastSyncedAt: string | null;
  installedCount?: number;
};

type CatalogEntry = {
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  category?: string;
  author?: string;
  sourceType: string;
  supported: boolean;
  installed: boolean;
  installedId?: string;
  enabled: boolean;
  installedVersion?: string | null;
};

type CatalogResponse = {
  marketplace: { id: string; name: string; description?: string; owner?: string };
  entries: CatalogEntry[];
};

type PluginRow = {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  version: string | null;
  category: string | null;
  enabled: boolean;
  marketplaceName?: string;
  components?: {
    skills?: Array<{ installedName: string }>;
    commands?: Array<{ name: string }>;
    mcpServers?: Array<{ name: string }>;
    ignored?: string[];
    skipped?: string[];
  } | null;
};

export function PluginsView({ onBack }: { onBack: () => void }) {
  const [marketplaces, setMarketplaces] = useState<MarketplaceRow[]>([]);
  const [selectedMarketplace, setSelectedMarketplace] = useState<string>("");
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);

  const [plugins, setPlugins] = useState<PluginRow[]>([]);
  const [newSource, setNewSource] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCatalog = useCallback(async (marketplaceId: string) => {
    if (!marketplaceId) return;
    setLoadingCatalog(true);
    setCatalogError(null);
    setCatalog(null);
    try {
      const res = await fetch(
        `/api/plugins/catalog?marketplace=${encodeURIComponent(marketplaceId)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load catalog.");
      setCatalog(data);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : "Failed to load catalog.");
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  // Track the latest selection so refreshMarketplaces (stable identity,
  // safe to use in the mount effect) can decide whether the catalog needs
  // reloading — instead of an effect that sets state synchronously.
  const selectedMarketplaceRef = useRef(selectedMarketplace);
  useEffect(() => {
    selectedMarketplaceRef.current = selectedMarketplace;
  }, [selectedMarketplace]);

  const refreshMarketplaces = useCallback(() => {
    fetch("/api/plugins/marketplaces")
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const data = await res.json();
        const rows: MarketplaceRow[] = data.marketplaces ?? [];
        setMarketplaces(rows);
        const current = selectedMarketplaceRef.current;
        const next =
          current && rows.some((m) => m.id === current)
            ? current
            : (rows[0]?.id ?? "");
        setSelectedMarketplace(next);
        if (next && next !== current) void loadCatalog(next);
      })
      .catch(() => setError("Could not load marketplaces."));
  }, [loadCatalog]);

  const refreshPlugins = useCallback(() => {
    fetch("/api/plugins")
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const data = await res.json();
        setPlugins(data.plugins ?? []);
      })
      .catch(() => setError("Could not load installed plugins."));
  }, []);

  useEffect(() => {
    refreshMarketplaces();
    refreshPlugins();
  }, [refreshMarketplaces, refreshPlugins]);

  const addMarketplace = useCallback(async () => {
    const source = newSource.trim();
    if (!source) return;
    setBusyKey("add-marketplace");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/plugins/marketplaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add marketplace.");
      setNotice(
        `Marketplace “${data.marketplace?.name}” added (${data.pluginCount} plugins).`
      );
      setNewSource("");
      refreshMarketplaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add marketplace.");
    } finally {
      setBusyKey(null);
    }
  }, [newSource, refreshMarketplaces]);

  const removeMarketplace = useCallback(
    async (row: MarketplaceRow) => {
      setBusyKey(`rm-mkt:${row.id}`);
      setError(null);
      try {
        const res = await fetch(`/api/plugins/marketplaces/${row.id}`, {
          method: "DELETE",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to remove marketplace.");
        if (data.removedPlugins > 0) {
          setNotice(
            `Removed marketplace and uninstalled ${data.removedPlugins} plugin(s).`
          );
        }
        refreshMarketplaces();
        refreshPlugins();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove marketplace.");
      } finally {
        setBusyKey(null);
      }
    },
    [refreshMarketplaces, refreshPlugins]
  );

  const installPlugin = useCallback(
    async (entry: CatalogEntry) => {
      setBusyKey(`install:${entry.name}`);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch("/api/plugins/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            marketplaceId: selectedMarketplace,
            pluginName: entry.name,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Install failed.");
        const parts: string[] = [];
        const c = data.components ?? {};
        if (c.skills?.length) parts.push(`${c.skills.length} skills`);
        if (c.commands?.length) parts.push(`${c.commands.length} commands`);
        if (c.mcpServers?.length)
          parts.push(`${c.mcpServers.length} MCP servers (disabled)`);
        setNotice(
          `Installed “${entry.name}”${parts.length ? ` — ${parts.join(", ")}` : ""}.`
        );
        refreshPlugins();
        void loadCatalog(selectedMarketplace);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Install failed.");
      } finally {
        setBusyKey(null);
      }
    },
    [loadCatalog, refreshPlugins, selectedMarketplace]
  );

  const togglePlugin = useCallback(async (plugin: PluginRow, enabled: boolean) => {
    setPlugins((prev) =>
      prev.map((p) => (p.id === plugin.id ? { ...p, enabled } : p))
    );
    try {
      const res = await fetch(`/api/plugins/${plugin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setPlugins((prev) =>
        prev.map((p) => (p.id === plugin.id ? { ...p, enabled: !enabled } : p))
      );
    }
  }, []);

  const uninstallPlugin = useCallback(
    async (plugin: PluginRow) => {
      setBusyKey(`uninstall:${plugin.id}`);
      setError(null);
      try {
        const res = await fetch(`/api/plugins/${plugin.id}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Uninstall failed.");
        setNotice(`Uninstalled “${plugin.name}”.`);
        refreshPlugins();
        if (selectedMarketplace) void loadCatalog(selectedMarketplace);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Uninstall failed.");
      } finally {
        setBusyKey(null);
      }
    },
    [loadCatalog, refreshPlugins, selectedMarketplace]
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <Button onClick={onBack} size="sm" type="button" variant="ghost">
            <ArrowLeft className="size-4" />
            Back to chat
          </Button>
        </div>

        <div className="mb-4">
          <h1 className="flex items-center gap-2 font-semibold text-xl">
            <PuzzlePiece className="size-5 text-primary" />
            Plugins
          </h1>
          <p className="mt-1 text-muted-foreground text-sm">
            Install Claude Code plugins from marketplaces. Plugin skills join
            the Skills system, commands become chat slash-commands, and MCP
            servers are registered disabled on the MCP page. Hooks and other
            Claude Code-only components are ignored.
          </p>
        </div>

        {error && (
          <p className="mb-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
            <Warning className="size-4 shrink-0" />
            {error}
          </p>
        )}
        {notice && (
          <p className="mb-4 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
            {notice}
          </p>
        )}

        {/* ── Marketplaces ────────────────────────────────────── */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Storefront className="size-4" />
              Marketplaces
            </CardTitle>
            <CardDescription>
              The official Anthropic marketplace is included by default. Add
              any GitHub-hosted marketplace by repo or URL.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-2">
              {marketplaces.map((mkt) => (
                <li
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  key={mkt.id}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-sm">{mkt.name}</p>
                    <p className="truncate text-muted-foreground text-xs">
                      {mkt.ownerName ?? "unknown owner"}
                      {typeof mkt.installedCount === "number" &&
                        ` · ${mkt.installedCount} installed`}
                    </p>
                  </div>
                  <Button
                    disabled={busyKey !== null}
                    onClick={() => void removeMarketplace(mkt)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {busyKey === `rm-mkt:${mkt.id}` ? (
                      <CircleNotch className="size-4 animate-spin" />
                    ) : (
                      <Trash className="size-4" />
                    )}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2 border-t pt-3">
              <Input
                onChange={(e) => setNewSource(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addMarketplace();
                }}
                placeholder="owner/repo or github.com marketplace URL"
                value={newSource}
              />
              <Button
                disabled={busyKey !== null || !newSource.trim()}
                onClick={() => void addMarketplace()}
                type="button"
              >
                {busyKey === "add-marketplace" ? (
                  <CircleNotch className="size-4 animate-spin" />
                ) : (
                  "Add"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Catalog browser ─────────────────────────────────── */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Browse catalog</CardTitle>
            <CardDescription>
              {catalog
                ? `${catalog.marketplace.name}${catalog.marketplace.owner ? ` by ${catalog.marketplace.owner}` : ""} — ${catalog.entries.length} plugins`
                : "Pick a marketplace to list its plugins."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {marketplaces.length > 0 && (
              <Select
                onValueChange={(value) => {
                  setSelectedMarketplace(value);
                  void loadCatalog(value);
                }}
                value={selectedMarketplace}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select marketplace" />
                </SelectTrigger>
                <SelectContent>
                  {marketplaces.map((mkt) => (
                    <SelectItem key={mkt.id} value={mkt.id}>
                      {mkt.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <div className="flex justify-end">
              <Button
                disabled={loadingCatalog || !selectedMarketplace}
                onClick={() => void loadCatalog(selectedMarketplace)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <CircleNotch
                  className={`size-4 ${loadingCatalog ? "animate-spin" : ""}`}
                />
                Refresh
              </Button>
            </div>

            {catalogError && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
                {catalogError}
              </p>
            )}

            {catalog && (
              <ul className="max-h-96 space-y-2 overflow-y-auto">
                {catalog.entries.map((entry) => (
                  <li
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                    key={entry.name}
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 font-medium text-sm">
                        {entry.displayName ?? entry.name}
                        {entry.version && (
                          <Badge variant="secondary">{entry.version}</Badge>
                        )}
                        {entry.category && (
                          <Badge variant="outline">{entry.category}</Badge>
                        )}
                        {!entry.supported && (
                          <Badge variant="destructive">
                            unsupported source: {entry.sourceType}
                          </Badge>
                        )}
                        {entry.installed && (
                          <Badge variant="default">installed</Badge>
                        )}
                      </p>
                      {entry.description && (
                        <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
                          {entry.description}
                        </p>
                      )}
                    </div>
                    <Button
                      disabled={
                        busyKey !== null || !entry.supported || entry.installed
                      }
                      onClick={() => void installPlugin(entry)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {busyKey === `install:${entry.name}` ? (
                        <CircleNotch className="size-4 animate-spin" />
                      ) : (
                        <DownloadSimple className="size-4" />
                      )}
                      {entry.installed ? "Installed" : "Install"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ── Installed plugins ───────────────────────────────── */}
        <h2 className="mb-2 font-semibold text-lg">
          Installed plugins{" "}
          <span className="text-muted-foreground text-sm">({plugins.length})</span>
        </h2>
        {plugins.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing installed yet. Browse a marketplace catalog above.
          </p>
        ) : (
          <ul className="space-y-2">
            {plugins.map((plugin) => {
              const c = plugin.components ?? {};
              return (
                <li className="rounded-md border px-3 py-2" key={plugin.id}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 font-medium text-sm">
                        {plugin.displayName ?? plugin.name}
                        {plugin.version && (
                          <Badge variant="secondary">{plugin.version}</Badge>
                        )}
                        <span className="text-muted-foreground text-xs">
                          from {plugin.marketplaceName}
                        </span>
                      </p>
                      {plugin.description && (
                        <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
                          {plugin.description}
                        </p>
                      )}
                      <p className="mt-1 flex flex-wrap gap-1">
                        {(c.skills?.length ?? 0) > 0 && (
                          <Badge variant="outline">
                            {c.skills?.length} skills
                          </Badge>
                        )}
                        {(c.commands?.length ?? 0) > 0 && (
                          <Badge variant="outline">
                            {c.commands?.length} commands
                          </Badge>
                        )}
                        {(c.mcpServers?.length ?? 0) > 0 && (
                          <Badge variant="outline">
                            {c.mcpServers?.length} MCP (see MCP page)
                          </Badge>
                        )}
                        {(c.ignored?.length ?? 0) > 0 && (
                          <Badge variant="secondary">
                            ignored: {c.ignored?.join(", ")}
                          </Badge>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        disabled={busyKey !== null}
                        onClick={() => void uninstallPlugin(plugin)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {busyKey === `uninstall:${plugin.id}` ? (
                          <CircleNotch className="size-4 animate-spin" />
                        ) : (
                          <Trash className="size-4" />
                        )}
                      </Button>
                      <Switch
                        checked={plugin.enabled}
                        onCheckedChange={(v) => void togglePlugin(plugin, v)}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
