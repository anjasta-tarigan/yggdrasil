"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  CircleNotch,
  MagnifyingGlass,
  PuzzlePiece,
  Storefront,
  Trash,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import {
  pluginComponentBadges,
  type PluginRow,
} from "@/components/plugins/types";

/**
 * "Manage plugins" tab — the installed plugin list: filter, component
 * badges, enable toggles and uninstall. Pure presentational over
 * props; all fetching lives in the parent PluginsView.
 */

type Props = {
  plugins: PluginRow[];
  busyKey: string | null;
  loading: boolean;
  onToggle: (plugin: PluginRow, enabled: boolean) => void;
  onUninstall: (plugin: PluginRow) => void;
  onOpenMarketplace: () => void;
};

export function ManagePluginsTab({
  plugins,
  busyKey,
  loading,
  onToggle,
  onUninstall,
  onOpenMarketplace,
}: Props) {
  const [filter, setFilter] = useState("");
  const [pendingUninstall, setPendingUninstall] = useState<PluginRow | null>(null);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return plugins;
    return plugins.filter((p) => {
      const haystack = [p.name, p.displayName ?? "", p.description ?? ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [filter, plugins]);

  const enabledCount = useMemo(
    () => plugins.filter((p) => p.enabled).length,
    [plugins]
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold text-lg">
            Installed plugins{" "}
            <span className="text-muted-foreground text-sm">
              ({plugins.length})
            </span>
          </h2>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {enabledCount} enabled · plugin skills join the Skills system,
            commands become chat slash-commands, MCP servers register
            disabled on the MCP page.
          </p>
        </div>
        {plugins.length > 0 && (
          <div className="relative w-full sm:w-64">
            <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Filter installed plugins"
              className="pl-8"
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter plugins…"
              value={filter}
            />
          </div>
        )}
      </div>

      {loading ? (
        <ul className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <li className="rounded-md border px-3 py-2" key={i}>
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-1.5 h-3 w-2/3" />
            </li>
          ))}
        </ul>
      ) : (
        plugins.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
            <PuzzlePiece className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium text-sm">No plugins installed yet</p>
              <p className="mt-1 max-w-md text-muted-foreground text-xs">
                Add a marketplace and install plugins from its catalog —
                skills, commands and MCP servers arrive pre-wired.
              </p>
            </div>
            <Button
              onClick={onOpenMarketplace}
              size="sm"
              type="button"
              variant="outline"
            >
              <Storefront className="size-4" />
              Open marketplaces
            </Button>
          </div>
        )
      )}

      {!loading && plugins.length > 0 && visible.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No plugins match “{filter.trim()}”.
        </p>
      )}

      {visible.length > 0 && (
        <ul className="space-y-2">
          {visible.map((plugin) => {
            const badges = pluginComponentBadges(plugin);
            return (
              <li className="rounded-md border px-3 py-2" key={plugin.id}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 font-medium text-sm">
                      {plugin.displayName ?? plugin.name}
                      {plugin.version && (
                        <Badge variant="secondary">{plugin.version}</Badge>
                      )}
                      {plugin.marketplaceName && (
                        <span className="text-muted-foreground text-xs">
                          from {plugin.marketplaceName}
                        </span>
                      )}
                      {plugin.enabled && (
                        <Badge className="border-transparent" variant="outline">
                          <span className="size-1.5 rounded-full bg-primary" />
                          enabled
                        </Badge>
                      )}
                    </p>
                    {plugin.description && (
                      <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
                        {plugin.description}
                      </p>
                    )}
                    {badges.length > 0 && (
                      <p className="mt-1 flex flex-wrap gap-1">
                        {badges.map((badge) => (
                          <Badge
                            key={badge.label}
                            variant={badge.variant}
                          >
                            {badge.label}
                          </Badge>
                        ))}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      aria-label={`Uninstall ${plugin.displayName ?? plugin.name}`}
                      className="text-destructive hover:bg-destructive/10"
                      disabled={busyKey !== null}
                      onClick={() => setPendingUninstall(plugin)}
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
                      aria-label={`Toggle ${plugin.displayName ?? plugin.name}`}
                      checked={plugin.enabled}
                      onCheckedChange={(v) => onToggle(plugin, v)}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        busy={busyKey === `uninstall:${pendingUninstall?.id}`}
        confirmLabel="Uninstall"
        description={`This removes “${pendingUninstall?.displayName ?? pendingUninstall?.name}” from your installed plugins.`}
        onConfirm={() => {
          if (pendingUninstall) onUninstall(pendingUninstall);
          setPendingUninstall(null);
        }}
        onOpenChange={(open) => {
          if (!open) setPendingUninstall(null);
        }}
        open={pendingUninstall !== null}
        title={`Uninstall ${pendingUninstall?.displayName ?? pendingUninstall?.name}?`}
      />
    </div>
  );
}
