"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Storefront,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import { useState } from "react";
import type { CatalogResponse, MarketplaceRow } from "@/components/plugins/types";

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
                  disabled={busyKey !== null}
                  onClick={() => onRemoveMarketplace(mkt)}
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
                onValueChange={(value) => onSelectMarketplace(value)}
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
