import { refreshEnv } from "@/env";
import { getSettingDb } from "@/lib/settings-service";
import {
  isPrivateOrBlockedIP,
  BLOCKED_HOSTNAMES,
  BLOCKED_HOSTNAME_SUFFIXES,
} from "@/lib/security/ssrf";
import net from "node:net";

/**
 * Multi-provider image search engine with automatic fallback,
 * quota cooldowns, SSRF defense, deduplication, and quality ranking.
 *
 * Supported providers:
 *  - exa       — Exa neural search with representative images and extras.imageLinks
 *  - searxng   — Self-hosted SearXNG instance image search (categories=images)
 *  - firecrawl — Firecrawl web scrape fallback extracting image references
 */

export type ImageSearchProviderKind = "exa" | "searxng" | "firecrawl";

export type ImageSearchProviderConfig = {
  kind: ImageSearchProviderKind;
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
};

export type ImageSearchResult = {
  title: string;
  image_url: string;
  thumbnail_url?: string;
  source_url?: string;
  source_name?: string;
  width?: number;
  height?: number;
  mime_type?: string;
  alt_text?: string;
  rank: number;
};

export type ImageSearchOptions = {
  query?: string;
  count?: number;
  safe_search?: boolean;
  preferred_domains?: string[];
  aspect_ratio?: "square" | "portrait" | "landscape" | "any";
  min_width?: number;
  min_height?: number;
  timeoutMs?: number;
};

export type ImageSearchAttempt = {
  provider: ImageSearchProviderKind;
  ok: boolean;
  error?: string;
};

export type ImageSearchOutcome = {
  query: string;
  provider: ImageSearchProviderKind;
  results: ImageSearchResult[];
  attempts: ImageSearchAttempt[];
};

export const QUOTA_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_TIMEOUT_MS = 10_000;
const QUOTA_STATUSES = new Set([401, 402, 403, 429]);

const cooldownUntil = new Map<ImageSearchProviderKind, number>();

export function resetImageSearchCooldowns(): void {
  cooldownUntil.clear();
}

export function isImageProviderCoolingDown(
  kind: ImageSearchProviderKind,
  now: number = Date.now()
): boolean {
  const until = cooldownUntil.get(kind);
  return until !== undefined && until > now;
}

function setImageCooldown(
  kind: ImageSearchProviderKind,
  now: number = Date.now()
) {
  cooldownUntil.set(kind, now + QUOTA_COOLDOWN_MS);
}

class ProviderError extends Error {
  constructor(
    message: string,
    readonly quota: boolean
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// ── Sanitization & SSRF Defenses ──────────────────────────────────────

/** Strip script/style tags, HTML tags and excessive whitespace, bounding output length. */
export function sanitizeText(text: string | undefined | null, maxLength = 300): string {
  if (!text) return "";
  const cleaned = text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/** Remove tracking tokens from image URLs without breaking essential parameters. */
export function cleanImageUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const trackingKeys = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "msclkid",
      "_ga",
      "ref",
      "source",
    ];
    for (const key of trackingKeys) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch (err) {
    console.debug(`[image-search] Error: ${err instanceof Error ? err.message : String(err)}`);
    return rawUrl;
  }
}

/** Strictly validate that an image URL uses http(s) and does not point to internal/blocked targets. */
export function isSafeImageUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const host = parsed.hostname.toLowerCase();
    if (!host) return false;

    if (BLOCKED_HOSTNAMES.has(host)) return false;
    for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
      if (host.endsWith(suffix)) return false;
    }

    // If host is a numeric IP (IPv4 or IPv6), verify it is not private/blocked
    if (net.isIP(host) !== 0) {
      if (isPrivateOrBlockedIP(host)) {
        return false;
      }
    }

    return true;
  } catch (err) {
    console.debug(`[image-search] Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function extractHostname(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.replace(/^www\./i, "");
  } catch (err) {
    console.debug(`[image-search] Error: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

// ── Filtering, Deduplication & Ranking ─────────────────────────────────

export function matchesAspectRatio(
  result: ImageSearchResult,
  aspectRatio?: "square" | "portrait" | "landscape" | "any"
): boolean {
  if (!aspectRatio || aspectRatio === "any") return true;
  if (!result.width || !result.height) return true; // Keep if dimensions unknown

  const { width, height } = result;
  switch (aspectRatio) {
    case "landscape":
      return width > height;
    case "portrait":
      return height > width;
    case "square":
      return Math.abs(width - height) / Math.max(width, height) <= 0.15;
    default:
      return true;
  }
}

export function matchesDimensions(
  result: ImageSearchResult,
  minWidth?: number,
  minHeight?: number
): boolean {
  if (minWidth && result.width && result.width < minWidth) return false;
  if (minHeight && result.height && result.height < minHeight) return false;
  return true;
}

// ── Source Authority Hierarchy ────────────────────────────────────────

const TIER_1_TLDS = [".gov", ".mil", ".edu", ".ac.uk"];

const TIER_1_DOMAINS = new Set([
  // Museums, archives, institutional collections
  "loc.gov",
  "si.edu",
  "archives.gov",
  "nasa.gov",
  "computerhistory.org",
  "sciencehistory.org",
  "bl.uk",
  "bnf.fr",
  "rijksmuseum.nl",
  "metmuseum.org",
  "louvre.fr",
  "cern.ch",
  "smithsonianmag.com",
  // Major official technology / primary manufacturer domains
  "nvidia.com",
  "apple.com",
  "microsoft.com",
  "intel.com",
  "amd.com",
  "sony.com",
  "sony.net",
  "toyota.com",
  "bmw.com",
  "porsche.com",
  "spacex.com",
  "boeing.com",
  "airbus.com",
  "canon.com",
  "nikon.com",
  "ibm.com",
]);

const TIER_2_DOMAINS = new Set([
  // Reputable reference and encyclopedic organizations
  "wikimedia.org",
  "wikipedia.org",
  "britannica.com",
  "nationalgeographic.com",
  "nature.com",
  "scientificamerican.com",
  // Established journalism & tech publications
  "theverge.com",
  "wired.com",
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "nytimes.com",
  "wsj.com",
  "arstechnica.com",
  "tomshardware.com",
  "anandtech.com",
  "theguardian.com",
  "economist.com",
  "ieee.org",
  "acm.org",
]);

const PENALIZED_DOMAINS = new Set([
  // Social media & image boards
  "pinterest.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "quora.com",
  "reddit.com",
  // Watermarked stock photo aggregators
  "alamy.com",
  "shutterstock.com",
  "gettyimages.com",
  "stock.adobe.com",
  "dreamstime.com",
  "depositphotos.com",
  "istockphoto.com",
  "123rf.com",
]);

export function classifySourceTier(
  domain: string,
  preferredDomains: string[] = []
): { tier: 1 | 2 | 3 | -1; score: number } {
  const norm = domain.toLowerCase().replace(/^www\./, "");

  // Preferred domains explicitly designated in the query or configuration
  if (preferredDomains.some((d) => norm.includes(d.toLowerCase()))) {
    return { tier: 1, score: 100 };
  }

  // Check penalized aggregators & watermarked sites first
  for (const pen of PENALIZED_DOMAINS) {
    if (norm === pen || norm.endsWith(`.${pen}`)) {
      return { tier: -1, score: -50 };
    }
  }

  // Tier 1 TLDs (.gov, .edu, etc.)
  if (TIER_1_TLDS.some((tld) => norm.endsWith(tld))) {
    return { tier: 1, score: 100 };
  }

  // Tier 1 exact or subdomain
  for (const t1 of TIER_1_DOMAINS) {
    if (norm === t1 || norm.endsWith(`.${t1}`)) {
      return { tier: 1, score: 100 };
    }
  }

  // Tier 2 exact or subdomain
  for (const t2 of TIER_2_DOMAINS) {
    if (norm === t2 || norm.endsWith(`.${t2}`)) {
      return { tier: 2, score: 50 };
    }
  }

  // Tier 3: General websites
  return { tier: 3, score: 10 };
}

export function scoreImageCandidate(
  item: ImageSearchResult,
  query: string,
  preferredDomains: string[] = []
): number {
  const host = extractHostname(item.source_url) ?? "";
  const { score: tierScore } = classifySourceTier(host, preferredDomains);

  let totalScore = tierScore;

  // Query token matching in title or alt text
  if (query) {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    const textToMatch = `${item.title} ${item.alt_text ?? ""}`.toLowerCase();
    let matches = 0;
    for (const token of tokens) {
      if (textToMatch.includes(token)) {
        matches++;
      }
    }
    totalScore += Math.min(matches * 10, 40);
  }

  // Resolution and quality scoring
  if (item.width && item.height) {
    if (item.width < 200 || item.height < 200) {
      totalScore -= 40; // Penalize tiny icons
    } else if (item.width >= 600 && item.height >= 400 && item.width <= 3000) {
      totalScore += 20; // Reward crisp hero images
    }

    const ratio = item.width / item.height;
    if (ratio > 3.5 || ratio < 0.28) {
      totalScore -= 20; // Penalize extreme banners or vertical strips
    }
  }

  // Provider initial rank adjustment (slight penalty for lower ranks from search engine)
  if (item.rank) {
    totalScore -= Math.min(item.rank * 2, 20);
  }

  return totalScore;
}

export function isNearDuplicate(
  a: ImageSearchResult,
  b: ImageSearchResult
): boolean {
  if (a.image_url === b.image_url) return true;

  // Check file name from URL path
  const getFilename = (urlStr: string) => {
    try {
      const pathname = new URL(urlStr).pathname;
      const base = pathname.split("/").pop() ?? "";
      return base.toLowerCase().replace(/[-_]/g, "").replace(/\.[^.]+$/, "");
    } catch (err) {
      console.debug(`[image-search] Error: ${err instanceof Error ? err.message : String(err)}`);
      return "";
    }
  };

  const fnA = getFilename(a.image_url);
  const fnB = getFilename(b.image_url);
  if (fnA && fnB && fnA.length > 5 && fnA === fnB) {
    return true;
  }

  // Check same domain and near-identical title
  const hostA = extractHostname(a.source_url);
  const hostB = extractHostname(b.source_url);
  if (hostA && hostA === hostB) {
    const cleanA = a.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    const cleanB = b.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      cleanA &&
      cleanB &&
      (cleanA === cleanB || cleanA.includes(cleanB) || cleanB.includes(cleanA))
    ) {
      return true;
    }
  }

  return false;
}

export function deduplicateAndRankResults(
  results: ImageSearchResult[],
  options: ImageSearchOptions = {}
): ImageSearchResult[] {
  const preferredDomains = (options.preferred_domains ?? []).map((d) =>
    d.toLowerCase().replace(/^www\./i, "").trim()
  );
  const query = options.query ?? "";

  // Group by normalized image URL (ignoring minor query difference)
  const byUrl = new Map<string, ImageSearchResult>();

  for (const item of results) {
    if (!isSafeImageUrl(item.image_url)) continue;
    if (item.source_url && !isSafeImageUrl(item.source_url)) continue;
    if (item.thumbnail_url && !isSafeImageUrl(item.thumbnail_url)) {
      item.thumbnail_url = undefined;
    }

    if (!matchesAspectRatio(item, options.aspect_ratio)) continue;
    if (!matchesDimensions(item, options.min_width, options.min_height)) continue;

    const cleanedUrl = cleanImageUrl(item.image_url);
    const existing = byUrl.get(cleanedUrl);

    if (!existing) {
      byUrl.set(cleanedUrl, { ...item, image_url: cleanedUrl });
    } else {
      // If duplicate found, keep the one with higher score
      const existingScore = scoreImageCandidate(existing, query, preferredDomains);
      const currentScore = scoreImageCandidate(item, query, preferredDomains);

      if (currentScore > existingScore) {
        byUrl.set(cleanedUrl, { ...item, image_url: cleanedUrl });
      }
    }
  }

  const list = Array.from(byUrl.values());

  // Score and rank all candidates
  list.sort((a, b) => {
    const scoreA = scoreImageCandidate(a, query, preferredDomains);
    const scoreB = scoreImageCandidate(b, query, preferredDomains);
    return scoreB - scoreA;
  });

  if (list.length === 0) return [];

  // Determine selection count:
  // For normal requests, default to 2 candidates max.
  // If explicitly requested (options.count > 2), allow up to options.count.
  const targetCount = options.count ?? 2;

  // Build distinct selection ensuring near-duplicates are eliminated
  const selected: ImageSearchResult[] = [];
  for (const candidate of list) {
    // Check if near duplicate of any already selected candidate
    const isDup = selected.some((prev) => isNearDuplicate(prev, candidate));
    if (!isDup) {
      selected.push(candidate);
      if (selected.length >= targetCount) break;
    }
  }

  return selected.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

// ── Provider Configuration ───────────────────────────────────────────

export function getImageSearchChain(): ImageSearchProviderConfig[] {
  let stored: unknown;
  try {
    stored = getSettingDb("websearch");
  } catch (err) {
    console.debug(`[image-search] Error: ${err instanceof Error ? err.message : String(err)}`);
    stored = undefined;
  }

  if (
    typeof stored === "object" &&
    stored !== null &&
    Array.isArray((stored as { providers?: unknown }).providers)
  ) {
    const providers = (stored as { providers: unknown[] }).providers
      .filter((p): p is ImageSearchProviderConfig => {
        if (typeof p !== "object" || p === null) return false;
        const row = p as Record<string, unknown>;
        return (
          (row.kind === "exa" ||
            row.kind === "searxng" ||
            row.kind === "firecrawl") &&
          typeof row.enabled === "boolean"
        );
      })
      .map((p) => ({
        kind: p.kind,
        enabled: p.enabled,
        apiKey: typeof p.apiKey === "string" && p.apiKey ? p.apiKey : undefined,
        baseUrl:
          typeof p.baseUrl === "string" && p.baseUrl ? p.baseUrl : undefined,
      }));
    if (providers.length > 0) return providers;
  }

  const runtimeEnv = refreshEnv();
  const defaults: ImageSearchProviderConfig[] = [];
  if (runtimeEnv.EXA_API_KEY) {
    defaults.push({ kind: "exa", enabled: true });
  }
  if (runtimeEnv.SEARXNG_BASE_URL) {
    defaults.push({
      kind: "searxng",
      enabled: true,
      baseUrl: runtimeEnv.SEARXNG_BASE_URL,
    });
  }
  if (runtimeEnv.FIRECRAWL_API_KEY) {
    defaults.push({ kind: "firecrawl", enabled: true });
  }
  return defaults;
}

export function isImageSearchConfigured(): boolean {
  const chain = getImageSearchChain();
  return chain.some((p) => p.enabled);
}

// ── Provider Fetch Adapters ───────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function searchExaImages(
  query: string,
  options: ImageSearchOptions,
  config: ImageSearchProviderConfig,
  timeoutMs: number
): Promise<ImageSearchResult[]> {
  const apiKey = config.apiKey || refreshEnv().EXA_API_KEY;
  if (!apiKey) throw new ProviderError("Exa API key not configured", false);

  const fetchCount = Math.min(Math.max((options.count ?? 4) * 2, 6), 20);

  const bodyPayload: Record<string, unknown> = {
    query,
    numResults: fetchCount,
    contents: {
      extras: { imageLinks: 4 },
    },
  };

  if (options.preferred_domains && options.preferred_domains.length > 0) {
    bodyPayload.includeDomains = options.preferred_domains;
  }

  const res = await fetchWithTimeout(
    "https://api.exa.ai/search",
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyPayload),
    },
    timeoutMs
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(
      `Exa search failed (${res.status}): ${body.slice(0, 200)}`,
      QUOTA_STATUSES.has(res.status)
    );
  }

  const data = (await res.json()) as {
    results?: Array<{
      id?: string;
      title?: string;
      url?: string;
      image?: string;
      extras?: { imageLinks?: string[] };
    }>;
  };

  const results: ImageSearchResult[] = [];
  let rankIndex = 1;

  for (const item of data.results ?? []) {
    const sourceUrl = item.url ?? item.id;
    const sourceName = extractHostname(sourceUrl);
    const title = sanitizeText(item.title ?? "Image result");

    // 1. Primary representative image
    if (item.image && isSafeImageUrl(item.image)) {
      results.push({
        title,
        image_url: cleanImageUrl(item.image),
        source_url: sourceUrl,
        source_name: sourceName,
        alt_text: title,
        rank: rankIndex++,
      });
    }

    // 2. Additional image links from extras
    if (Array.isArray(item.extras?.imageLinks)) {
      for (const link of item.extras.imageLinks) {
        if (typeof link === "string" && isSafeImageUrl(link)) {
          results.push({
            title,
            image_url: cleanImageUrl(link),
            source_url: sourceUrl,
            source_name: sourceName,
            alt_text: title,
            rank: rankIndex++,
          });
        }
      }
    }
  }

  return results;
}

async function searchSearxngImages(
  query: string,
  options: ImageSearchOptions,
  config: ImageSearchProviderConfig,
  timeoutMs: number
): Promise<ImageSearchResult[]> {
  const baseUrl = config.baseUrl || refreshEnv().SEARXNG_BASE_URL;
  if (!baseUrl) {
    throw new ProviderError("SearXNG instance URL not configured", false);
  }
  // The endpoint comes from user settings, so it is untrusted input: validate
  // it with the same SSRF rules applied to result URLs, otherwise a configured
  // baseUrl could point the server at loopback/private ranges (metadata
  // services, internal admin ports).
  if (!isSafeImageUrl(baseUrl)) {
    throw new ProviderError(
      "SearXNG instance URL is blocked by the SSRF policy",
      false
    );
  }
  const base = baseUrl.replace(/\/$/, "");

  // Safe search value for SearXNG (0 = off, 1 = moderate, 2 = strict)
  const safeSearchVal = options.safe_search === false ? "0" : "1";

  const params = new URLSearchParams({
    q: query,
    format: "json",
    categories: "images",
    pageno: "1",
    safesearch: safeSearchVal,
  });

  const res = await fetchWithTimeout(
    `${base}/search?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Yggdrasil/0.1 (self-hosted assistant; image_search tool)",
      },
    },
    timeoutMs
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(
      `SearXNG search failed (${res.status}): ${body.slice(0, 200)}`,
      QUOTA_STATUSES.has(res.status)
    );
  }

  type SearxngRow = {
    title?: string;
    url?: string;
    img_src?: string;
    thumbnail_src?: string;
    thumbnail?: string;
    source?: string;
    content?: string;
    resolution?: string;
  };

  let data: { results?: SearxngRow[] };
  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    console.debug(`[image-search] Error: ${err instanceof Error ? err.message : String(err)}`);
    throw new ProviderError(
      "SearXNG returned a non-JSON response — enable the JSON format in settings.yml",
      false
    );
  }

  const results: ImageSearchResult[] = [];
  let rankIndex = 1;

  for (const item of data.results ?? []) {
    const imageUrl = item.img_src || item.thumbnail_src || item.thumbnail;
    if (!imageUrl || !isSafeImageUrl(imageUrl)) continue;

    let width: number | undefined;
    let height: number | undefined;
    if (typeof item.resolution === "string") {
      const match = item.resolution.match(/(\d+)\s*x\s*(\d+)/i);
      if (match) {
        width = parseInt(match[1], 10);
        height = parseInt(match[2], 10);
      }
    }

    const title = sanitizeText(item.title ?? item.content ?? "Image result");
    const sourceUrl = item.url;
    const sourceName = extractHostname(sourceUrl) ?? item.source;

    results.push({
      title,
      image_url: cleanImageUrl(imageUrl),
      thumbnail_url: item.thumbnail_src || item.thumbnail,
      source_url: sourceUrl,
      source_name: sourceName,
      width,
      height,
      alt_text: sanitizeText(item.content ?? title),
      rank: rankIndex++,
    });
  }

  return results;
}

async function searchFirecrawlImages(
  query: string,
  options: ImageSearchOptions,
  config: ImageSearchProviderConfig,
  timeoutMs: number
): Promise<ImageSearchResult[]> {
  const apiKey = config.apiKey || refreshEnv().FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new ProviderError("Firecrawl API key not configured", false);
  }
  // Settings-supplied endpoint: validate against the SSRF policy before use,
  // for the same reason as the SearXNG adapter above.
  const firecrawlBase = config.baseUrl || "https://api.firecrawl.dev";
  if (!isSafeImageUrl(firecrawlBase)) {
    throw new ProviderError(
      "Firecrawl instance URL is blocked by the SSRF policy",
      false
    );
  }
  const base = firecrawlBase.replace(/\/$/, "");

  const fetchCount = Math.min(Math.max((options.count ?? 4) * 2, 6), 15);

  const res = await fetchWithTimeout(
    `${base}/v2/search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        limit: fetchCount,
        sources: ["web"],
      }),
    },
    timeoutMs
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(
      `Firecrawl search failed (${res.status}): ${body.slice(0, 200)}`,
      QUOTA_STATUSES.has(res.status)
    );
  }

  type FirecrawlRow = {
    title?: string;
    description?: string;
    url?: string;
    metadata?: { ogImage?: string };
  };

  const data = (await res.json()) as {
    success?: boolean;
    error?: string;
    data?: FirecrawlRow[] | { web?: FirecrawlRow[] };
  };

  if (data.success === false) {
    throw new ProviderError(
      `Firecrawl search error: ${data.error || "unknown error"}`,
      false
    );
  }

  const rows: FirecrawlRow[] = Array.isArray(data.data)
    ? data.data
    : (data.data?.web ?? []);

  const results: ImageSearchResult[] = [];
  let rankIndex = 1;

  for (const row of rows) {
    if (!row.url) continue;
    const sourceUrl = row.url;
    const sourceName = extractHostname(sourceUrl);
    const title = sanitizeText(row.title ?? "Image result");

    // 1. Check ogImage in metadata
    if (row.metadata?.ogImage && isSafeImageUrl(row.metadata.ogImage)) {
      results.push({
        title,
        image_url: cleanImageUrl(row.metadata.ogImage),
        source_url: sourceUrl,
        source_name: sourceName,
        alt_text: title,
        rank: rankIndex++,
      });
    }

    // 2. Extract markdown image references: ![alt](url)
    const text = row.description ?? "";
    const mdImageRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s\)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = mdImageRegex.exec(text)) !== null) {
      const alt = sanitizeText(match[1]);
      const imgUrl = match[2];
      if (isSafeImageUrl(imgUrl)) {
        results.push({
          title: alt || title,
          image_url: cleanImageUrl(imgUrl),
          source_url: sourceUrl,
          source_name: sourceName,
          alt_text: alt || title,
          rank: rankIndex++,
        });
      }
    }
  }

  return results;
}

const PROVIDER_FNS: Record<
  ImageSearchProviderKind,
  (
    query: string,
    options: ImageSearchOptions,
    config: ImageSearchProviderConfig,
    timeoutMs: number
  ) => Promise<ImageSearchResult[]>
> = {
  exa: searchExaImages,
  searxng: searchSearxngImages,
  firecrawl: searchFirecrawlImages,
};

// ── Fallback Chain Orchestrator ───────────────────────────────────────

export async function runImageSearch(
  query: string,
  options: ImageSearchOptions = {}
): Promise<ImageSearchOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chain = getImageSearchChain();
  const attempts: ImageSearchAttempt[] = [];

  if (chain.length === 0) {
    throw new Error(
      "No image search providers configured. Add an API key (EXA_API_KEY / FIRECRAWL_API_KEY) or SEARXNG_BASE_URL."
    );
  }

  for (const provider of chain) {
    if (!provider.enabled) continue;

    if (isImageProviderCoolingDown(provider.kind)) {
      attempts.push({
        provider: provider.kind,
        ok: false,
        error: "skipped (quota cooldown)",
      });
      continue;
    }

    try {
      const rawResults = await PROVIDER_FNS[provider.kind](
        query,
        options,
        provider,
        timeoutMs
      );

      const deduplicated = deduplicateAndRankResults(rawResults, {
        ...options,
        query,
      });

      if (deduplicated.length === 0) {
        attempts.push({
          provider: provider.kind,
          ok: false,
          error: "no results",
        });
        continue;
      }

      attempts.push({ provider: provider.kind, ok: true });
      return {
        query,
        provider: provider.kind,
        results: deduplicated,
        attempts,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ProviderError && error.quota) {
        setImageCooldown(provider.kind);
      }
      attempts.push({ provider: provider.kind, ok: false, error: message });
    }
  }

  const summary = attempts
    .map((a) => `${a.provider}: ${a.ok ? "ok" : a.error}`)
    .join("; ");
  throw new Error(
    attempts.length === 0
      ? "No enabled image search providers — enable at least one provider in Settings → Tools."
      : `All image search providers failed — ${summary}`
  );
}
