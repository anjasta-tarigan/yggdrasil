import { NextRequest, NextResponse } from "next/server";
import { MCP_PRESETS, type McpPreset } from "@/lib/ai/mcp/marketplace-presets";
import { secureFetch } from "@/lib/security/ssrf";

export const dynamic = "force-dynamic";

/** Shape returned for every marketplace item, curated or community. */
interface MarketplaceItem {
  id: string;
  name: string;
  description: string;
  category: string;
  transport: string;
  command?: string;
  args?: string[];
  envVars?: Array<{ name: string; description: string; required: boolean }>;
  isCommunity: boolean;
}

/** In-memory cache for the community registry listing (5-minute TTL). */
const COMMUNITY_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  items: MarketplaceItem[];
  expiresAt: number;
}

let communityCache: CacheEntry | null = null;

/**
 * Read the community registry URL from the environment.
 * Absent -> the endpoint returns curated presets only.
 */
function getCommunityRegistryUrl(): string | undefined {
  const url = process.env.MCP_COMMUNITY_REGISTRY_URL;
  if (!url || !url.trim()) return undefined;
  return url.trim();
}

/**
 * Fetch + validate the community registry listing through secureFetch,
 * caching results for COMMUNITY_CACHE_TTL_MS. On any failure, log and
 * return null so callers degrade to presets-only.
 */
async function fetchCommunityCatalog(): Promise<MarketplaceItem[] | null> {
  const registryUrl = getCommunityRegistryUrl();
  if (!registryUrl) return null;

  const now = Date.now();
  if (communityCache && now < communityCache.expiresAt) {
    return communityCache.items;
  }

  let response: Response;
  try {
    response = await secureFetch(registryUrl, { timeoutMs: 10_000 });
  } catch (err) {
    console.warn(
      "[api/mcp/marketplace] community MCP registry fetch failed; falling back to presets only:",
      registryUrl,
      err instanceof Error ? err.message : err
    );
    return null;
  }

  if (!response.ok) {
    console.warn(
      "[api/mcp/marketplace] community MCP registry returned non-OK; falling back to presets only:",
      response.status,
      response.statusText,
      registryUrl
    );
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    console.warn(
      "[api/mcp/marketplace] community MCP registry returned unparseable JSON; falling back to presets only:",
      registryUrl,
      err instanceof Error ? err.message : err
    );
    return null;
  }

  const items = Array.isArray(body) ? (body as unknown[]) : [];
  const entries: MarketplaceItem[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const id =
      typeof rec.id === "string" && rec.id
        ? rec.id
        : `community-${entries.length}`;
    const name = typeof rec.name === "string" && rec.name ? rec.name : undefined;
    const description =
      typeof rec.description === "string" ? rec.description : "";
    const category =
      typeof rec.category === "string" && rec.category
        ? rec.category
        : "Uncategorized";
    const transport = typeof rec.transport === "string" ? rec.transport : "http";
    if (!name) continue;
    entries.push({
      id,
      name,
      description,
      category,
      transport,
      command: typeof rec.command === "string" ? rec.command : undefined,
      args: Array.isArray(rec.args) ? rec.args : undefined,
      isCommunity: true,
    });
  }

  communityCache = { items: entries, expiresAt: now + COMMUNITY_CACHE_TTL_MS };
  return entries;
}

/**
 * Normalize a preset into the marketplace response shape.
 * `category` is lowercased so clients can filter case-insensitively.
 */
function presetToMarketplaceItem(preset: McpPreset): MarketplaceItem {
  return {
    id: preset.config.id,
    name: preset.name,
    description: preset.description,
    category: preset.category.toLowerCase(),
    transport: preset.config.transport,
    command: preset.config.command,
    args: preset.config.args,
    envVars: preset.envVars,
    isCommunity: false,
  };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const search = url.searchParams.get("q")?.trim() ?? "";
  const category = url.searchParams.get("category")?.trim() ?? "";
  const includeCommunity = url.searchParams.get("includeCommunity") === "1";

  const searchLower = search.toLowerCase();
  const categoryLower = category.toLowerCase();

  const filteredPresets = MCP_PRESETS.filter(
    (preset) =>
      (!categoryLower || preset.category.toLowerCase() === categoryLower) &&
      (!searchLower ||
        `${preset.name} ${preset.description}`.toLowerCase().includes(searchLower))
  );

  const presetItems = filteredPresets.map(presetToMarketplaceItem);

  let presets: MarketplaceItem[] = presetItems;
  let communityItems: MarketplaceItem[] = [];

  if (includeCommunity) {
    const fetched = await fetchCommunityCatalog();
    if (fetched) {
      const matched = fetched.filter(
        (item) =>
          (!categoryLower || item.category.toLowerCase() === categoryLower) &&
          (!searchLower ||
            `${item.name} ${item.description}`
              .toLowerCase()
              .includes(searchLower))
      );
      communityItems = matched;
      presets = [...presetItems, ...communityItems];
    }
  }

  return NextResponse.json({
    presets,
    community: communityItems,
    hasCommunity: communityItems.length > 0,
  });
}
