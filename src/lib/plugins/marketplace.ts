/**
 * Plugin marketplace registry.
 *
 * A marketplace is a git repo containing `.claude-plugin/marketplace.json`
 * (the Claude Code plugin catalog format). GitHub repos are supported
 * directly through the raw/trees APIs; other git hosts are rejected
 * with a clear error (no git binary dependency).
 */

import { eq } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { pluginMarketplaces, plugins } from "@/db/schema";
import {
  fetchGithubRawFile,
  parseGithubRepoRef,
  type GithubRepoRef,
} from "@/lib/skills/registries/github";
import { GuardedFetchOptions, RegistryError } from "@/lib/skills/registries/http";

export const OFFICIAL_MARKETPLACE_REPO = "anthropics/claude-plugins-official";

export type MarketplaceRow = typeof pluginMarketplaces.$inferSelect;

export type MarketplaceSource =
  | { kind: "github"; owner: string; repo: string; ref?: string }
  | { kind: "git-url"; url: string };

/* ── Manifest types (Claude Code marketplace.json) ───────────────── */

export type PluginSourceSpec =
  | string
  | {
      source: "github" | "url" | "git-subdir" | "npm" | "archive" | "command";
      repo?: string;
      url?: string;
      path?: string;
      ref?: string;
      sha?: string;
      package?: string;
      version?: string;
      command?: string;
      [key: string]: unknown;
    };

export interface MarketplacePluginEntry {
  name: string;
  source: PluginSourceSpec;
  description?: string;
  displayName?: string;
  version?: string;
  category?: string;
  author?: { name?: string };
  strict?: boolean;
  [key: string]: unknown;
}

export interface MarketplaceManifest {
  name: string;
  description?: string;
  owner?: { name?: string; email?: string; url?: string };
  plugins: MarketplacePluginEntry[];
}

export interface MarketplaceOptions {
  db?: AppDatabase;
}

function createMarketplaceId(): string {
  return `mkt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Parse user input into a marketplace source. Accepts "owner/repo",
 * github.com URLs (→ github kind) and other https git URLs (recorded
 * as git-url; installation from them is unsupported but the manifest
 * location is documented for future git support).
 */
export function parseMarketplaceInput(input: string): MarketplaceSource | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const gh = parseGithubRepoRef(trimmed);
  if (gh && !gh.subpath) {
    return { kind: "github", owner: gh.owner, repo: gh.repo, ref: gh.ref };
  }
  if (/^https?:\/\//.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "https:") return null;
      return { kind: "git-url", url: trimmed };
    } catch {
      return null;
    }
  }
  return null;
}

/** Validate a fetched marketplace.json document. */
export function validateMarketplaceManifest(raw: unknown): MarketplaceManifest | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "marketplace.json must be a JSON object." };
  }
  const v = raw as Record<string, unknown>;
  if (typeof v.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(v.name) || v.name.length > 100) {
    return { error: "marketplace.json needs a valid 'name' (kebab-case identifier)." };
  }
  if (!Array.isArray(v.plugins)) {
    return { error: "marketplace.json needs a 'plugins' array." };
  }
  const entries: MarketplacePluginEntry[] = [];
  for (const rawEntry of v.plugins.slice(0, 500)) {
    if (typeof rawEntry !== "object" || rawEntry === null) continue;
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.name !== "string" || entry.name.length === 0 || entry.name.length > 100) {
      return { error: "Every plugin entry needs a 'name'." };
    }
    if (entry.source === undefined) {
      return { error: `Plugin entry '${entry.name}' needs a 'source'.` };
    }
    entries.push(entry as unknown as MarketplacePluginEntry);
  }
  const owner =
    typeof v.owner === "object" && v.owner !== null
      ? (v.owner as MarketplaceManifest["owner"])
      : undefined;
  return {
    name: v.name,
    description: typeof v.description === "string" ? v.description : undefined,
    owner,
    plugins: entries,
  };
}

/** Fetch + validate the manifest for a marketplace source. */
export async function fetchMarketplaceManifest(
  source: MarketplaceSource,
  options: GuardedFetchOptions = {}
): Promise<MarketplaceManifest> {
  if (source.kind !== "github") {
    throw new RegistryError(
      "Only GitHub-hosted marketplaces are supported in this build."
    );
  }
  const ref: GithubRepoRef = {
    owner: source.owner,
    repo: source.repo,
    ref: source.ref,
  };
  const text = await fetchGithubRawFile(ref, ".claude-plugin/marketplace.json", options);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RegistryError("marketplace.json is not valid JSON.");
  }
  const manifest = validateMarketplaceManifest(raw);
  if ("error" in manifest) {
    throw new RegistryError(`Invalid marketplace manifest: ${manifest.error}`);
  }
  return manifest;
}

/* ── Registry CRUD ───────────────────────────────────────────────── */

/** Seed the official Anthropic marketplace on first run (idempotent). */
export function seedOfficialMarketplace(options: MarketplaceOptions = {}): void {
  const db = options.db ?? defaultDb;
  const existing = db.select().from(pluginMarketplaces).all();
  if (existing.length > 0) return;
  const [owner, repo] = OFFICIAL_MARKETPLACE_REPO.split("/");
  db.insert(pluginMarketplaces)
    .values({
      id: createMarketplaceId(),
      name: "claude-plugins-official",
      description:
        "Official, Anthropic-managed directory of high quality Claude Code Plugins.",
      ownerName: "Anthropic",
      source: { kind: "github", owner, repo } satisfies MarketplaceSource,
    })
    .run();
}

export function listMarketplaces(options: MarketplaceOptions = {}): MarketplaceRow[] {
  const db = options.db ?? defaultDb;
  return db.select().from(pluginMarketplaces).all();
}

export function getMarketplace(
  id: string,
  options: MarketplaceOptions = {}
): MarketplaceRow | undefined {
  const db = options.db ?? defaultDb;
  return db
    .select()
    .from(pluginMarketplaces)
    .where(eq(pluginMarketplaces.id, id))
    .get();
}

export type AddMarketplaceResult =
  | { ok: true; row: MarketplaceRow; manifest: MarketplaceManifest; replaced: boolean }
  | { ok: false; error: string };

/**
 * Register a marketplace: fetch + validate its manifest, then persist
 * the source. Re-adding the same manifest name replaces the old row
 * (its installed plugins cascade away).
 */
export async function addMarketplace(
  input: string,
  options: MarketplaceOptions & GuardedFetchOptions = {}
): Promise<AddMarketplaceResult> {
  const db = options.db ?? defaultDb;
  const source = parseMarketplaceInput(input);
  if (!source) {
    return {
      ok: false,
      error:
        "Enter a GitHub repo ('owner/repo' or github.com URL). Other git hosts are not supported yet.",
    };
  }

  let manifest: MarketplaceManifest;
  try {
    manifest = await fetchMarketplaceManifest(source, options);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const existing = db
    .select()
    .from(pluginMarketplaces)
    .where(eq(pluginMarketplaces.name, manifest.name))
    .get();

  if (existing) {
    // Replacing a marketplace removes its installed plugins (cascade).
    db.delete(pluginMarketplaces)
      .where(eq(pluginMarketplaces.id, existing.id))
      .run();
  }

  const row = db
    .insert(pluginMarketplaces)
    .values({
      id: createMarketplaceId(),
      name: manifest.name,
      description: manifest.description,
      ownerName: manifest.owner?.name,
      source: source as unknown as Record<string, unknown>,
      lastSyncedAt: new Date(),
    })
    .returning()
    .get();

  return { ok: true, row, manifest, replaced: Boolean(existing) };
}

export function removeMarketplace(id: string, options: MarketplaceOptions = {}): boolean {
  const db = options.db ?? defaultDb;
  const result = db.delete(pluginMarketplaces).where(eq(pluginMarketplaces.id, id)).run();
  return result.changes > 0;
}

/** Installed plugin count per marketplace (for the UI). */
export function countInstalledPlugins(
  marketplaceId: string,
  options: MarketplaceOptions = {}
): number {
  const db = options.db ?? defaultDb;
  const rows = db
    .select({ id: plugins.id })
    .from(plugins)
    .where(eq(plugins.marketplaceId, marketplaceId))
    .all();
  return rows.length;
}
