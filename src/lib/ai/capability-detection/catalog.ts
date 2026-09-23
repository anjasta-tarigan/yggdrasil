import * as fs from "node:fs/promises";
import * as path from "node:path";
import { inferKnownModelCapabilities } from "@/lib/ai/model-heuristics";

export { inferKnownModelCapabilities };

export type CatalogEntry = {
  id: string;
  name?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  inputModalities?: ("text" | "image" | "audio" | "video" | "pdf")[];
  outputModalities?: ("text" | "image" | "audio" | "video" | "pdf")[];
  supportsToolCalls?: boolean | null;
  supportsReasoning?: boolean | null;
  [key: string]: unknown;
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
  /^(openai|anthropic|google|meta|qwen|zhipuai|xai|mistral|deepseek|minimax|poolside|together|groq|cohere|nousresearch|01-ai)\//i;
const DATE_SUFFIX_REGEX = /(-20\d{2}(-\d{2})?(-\d{2})?|-20\d{6})$/i;
const CHANNEL_TAG_REGEX = /:(free|exact|preview|beta|extended|default|thinking|online|nitro)$/i;

/**
 * Normalize one raw upstream model entry (fields: limit.context,
 * limit.output, modalities.{input,output}, tool_call, reasoning,
 * attachment) into the CatalogEntry shape the detection pipeline reads.
 */
function toCatalogEntry(raw: Record<string, unknown>): CatalogEntry {
  const entry: CatalogEntry = { id: String(raw.id) };
  if (typeof raw.name === "string" && raw.name.trim()) {
    entry.name = raw.name.trim();
  }

  const limit = raw.limit as Record<string, unknown> | undefined;
  if (
    typeof limit === "object" &&
    limit !== null &&
    typeof limit.context === "number" &&
    limit.context > 0
  ) {
    entry.contextWindow = limit.context;
  }
  if (
    typeof limit === "object" &&
    limit !== null &&
    typeof limit.output === "number" &&
    limit.output > 0
  ) {
    entry.maxOutputTokens = limit.output;
  }

  const modalities = raw.modalities as Record<string, unknown> | undefined;
  if (
    typeof modalities === "object" &&
    modalities !== null &&
    Array.isArray(modalities.input) &&
    modalities.input.length > 0
  ) {
    entry.inputModalities = modalities.input;
  }
  if (
    typeof modalities === "object" &&
    modalities !== null &&
    Array.isArray(modalities.output) &&
    modalities.output.length > 0
  ) {
    entry.outputModalities = modalities.output;
  }

  if (typeof raw.tool_call === "boolean") {
    entry.supportsToolCalls = raw.tool_call;
  }
  if (typeof raw.reasoning === "boolean") {
    entry.supportsReasoning = raw.reasoning;
  }

  return entry;
}

/**
 * Normalize any models.dev payload (or cache) into the flat catalog shape.
 *
 * The live https://models.dev/api.json is a map of PROVIDER objects
 * ({"<providerId>": {id, name, models: {"<id>": {...}}}}), each model
 * carrying limit.context/output, modalities.input/output, tool_call and
 * reasoning. Older cache files hold the already-flat {models: [...]}
 * shape; both are accepted.
 */
export function normalizeCatalog(data: unknown): ModelsDevCatalog {
  // Provider-keyed map (the live api.json shape).
  if (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data)
  ) {
    const models: CatalogEntry[] = [];
    let sawProviderBlock = false;
    for (const provider of Object.values(data as Record<string, unknown>)) {
      const providerModels =
        typeof provider === "object" && provider !== null
          ? (provider as Record<string, unknown>).models
          : undefined;
      if (
        typeof providerModels !== "object" ||
        providerModels === null ||
        Array.isArray(providerModels)
      ) {
        continue;
      }
      sawProviderBlock = true;
      for (const raw of Object.values(
        providerModels as Record<string, unknown>,
      )) {
        if (typeof raw === "object" && raw !== null) {
          models.push(toCatalogEntry(raw as Record<string, unknown>));
        }
      }
    }
    if (sawProviderBlock) return { models };
  }

  // Already-flat shapes: the normalized cache written by this module, or
  // (legacy) a bare array.
  if (Array.isArray(data)) {
    return {
      models: data.filter(
        (m): m is CatalogEntry =>
          typeof m === "object" &&
          m !== null &&
          typeof (m as { id?: unknown }).id === "string"
      ),
    };
  }
  if (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as { models?: unknown }).models)
  ) {
    return {
      models: (data as { models: unknown[] }).models.filter(
        (m): m is CatalogEntry =>
          typeof m === "object" &&
          m !== null &&
          typeof (m as { id?: unknown }).id === "string"
      ),
    };
  }
  return { models: [] };
}

/**
 * Fetch catalog from models.dev with 10s timeout, caching to data/cache/models-dev.json with 24h TTL.
 * On network failure, falls back to stale cache if present, otherwise returns { models: [] }.
 *
 * An EMPTY cached catalog is treated as absent: a cache written by a
 * failed/degraded fetch (or an older parser) would otherwise pin an
 * empty Layer 1 for a full TTL.
 */
export async function getModelsDevCatalog(): Promise<ModelsDevCatalog> {
  let cached: ModelsDevCatalog | null = null;
  try {
    const stat = await fs.stat(CACHE_FILE);
    if (Date.now() - stat.mtime.getTime() < CACHE_TTL_MS) {
      const raw = await fs.readFile(CACHE_FILE, "utf-8");
      const parsed = normalizeCatalog(JSON.parse(raw));
      if (parsed.models.length > 0) {
        return parsed;
      }
      cached = parsed; // empty-but-valid cache: refetch below.
    } else {
      cached = normalizeCatalog(
        JSON.parse(await fs.readFile(CACHE_FILE, "utf-8")),
      );
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

    if (catalog.models.length > 0) {
      try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await fs.writeFile(CACHE_FILE, JSON.stringify(catalog), "utf-8");
      } catch (error) {
        // Disk write failure shouldn't crash catalog consumption.
        console.warn(
          "[capability-detection] models.dev cache write failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    return catalog;
  } catch (error) {
    // Network or parse error: fall back to the stale cache. The stat
    // branch may not have read it (ENOENT, stat failure, or an empty
    // fresh cache we deliberately skipped) — read it now.
    console.warn(
      "[capability-detection] models.dev fetch failed; using cached catalog:",
      error instanceof Error ? error.message : error,
    );
    if (cached === null) {
      try {
        cached = normalizeCatalog(
          JSON.parse(await fs.readFile(CACHE_FILE, "utf-8")),
        );
      } catch {
        // No usable cache — Layer 1 is skipped this run.
        cached = { models: [] };
      }
    }
    return cached.models.length > 0 ? cached : { models: [] };
  }
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

  // 3. Normalized candidate generation (progressive gateway prefix stripping,
  // channel tag stripping, and date suffix stripping)
  // Clean channel tags (e.g. ":free", ":beta", ":extended") first
  const cleanId = trimmedId.replace(CHANNEL_TAG_REGEX, "");

  const candidates: string[] = [];

  // If there's a channel tag removed, test the tag-cleaned ID
  if (cleanId !== trimmedId) {
    candidates.push(cleanId);
  }

  // Progressive segment stripping for multi-segment gateway IDs:
  // e.g. "xk/deepseek/deepseek-v4-pro" -> ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"]
  // e.g. "openrouter/minimax/minimax-m3" -> ["minimax/minimax-m3", "minimax-m3"]
  const segments = cleanId.split("/");
  if (segments.length > 1) {
    for (let i = 1; i < segments.length; i++) {
      const candidate = segments.slice(i).join("/");
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
  }

  // Known prefix regex stripping (e.g. "openai/gpt-4o" -> "gpt-4o")
  const strippedKnown = cleanId.replace(KNOWN_PREFIX_REGEX, "");
  if (!candidates.includes(strippedKnown)) {
    candidates.push(strippedKnown);
  }

  // Step 3a: Test each candidate for an exact or case-insensitive match (must be unique)
  for (const candidate of candidates) {
    const candLower = candidate.toLowerCase();
    const caseMatches = catalog.models.filter(
      (m) => m.id?.toLowerCase() === candLower
    );
    if (caseMatches.length === 1) {
      return {
        entry: caseMatches[0],
        confidence: "normalized",
        matchedId: caseMatches[0].id,
      };
    }
    if (caseMatches.length > 1) {
      // Ambiguous: multiple catalog models match this normalized candidate
      return null;
    }
  }

  // Step 3b: Strip date suffixes across candidates and find unique normalized matches
  for (const candidate of [cleanId, ...candidates]) {
    const strippedDate = candidate.replace(DATE_SUFFIX_REGEX, "").toLowerCase();
    const dateMatches = catalog.models.filter(
      (m) => m.id?.toLowerCase() === strippedDate
    );
    if (dateMatches.length === 1) {
      return {
        entry: dateMatches[0],
        confidence: "normalized",
        matchedId: dateMatches[0].id,
      };
    }
    if (dateMatches.length > 1) {
      return null;
    }
  }

  return null;
}
