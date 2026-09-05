import * as fs from "node:fs/promises";
import * as path from "node:path";

export type CatalogEntry = {
  id: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  inputModalities?: ("text" | "image" | "audio" | "video" | "pdf")[];
  outputModalities?: ("text" | "image" | "audio" | "video" | "pdf")[];
  supportsToolCalls?: boolean | null;
  supportsReasoning?: boolean | null;
  [key: string]: any;
};

export type ModelsDevCatalog = {
  models: CatalogEntry[];
};

export type MatchConfidence = "exact" | "case-insensitive" | "normalized";

export type CatalogMatchResult = {
  entry: CatalogEntry;
  confidence: MatchConfidence;
  matchedId: string;
};

const CACHE_DIR = path.join(process.cwd(), "data", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "models-dev.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const KNOWN_PREFIX_REGEX =
  /^(openai|anthropic|google|meta|qwen|zhipuai|xai|mistral)\//i;
const DATE_SUFFIX_REGEX = /(-20\d{2}(-\d{2})?(-\d{2})?|-20\d{6})$/i;

/**
 * Fetch catalog from models.dev with 10s timeout, caching to data/cache/models-dev.json with 24h TTL.
 * On network failure, falls back to stale cache if present, otherwise returns { models: [] }.
 */
export async function getModelsDevCatalog(): Promise<ModelsDevCatalog> {
  try {
    const stat = await fs.stat(CACHE_FILE);
    if (Date.now() - stat.mtime.getTime() < CACHE_TTL_MS) {
      const raw = await fs.readFile(CACHE_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      return normalizeCatalog(parsed);
    }
  } catch {
    // Cache file missing or unreadable; proceed to fetch.
  }

  try {
    const res = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`models.dev returned status ${res.status}`);
    }
    const data = await res.json();
    const catalog = normalizeCatalog(data);

    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(CACHE_FILE, JSON.stringify(catalog), "utf-8");
    } catch {
      // Disk write failure shouldn't crash catalog consumption.
    }

    return catalog;
  } catch {
    // Network or parse error: try stale cache if available.
    try {
      const raw = await fs.readFile(CACHE_FILE, "utf-8");
      return normalizeCatalog(JSON.parse(raw));
    } catch {
      return { models: [] };
    }
  }
}

function normalizeCatalog(data: unknown): ModelsDevCatalog {
  if (Array.isArray(data)) {
    return { models: data as CatalogEntry[] };
  }
  if (
    data &&
    typeof data === "object" &&
    "models" in data &&
    Array.isArray((data as any).models)
  ) {
    return data as ModelsDevCatalog;
  }
  return { models: [] };
}

/**
 * Match a model ID against the models.dev catalog using a 3-level ladder:
 * 1. Exact match (case-sensitive) -> confidence: "exact"
 * 2. Case-insensitive exact match -> confidence: "case-insensitive"
 * 3. Normalized prefix/suffix strip (single candidate match) -> confidence: "normalized"
 * Never fuzzy matches. Returns null if 0 or >1 matches found.
 */
export function matchCatalogModel(
  modelId: string,
  catalog: ModelsDevCatalog
): CatalogMatchResult | null {
  if (!modelId || !catalog?.models?.length) {
    return null;
  }

  const trimmedId = modelId.trim();

  // 1. Exact match
  const exact = catalog.models.find((m) => m.id === trimmedId);
  if (exact) {
    return {
      entry: exact,
      confidence: "exact",
      matchedId: exact.id,
    };
  }

  // 2. Case-insensitive exact match
  const lowerId = trimmedId.toLowerCase();
  const caseInsensitive = catalog.models.find(
    (m) => m.id?.toLowerCase() === lowerId
  );
  if (caseInsensitive) {
    return {
      entry: caseInsensitive,
      confidence: "case-insensitive",
      matchedId: caseInsensitive.id,
    };
  }

  // 3. Normalized prefix-strip and date-suffix-strip
  const stripped = trimmedId
    .replace(KNOWN_PREFIX_REGEX, "")
    .replace(DATE_SUFFIX_REGEX, "");

  const strippedLower = stripped.toLowerCase();
  const normalizedMatches = catalog.models.filter(
    (m) => m.id?.toLowerCase() === strippedLower
  );

  if (normalizedMatches.length === 1) {
    const match = normalizedMatches[0];
    return {
      entry: match,
      confidence: "normalized",
      matchedId: match.id,
    };
  }

  return null;
}
