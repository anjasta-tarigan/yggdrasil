import { NextRequest, NextResponse } from "next/server";
import { secureFetch } from "@/lib/security/ssrf";

export const dynamic = "force-dynamic";

/** Shape returned for every marketplace item from the live Smithery registry. */
export interface MarketplaceItem {
  id: string;
  qualifiedName: string;
  name: string;
  description: string;
  category: string;
  transport: "http" | "stdio";
  command?: string;
  deploymentUrl?: string;
  iconUrl?: string;
  homepage?: string;
  verified: boolean;
  useCount?: number;
  score?: number | null;
}

/** In-memory cache for the Smithery registry queries (5-minute TTL). */
const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  items: MarketplaceItem[];
  expiresAt: number;
}

const registryCache = new Map<string, CacheEntry>();

const SMITHERY_API_BASE = "https://api.smithery.ai";

/**
 * Fetch public servers from Smithery through secureFetch.
 * Uses verified: true by default to guarantee vetted, trusted sources.
 */
async function fetchSmitheryServers(options: {
  q?: string;
  verifiedOnly?: boolean;
  pageSize?: number;
}): Promise<MarketplaceItem[]> {
  const { q = "", verifiedOnly = true, pageSize = 30 } = options;
  const cacheKey = `q=${q}:verified=${verifiedOnly}:size=${pageSize}`;

  const cached = registryCache.get(cacheKey);
  const now = Date.now();
  if (cached && now < cached.expiresAt) {
    return cached.items;
  }

  const queryParams = new URLSearchParams();
  if (q.trim()) {
    queryParams.set("q", q.trim());
  }
  if (verifiedOnly) {
    queryParams.set("verified", "true");
  }
  queryParams.set("pageSize", String(pageSize));

  const targetUrl = `${SMITHERY_API_BASE}/servers?${queryParams.toString()}`;

  let response: Response;
  try {
    response = await secureFetch(targetUrl, {
      timeoutMs: 10_000,
      headers: {
        Accept: "application/json",
        "User-Agent": "Yggdrasil-MCP-Marketplace/1.0",
      },
    });
  } catch (err) {
    console.warn(
      "[api/mcp/marketplace] Smithery registry fetch failed; degrading gracefully:",
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }

  if (!response.ok) {
    console.warn(
      `[api/mcp/marketplace] Smithery registry returned HTTP ${response.status}: ${response.statusText}`
    );
    return [];
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    console.warn(
      "[api/mcp/marketplace] Smithery registry returned invalid JSON:",
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }

  if (typeof body !== "object" || body === null) {
    return [];
  }

  const servers = Array.isArray((body as { servers?: unknown }).servers)
    ? ((body as { servers: Record<string, unknown>[] }).servers)
    : [];

  const items: MarketplaceItem[] = [];
  for (const s of servers) {
    if (typeof s !== "object" || s === null) continue;
    const qualifiedName = typeof s.qualifiedName === "string" ? s.qualifiedName : "";
    if (!qualifiedName) continue;

    const id = typeof s.id === "string" ? s.id : qualifiedName;
    const name = typeof s.displayName === "string" && s.displayName ? s.displayName : qualifiedName;
    const description = typeof s.description === "string" ? s.description : "";
    const verified = s.verified === true;
    const useCount = typeof s.useCount === "number" ? s.useCount : undefined;
    const score = typeof s.score === "number" ? s.score : null;
    const iconUrl = typeof s.iconUrl === "string" ? s.iconUrl : undefined;
    const homepage = typeof s.homepage === "string" ? s.homepage : undefined;
    const isRemote = s.remote === true || s.isDeployed === true;
    const deploymentUrl = typeof s.deploymentUrl === "string" ? s.deploymentUrl : undefined;

    // Categorization heuristic based on name / description keywords
    let category = "productivity";
    const text = `${qualifiedName} ${name} ${description}`.toLowerCase();
    if (/database|sql|postgres|mysql|sqlite|redis|mongodb|vector/i.test(text)) {
      category = "database";
    } else if (/git|github|gitlab|docker|code|dev|debug|terminal|syntax/i.test(text)) {
      category = "development";
    } else if (/search|browse|web|crawl|fetch|scrape|puppeteer|browser/i.test(text)) {
      category = "web";
    } else if (/system|file|os|disk|memory|shell|bash|process/i.test(text)) {
      category = "system";
    }

    items.push({
      id,
      qualifiedName,
      name,
      description,
      category,
      transport: isRemote && deploymentUrl ? "http" : "stdio",
      deploymentUrl,
      iconUrl,
      homepage,
      verified,
      useCount,
      score,
    });
  }

  registryCache.set(cacheKey, { items, expiresAt: now + CACHE_TTL_MS });
  return items;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const search = url.searchParams.get("q")?.trim() ?? "";
  const category = url.searchParams.get("category")?.trim().toLowerCase() ?? "";
  // Safety default: only trusted & verified servers unless user opts out
  const verifiedOnly = url.searchParams.get("verifiedOnly") !== "false";

  const allItems = await fetchSmitheryServers({
    q: search,
    verifiedOnly,
    pageSize: 30,
  });

  const filtered = category && category !== "all"
    ? allItems.filter((item) => item.category === category)
    : allItems;

  return NextResponse.json({
    servers: filtered,
    total: filtered.length,
    source: "smithery.ai",
    verifiedOnly,
  });
}
