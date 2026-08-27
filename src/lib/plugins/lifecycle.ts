/**
 * Plugin lifecycle — install, enable/disable, uninstall. Orchestrates
 * marketplace manifest fetching, source resolution, tree writing and
 * component mapping.
 */

import fs from "node:fs";
import { eq } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { pluginCommands, pluginMarketplaces, plugins, skills } from "@/db/schema";
import {
  MCP_SERVERS_KEY,
  sanitizeMcpServerList,
} from "@/lib/ai/mcp/config";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import { skillDir, type StoreOptions } from "@/lib/skills/store";
import { GuardedFetchOptions } from "@/lib/skills/registries/http";
import { mapPluginComponents, type ComponentSummary } from "./components";
import {
  pluginDir,
  removePluginTree,
  resolvePluginSource,
  writePluginTree,
  type WritePluginOptions,
} from "./installer";
import {
  fetchMarketplaceManifest,
  getMarketplace,
  type MarketplaceManifest,
  type MarketplacePluginEntry,
  type MarketplaceRow,
  type MarketplaceSource,
} from "./marketplace";

export type PluginRow = typeof plugins.$inferSelect;

export interface LifecycleOptions extends WritePluginOptions {
  db?: AppDatabase;
  skillsStore?: StoreOptions;
  fetchOptions?: GuardedFetchOptions;
}

function createPluginId(): string {
  return `plug-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export type InstallPluginResult =
  | {
      ok: true;
      row: PluginRow;
      components: ComponentSummary;
      fileCount: number;
      replaced: boolean;
    }
  | { ok: false; error: string; unsupported?: boolean };

/**
 * Install one plugin from a registered marketplace. Re-installing an
 * already-installed plugin replaces its tree and components.
 */
export async function installPlugin(
  marketplaceId: string,
  pluginName: string,
  options: LifecycleOptions = {}
): Promise<InstallPluginResult> {
  const db = options.db ?? defaultDb;

  const marketplace = getMarketplace(marketplaceId, { db });
  if (!marketplace) {
    return { ok: false, error: "Marketplace not found." };
  }
  const marketplaceSource = marketplace.source as unknown as MarketplaceSource;

  let manifest: MarketplaceManifest;
  try {
    manifest = await fetchMarketplaceManifest(marketplaceSource, options.fetchOptions);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const entry = manifest.plugins.find((p) => p.name === pluginName);
  if (!entry) {
    return { ok: false, error: `Plugin '${pluginName}' is not in marketplace '${manifest.name}'.` };
  }

  const resolved = await resolvePluginSource(entry.source, marketplaceSource, options.fetchOptions);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, unsupported: resolved.unsupported };
  }

  // Replace semantics: tear down a previous install first.
  const existing = db
    .select()
    .from(plugins)
    .where(eq(plugins.marketplaceId, marketplaceId))
    .all()
    .find((p) => p.name === pluginName);
  if (existing) {
    await uninstallPlugin(existing.id, options);
  }

  let fileCount: number;
  try {
    fileCount = writePluginTree(manifest.name, pluginName, resolved.tree, options);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const pluginId = createPluginId();
  db.insert(plugins)
    .values({
      id: pluginId,
      marketplaceId,
      name: pluginName,
      displayName:
        typeof entry.displayName === "string" ? entry.displayName : undefined,
      description:
        typeof entry.description === "string" ? entry.description : undefined,
      version: typeof entry.version === "string" ? entry.version : undefined,
      category: typeof entry.category === "string" ? entry.category : undefined,
      enabled: true,
      source: entry.source as unknown as Record<string, unknown>,
      components: {},
    })
    .run();

  let components: ComponentSummary;
  try {
    components = await mapPluginComponents({
      pluginId,
      pluginName,
      marketplaceName: manifest.name,
      files: resolved.tree.files,
      db,
      skillsStore: options.skillsStore,
    });
  } catch (err) {
    // Component mapping failed: roll back the partial install.
    await uninstallPlugin(pluginId, options);
    return {
      ok: false,
      error: `Plugin files installed but component mapping failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const [updated] = await db
    .update(plugins)
    .set({
      components: components as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(eq(plugins.id, pluginId))
    .returning();

  return { ok: true, row: updated, components, fileCount, replaced: Boolean(existing) };
}

export function listPlugins(options: { db?: AppDatabase } = {}): PluginRow[] {
  const db = options.db ?? defaultDb;
  return db.select().from(plugins).all();
}

export function getPlugin(
  id: string,
  options: { db?: AppDatabase } = {}
): PluginRow | undefined {
  const db = options.db ?? defaultDb;
  return db.select().from(plugins).where(eq(plugins.id, id)).get();
}

/**
 * Enable/disable a plugin: flips the plugin row and all its skills.
 * Commands follow via the enabled join at read time. MCP servers stay
 * user-managed (they were registered disabled and are not re-toggled).
 */
export function setPluginEnabled(
  id: string,
  enabled: boolean,
  options: { db?: AppDatabase } = {}
): PluginRow | undefined {
  const db = options.db ?? defaultDb;
  const now = new Date();
  db.update(plugins).set({ enabled, updatedAt: now }).where(eq(plugins.id, id)).run();
  db.update(skills).set({ enabled, updatedAt: now }).where(eq(skills.pluginId, id)).run();
  return getPlugin(id, { db });
}

type UninstallOptions = LifecycleOptions;

/**
 * Uninstall a plugin: remove its MCP registry entries, DB rows
 * (skills + commands cascade via FK) and file tree.
 */
export async function uninstallPlugin(
  id: string,
  options: UninstallOptions = {}
): Promise<boolean> {
  const db = options.db ?? defaultDb;
  const row = getPlugin(id, { db });
  if (!row) return false;

  // Remove MCP servers the plugin contributed.
  const components = (row.components ?? {}) as Partial<ComponentSummary>;
  const serverIds = new Set((components.mcpServers ?? []).map((s) => s.id));
  if (serverIds.size > 0) {
    const existing = sanitizeMcpServerList(getSettingDb(MCP_SERVERS_KEY, db)) ?? [];
    const remaining = existing.filter((s) => !serverIds.has(s.id));
    if (remaining.length !== existing.length) {
      setSettingsDb({ [MCP_SERVERS_KEY]: remaining }, db);
    }
  }

  // Remove skills folders contributed by the plugin.
  const pluginSkills = db
    .select({ name: skills.name })
    .from(skills)
    .where(eq(skills.pluginId, id))
    .all();
  for (const s of pluginSkills) {
    try {
      fs.rmSync(/*turbopackIgnore: true*/ skillDir(s.name, options.skillsStore), {
        recursive: true,
        force: true,
      });
    } catch {
      // Best-effort folder removal
    }
  }

  // Resolve the marketplace name for the tree location.
  const marketplace = db
    .select()
    .from(pluginMarketplaces)
    .where(eq(pluginMarketplaces.id, row.marketplaceId))
    .get();

  db.delete(plugins).where(eq(plugins.id, id)).run();

  if (marketplace) {
    removePluginTree(marketplace.name, row.name, options);
  }
  return true;
}

/** Commands of enabled plugins (for chat slash-expansion). */
export async function listEnabledCommands(options: { db?: AppDatabase } = {}): Promise<
  Array<{
    name: string;
    description: string | null;
    argumentHint: string | null;
    content: string;
    pluginName: string;
  }>
> {
  const db = options.db ?? defaultDb;
  const rows = await db
    .select({
      name: pluginCommands.name,
      description: pluginCommands.description,
      argumentHint: pluginCommands.argumentHint,
      content: pluginCommands.content,
      pluginName: plugins.name,
    })
    .from(pluginCommands)
    .innerJoin(plugins, eq(pluginCommands.pluginId, plugins.id))
    .where(eq(plugins.enabled, true));
  return rows;
}

/** Full path of an installed plugin tree (for diagnostics). */
export function installedPluginDir(
  marketplaceName: string,
  pluginName: string,
  options: WritePluginOptions = {}
): string {
  return pluginDir(marketplaceName, pluginName, options);
}

export type { MarketplacePluginEntry, MarketplaceRow };
