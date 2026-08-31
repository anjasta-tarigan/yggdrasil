/**
 * Shared client-side types for the Plugins page. The API routes are
 * the source of truth; these shapes mirror their JSON payloads
 * (see src/app/api/plugins/*). Kept in one module so the Manage and
 * Marketplace tabs stay type-aligned, mirroring components/skills/types.ts.
 */

export type MarketplaceRow = {
  id: string;
  name: string;
  description: string | null;
  ownerName: string | null;
  lastSyncedAt: string | null;
  installedCount?: number;
};

export type CatalogEntry = {
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

export type CatalogResponse = {
  marketplace: { id: string; name: string; description?: string; owner?: string };
  entries: CatalogEntry[];
};

export type PluginRow = {
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

/** Component badges + ignored-component notes for an installed plugin row. */
export function pluginComponentBadges(plugin: PluginRow): Array<{
  label: string;
  variant: "outline" | "secondary";
}> {
  const c = plugin.components ?? {};
  const badges: Array<{ label: string; variant: "outline" | "secondary" }> = [];
  if ((c.skills?.length ?? 0) > 0) {
    badges.push({ label: `${c.skills?.length} skills`, variant: "outline" });
  }
  if ((c.commands?.length ?? 0) > 0) {
    badges.push({ label: `${c.commands?.length} commands`, variant: "outline" });
  }
  if ((c.mcpServers?.length ?? 0) > 0) {
    badges.push({
      label: `${c.mcpServers?.length} MCP (see MCP page)`,
      variant: "outline",
    });
  }
  if ((c.ignored?.length ?? 0) > 0) {
    badges.push({
      label: `ignored: ${c.ignored?.join(", ")}`,
      variant: "secondary",
    });
  }
  return badges;
}
