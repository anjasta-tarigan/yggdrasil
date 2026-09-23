"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CircleNotch,
  DownloadSimple,
  Funnel,
  MagnifyingGlass,
  Storefront,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { CatalogEntry, CatalogResponse, MarketplaceRow } from "@/components/plugins/types";

/**
 * "Plugin marketplaces" tab — manage marketplace sources (the official
 * Anthropic one is pre-seeded; any GitHub-hosted catalog can be added)
 * and browse the selected marketplace's catalog to install plugins.
 *
 * Pure presentational over props: catalog loading, install and
 * marketplace add/remove all live in the parent PluginsView; the tab
 * owns only the add-source input and the marketplace selection.
 */

type Props = {
  marketplaces: MarketplaceRow[];
  selectedMarketplace: string;
  catalog: CatalogResponse | null;
  catalogError: string | null;
  loadingCatalog: boolean;
  busyKey: string | null;
  onSelectMarketplace: (id: string) => void;
  onRefreshCatalog: () => void;
  onAddMarketplace: (source: string) => void;
  onRemoveMarketplace: (row: MarketplaceRow) => void;
  onInstall: (entryName: string) => void;
};

export function PluginMarketplacesTab({
  marketplaces,
  selectedMarketplace,
  catalog,
  catalogError,
  loadingCatalog,
  busyKey,
  onSelectMarketplace,
  onRefreshCatalog,
  onAddMarketplace,
  onRemoveMarketplace,
  onInstall,
}: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "installed" | "available">("all");
  const [pendingRemove, setPendingRemove] = useState<MarketplaceRow | null>(null);

  const filteredEntries = useMemo(() => {
    if (!catalog?.entries) return [];
    const q = searchQuery.trim().toLowerCase();
    const matchesQuery = (entry: CatalogEntry) => {
      if (!q) return true;
      return [
        entry.name,
        entry.displayName ?? "",
        entry.description ?? "",
        entry.category ?? "",
      ].some((field) => field.toLowerCase().includes(q));
    };
    const matchesCategory = (entry: CatalogEntry) => {
      if (selectedCategory === "all") return true;
      return entry.category === selectedCategory;
    };
    const matchesStatus = (entry: CatalogEntry) => {
      if (statusFilter === "all") return true;
      if (statusFilter === "installed") return entry.installed;
      return !entry.installed;
    };
    return catalog.entries.filter(
      (entry) => matchesQuery(entry) && matchesCategory(entry) && matchesStatus(entry)
    );
  }, [catalog, searchQuery, selectedCategory, statusFilter]);

  const uniqueCategories = useMemo(() => {
    if (!catalog?.entries) return [];
    return Array.from(
      new Set(catalog.entries.map((e) => e.category).filter(Boolean))
    ) as string[];
  }, [catalog]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 font-semibold text-lg">
          <Storefront className="size-5" />
          Plugin marketplaces
        </h2>
        <p className="mt-0.5 text-muted-foreground text-xs">
          Claude Code plugin marketplaces (`.claude-plugin/marketplace.json`
          catalogs). Hooks, themes and other Claude Code-only components are
          ignored — never executed.
        </p>
      </div>

      {catalogError && (
        <p className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
          <Warning className="size-4 shrink-0" />
          {catalogError}
        </p>
      )}

      {/* ── Marketplace sources ──────────────────────────────── */}
      <Card>
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
                  aria-label={`Remove ${mkt.name}`}
                  className="text-destructive hover:bg-destructive/10"
                  disabled={busyKey !== null}
                  onClick={() => setPendingRemove(mkt)}
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
          <AddMarketplaceForm busy={busyKey !== null} onSubmit={onAddMarketplace} />
        </CardContent>
      </Card>

      <ConfirmDialog
        busy={busyKey === `rm-mkt:${pendingRemove?.id}`}
        confirmLabel="Remove marketplace"
        description={
          <>
            Removing “{pendingRemove?.name}” also uninstalls every plugin
            sourced from it. The plugins are removed too, not just the link.
          </>
        }
        onConfirm={() => {
          if (pendingRemove) onRemoveMarketplace(pendingRemove);
          setPendingRemove(null);
        }}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        open={pendingRemove !== null}
        title={`Remove ${pendingRemove?.name}?`}
      />

      {/* ── Catalog browser ──────────────────────────────────── */}
      <Card>
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
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                onValueChange={(value) => {
                  setSearchQuery("");
                  setSelectedCategory("all");
                  setStatusFilter("all");
                  onSelectMarketplace(value);
                }}
                value={selectedMarketplace}
              >
                <SelectTrigger aria-label="Select marketplace" className="w-full">
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
              <Button
                aria-label="Refresh catalog"
                disabled={loadingCatalog || !selectedMarketplace}
                onClick={onRefreshCatalog}
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
          )}

          {loadingCatalog && !catalog && (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  className="flex items-center gap-3 rounded-md border px-3 py-3"
                  key={i}
                >
                  <CircleNotch className="size-4 animate-spin text-muted-foreground" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-1/3 rounded-sm bg-muted" />
                    <div className="h-2.5 w-2/3 rounded-sm bg-muted/70" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {catalog && (
            <>
              {/* ── Search + filters ───────────────────────── */}
              <div className="flex flex-col gap-3">
                <div className="relative w-full">
                  <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    aria-label="Search plugins"
                    className="pl-8 pr-8"
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search plugins…"
                    value={searchQuery}
                  />
                  {searchQuery && (
                    <button
                      aria-label="Clear search input"
                      className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                      onClick={() => setSearchQuery("")}
                      type="button"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {uniqueCategories.length > 0 && (
                    <Select
                      onValueChange={(value) => setSelectedCategory(value)}
                      value={selectedCategory}
                    >
                      <SelectTrigger aria-label="Filter by category" className="w-full sm:w-40">
                        <SelectValue placeholder="All categories" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All categories</SelectItem>
                        {uniqueCategories.map((cat) => (
                          <SelectItem key={cat} value={cat}>
                            {cat}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <div
                    aria-label="Filter by status"
                    className="flex items-center gap-1 rounded-md border p-1 text-xs"
                    role="group"
                  >
                    <button
                      aria-pressed={statusFilter === "all"}
                      className={`rounded px-2 py-1 transition-colors ${
                        statusFilter === "all"
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setStatusFilter("all")}
                      type="button"
                    >
                      All
                    </button>
                    <button
                      aria-pressed={statusFilter === "installed"}
                      className={`rounded px-2 py-1 transition-colors ${
                        statusFilter === "installed"
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setStatusFilter("installed")}
                      type="button"
                    >
                      Installed
                    </button>
                    <button
                      aria-pressed={statusFilter === "available"}
                      className={`rounded px-2 py-1 transition-colors ${
                        statusFilter === "available"
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setStatusFilter("available")}
                      type="button"
                    >
                      Available
                    </button>
                  </div>
                </div>

                <p className="text-muted-foreground text-xs">
                  {filteredEntries.length} of {catalog.entries.length} plugins shown
                </p>
              </div>

              {filteredEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
                  <Funnel className="size-8 text-muted-foreground" />
                  <div>
                    <p className="font-medium text-sm">No plugins match your filters</p>
                    <p className="mt-1 max-w-md text-muted-foreground text-xs">
                      {searchQuery ||
                      selectedCategory !== "all" ||
                      statusFilter !== "all"
                        ? 'Try adjusting the search or filter terms.'
                        : 'This marketplace has no plugins in its catalog.'}
                    </p>
                  </div>
                  {(searchQuery ||
                    selectedCategory !== "all" ||
                    statusFilter !== "all") && (
                    <Button
                      onClick={() => {
                        setSearchQuery("");
                        setSelectedCategory("all");
                        setStatusFilter("all");
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <X className="size-4" />
                      Clear search
                    </Button>
                  )}
                </div>
              ) : (
                <ul className="max-h-96 space-y-2 overflow-y-auto">
                  {filteredEntries.map((entry) => (
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
                        onClick={() => onInstall(entry.name)}
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
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Add-marketplace inline form ─────────────────────────────────── */

/** Source input + add button; local state only, cleared on submit. */
function AddMarketplaceForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (source: string) => void;
}) {
  const [source, setSource] = useState("");
  return (
    <div className="flex gap-2 border-t pt-3">
      <Input
        aria-label="New marketplace source"
        onChange={(e) => setSource(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && source.trim()) onSubmit(source);
        }}
        placeholder="owner/repo or github.com marketplace URL"
        value={source}
      />
      <Button
        disabled={busy || !source.trim()}
        onClick={() => onSubmit(source)}
        type="button"
      >
        {busy ? <CircleNotch className="size-4 animate-spin" /> : "Add"}
      </Button>
    </div>
  );
}
