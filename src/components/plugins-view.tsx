"use client";

import { PageView } from "@/components/app-shell/page-view";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Warning } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ManagePluginsTab } from "@/components/plugins/manage-plugins-tab";
import { PluginMarketplacesTab } from "@/components/plugins/plugin-marketplaces-tab";
import type {
  CatalogResponse,
  MarketplaceRow,
  PluginRow,
} from "@/components/plugins/types";

/**
 * Plugins page — two separated areas behind one shell:
 *   • Manage plugins     — the installed set (enable, uninstall)
 *   • Plugin marketplaces — marketplace sources + catalog browsing
 *
 * Consumed plugin components: skills → Skills system, commands → chat
 * slash-commands, MCP servers → MCP registry (registered disabled).
 * Hooks/themes/LSP are ignored and never executed.
 *
 * Same in-shell layout contract and tab pattern as SkillsView; the
 * parent owns all domain state (selection, catalog, busy keys) so the
 * uninstall→catalog refresh flow stays explicit.
 */

const PLUGINS_TABS = [
  { value: "manage", label: "Manage plugins" },
  { value: "marketplace", label: "Plugin marketplaces" },
] as const;

type PluginsTab = (typeof PLUGINS_TABS)[number]["value"];

export function PluginsView({ onBack }: { onBack: () => void }) {
  const [marketplaces, setMarketplaces] = useState<MarketplaceRow[]>([]);
  const [selectedMarketplace, setSelectedMarketplace] = useState<string>("");
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);

  const [plugins, setPlugins] = useState<PluginRow[]>([]);
  const [loadingPlugins, setLoadingPlugins] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PluginsTab>("manage");

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
    setLoadingPlugins(true);
    fetch("/api/plugins")
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const data = await res.json();
        setPlugins(data.plugins ?? []);
      })
      .catch(() => setError("Could not load installed plugins."))
      .finally(() => setLoadingPlugins(false));
  }, []);

  useEffect(() => {
    refreshMarketplaces();
    refreshPlugins();
  }, [refreshMarketplaces, refreshPlugins]);

  const addMarketplace = useCallback(
    async (source: string) => {
      const trimmed = source.trim();
      if (!trimmed) return;
      setBusyKey("add-marketplace");
      setError(null);
      setNotice(null);
      try {
        const res = await fetch("/api/plugins/marketplaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: trimmed }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to add marketplace.");
        setNotice(
          `Marketplace “${data.marketplace?.name}” added (${data.pluginCount} plugins).`
        );
        refreshMarketplaces();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add marketplace.");
      } finally {
        setBusyKey(null);
      }
    },
    [refreshMarketplaces]
  );

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
    async (entryName: string) => {
      setBusyKey(`install:${entryName}`);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch("/api/plugins/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            marketplaceId: selectedMarketplace,
            pluginName: entryName,
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
          `Installed “${entryName}”${parts.length ? ` — ${parts.join(", ")}` : ""}.`
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
    <PageView onBack={onBack} title="Plugins">
      <p className="mb-4 mt-1 text-muted-foreground text-sm">
        Install Claude Code plugins from marketplaces. Plugin skills join
        the Skills system, commands become chat slash-commands, and MCP
        servers are registered disabled on the MCP page. Manage the
        installed set, or add marketplaces to browse more.
      </p>

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

      <Tabs
        className="gap-4"
        onValueChange={(value) => setActiveTab(value as PluginsTab)}
        value={activeTab}
      >
        <TabsList>
          {PLUGINS_TABS.map((tab) => (
            <TabsTrigger className="px-3" key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="manage">
          <ManagePluginsTab
            busyKey={busyKey}
            loading={loadingPlugins}
            onOpenMarketplace={() => setActiveTab("marketplace")}
            onToggle={(plugin, enabled) => void togglePlugin(plugin, enabled)}
            onUninstall={(plugin) => void uninstallPlugin(plugin)}
            plugins={plugins}
          />
        </TabsContent>

        <TabsContent value="marketplace">
          <PluginMarketplacesTab
            busyKey={busyKey}
            catalog={catalog}
            catalogError={catalogError}
            loadingCatalog={loadingCatalog}
            marketplaces={marketplaces}
            onAddMarketplace={(source) => void addMarketplace(source)}
            onInstall={(entryName) => void installPlugin(entryName)}
            onRefreshCatalog={() => void loadCatalog(selectedMarketplace)}
            onRemoveMarketplace={(row) => void removeMarketplace(row)}
            onSelectMarketplace={(id) => {
              setSelectedMarketplace(id);
              void loadCatalog(id);
            }}
            selectedMarketplace={selectedMarketplace}
          />
        </TabsContent>
      </Tabs>
    </PageView>
  );
}
