import { NextResponse } from "next/server";
import { defaultModelId } from "@/lib/ai/provider";
import { chatTools } from "@/lib/ai/tools";
import { sanitizeMcpServerList } from "@/lib/ai/mcp/config";
import {
  getDatabaseStats,
  type DatabaseStats,
} from "@/lib/database-service";
import {
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
} from "@/lib/memory/embeddings";
import { getSettingsDb, setSettingsDb } from "@/lib/settings-service";
import {
  getWebSearchChain,
  isProviderCoolingDown,
  isProviderReady,
  type WebSearchProviderKind,
} from "@/lib/web-search";
import pkg from "../../../../package.json";

/**
 * Settings endpoint.
 *
 * GET returns a read-only snapshot of the server's effective
 * configuration for the Settings page (secrets reduced to flags) plus
 * the mutable settings store (providers, embedding, websearch) that the
 * client hydrates from.
 *
 * PUT persists changes to the settings store. Payloads are shape-
 * validated; invalid entries are rejected rather than stored.
 */

const TOOL_KEY_ENV: Record<string, string | undefined> = {
  web_fetch: "FIRECRAWL_API_KEY",
};

/** Canonical provider order used when the settings UI saves the chain. */
const WEB_SEARCH_KINDS: readonly WebSearchProviderKind[] = [
  "exa",
  "firecrawl",
  "searxng",
];

type SettingsKey = "providers" | "embedding" | "websearch" | "mcpServers";

type ProviderShape = {
  id: string;
  kind: "openai-compatible" | "ollama";
  name: string;
  baseUrl: string;
  apiKey?: string;
};

function isProviderShape(value: unknown): value is ProviderShape {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    p.id.length > 0 &&
    p.id.length <= 128 &&
    typeof p.name === "string" &&
    p.name.length > 0 &&
    p.name.length <= 128 &&
    typeof p.baseUrl === "string" &&
    /^https?:\/\//.test(p.baseUrl) &&
    p.baseUrl.length <= 2048 &&
    (p.kind === "openai-compatible" || p.kind === "ollama") &&
    (p.apiKey === undefined || typeof p.apiKey === "string")
  );
}

function sanitizeProvider(value: unknown): ProviderShape | null {
  if (!isProviderShape(value)) return null;
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    baseUrl: value.baseUrl,
    ...(value.kind === "openai-compatible" && value.apiKey !== undefined
      ? { apiKey: value.apiKey }
      : {}),
  };
}

/**
 * Validate the web search provider chain payload. Requires a non-empty,
 * bounded providers array with known kinds, boolean enabled flags and
 * optional bounded credentials. Duplicate kinds are rejected.
 */
function sanitizeWebSearchPayload(value: unknown): { providers: unknown[] } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const ws = value as Record<string, unknown>;
  if (
    !Array.isArray(ws.providers) ||
    ws.providers.length === 0 ||
    ws.providers.length > 10
  ) {
    return null;
  }

  const providers: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const entry of ws.providers) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const p = entry as Record<string, unknown>;
    if (
      typeof p.kind !== "string" ||
      !(WEB_SEARCH_KINDS as readonly string[]).includes(p.kind)
    ) {
      return null;
    }
    if (seen.has(p.kind)) return null;
    seen.add(p.kind);
    if (typeof p.enabled !== "boolean") return null;

    const clean: Record<string, unknown> = { kind: p.kind, enabled: p.enabled };
    if (p.apiKey !== undefined) {
      if (typeof p.apiKey !== "string" || p.apiKey.length > 2048) return null;
      if (p.apiKey) clean.apiKey = p.apiKey;
    }
    if (p.baseUrl !== undefined) {
      if (typeof p.baseUrl !== "string" || p.baseUrl.length > 2048) return null;
      // Empty string clears the override; non-empty must be http(s).
      if (p.baseUrl) {
        if (!/^https?:\/\//.test(p.baseUrl)) return null;
        clean.baseUrl = p.baseUrl;
      }
    }
    providers.push(clean);
  }
  return { providers };
}

/** Validate and normalize a PUT payload; returns null when invalid. */
function sanitizeSettingsPayload(
  body: unknown
): Record<SettingsKey, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const payload = body as Record<string, unknown>;
  const result: Partial<Record<SettingsKey, unknown>> = {};

  if (payload.providers !== undefined) {
    if (!Array.isArray(payload.providers) || payload.providers.length > 50) {
      return null;
    }
    const providers: ProviderShape[] = [];
    const seen = new Set<string>();
    for (const entry of payload.providers) {
      const clean = sanitizeProvider(entry);
      if (!clean || seen.has(clean.id)) return null;
      seen.add(clean.id);
      providers.push(clean);
    }
    result.providers = providers;
  }

  if (payload.embedding !== undefined) {
    if (
      typeof payload.embedding !== "object" ||
      payload.embedding === null ||
      Array.isArray(payload.embedding)
    ) {
      return null;
    }
    const emb = payload.embedding as Record<string, unknown>;
    const clean: Record<string, unknown> = {};

    if (emb.provider !== undefined) {
      if (
        emb.provider !== "server" &&
        emb.provider !== "openai-compatible" &&
        emb.provider !== "ollama"
      ) {
        return null;
      }
      clean.provider = emb.provider;
    }
    if (emb.baseUrl !== undefined) {
      if (
        typeof emb.baseUrl !== "string" ||
        !/^https?:\/\//.test(emb.baseUrl) ||
        emb.baseUrl.length > 2048
      ) {
        return null;
      }
      clean.baseUrl = emb.baseUrl;
    }
    if (emb.apiKey !== undefined) {
      if (typeof emb.apiKey !== "string" || emb.apiKey.length > 2048) {
        return null;
      }
      clean.apiKey = emb.apiKey;
    }
    if (emb.model !== undefined) {
      if (typeof emb.model !== "string") return null;
      const model = emb.model.trim().slice(0, 200);
      if (model) clean.model = model;
    }
    if (emb.dimensions !== undefined) {
      if (
        typeof emb.dimensions !== "number" ||
        !Number.isFinite(emb.dimensions) ||
        emb.dimensions < 1 ||
        emb.dimensions > 32768
      ) {
        return null;
      }
      clean.dimensions = Math.round(emb.dimensions);
    }
    if (emb.chunkSize !== undefined) {
      if (
        typeof emb.chunkSize !== "number" ||
        !Number.isFinite(emb.chunkSize) ||
        emb.chunkSize < MIN_CHUNK_SIZE ||
        emb.chunkSize > MAX_CHUNK_SIZE
      ) {
        return null;
      }
      clean.chunkSize = Math.round(emb.chunkSize);
    }
    if (emb.chunkOverlap !== undefined) {
      if (
        typeof emb.chunkOverlap !== "number" ||
        !Number.isFinite(emb.chunkOverlap) ||
        emb.chunkOverlap < 0 ||
        emb.chunkOverlap > 10000
      ) {
        return null;
      }
      clean.chunkOverlap = Math.round(emb.chunkOverlap);
    }

    // Overlap must stay at most half of the chunk size when both travel
    // together in one patch.
    if (
      typeof clean.chunkSize === "number" &&
      typeof clean.chunkOverlap === "number" &&
      clean.chunkOverlap > Math.floor(clean.chunkSize / 2)
    ) {
      return null;
    }

    // Ollama needs no API key.
    if (clean.provider === "ollama") delete clean.apiKey;

    result.embedding = clean;
  }

  if (payload.websearch !== undefined) {
    const clean = sanitizeWebSearchPayload(payload.websearch);
    if (!clean) return null;
    result.websearch = clean;
  }

  if (payload.mcpServers !== undefined) {
    const clean = sanitizeMcpServerList(payload.mcpServers);
    if (!clean) return null;
    result.mcpServers = clean;
  }

  // Require at least one known settings key; reject no-op payloads.
  if (Object.keys(result).length === 0) return null;

  return result as Record<SettingsKey, unknown>;
}

export async function GET() {
  const baseUrl = process.env.LLM_BASE_URL ?? null;
  const apiKeyConfigured = Boolean(process.env.LLM_API_KEY);

  // Live status of the multi-provider web search chain: per-provider
  // readiness plus the effective fallback order at this moment.
  const searchChain = getWebSearchChain();
  const webSearch = {
    providers: WEB_SEARCH_KINDS.map((kind) => {
      const entry = searchChain.find((p) => p.kind === kind);
      return {
        kind,
        enabled: entry?.enabled ?? false,
        ready: entry ? isProviderReady(entry) : false,
        coolingDown: isProviderCoolingDown(kind),
      };
    }),
    chain: searchChain
      .filter((p) => p.enabled && isProviderReady(p))
      .map((p) => p.kind),
  };

  const tools = Object.entries(chatTools).map(([name, tool]) => {
    const description =
      (tool as { description?: string }).description?.split("\n")[0] ?? "";
    if (name === "web_search") {
      return {
        name,
        description,
        configured: webSearch.chain.length > 0,
        requires: "EXA_API_KEY / FIRECRAWL_API_KEY / SEARXNG_BASE_URL (any)",
      };
    }
    const envKey = TOOL_KEY_ENV[name];
    return {
      name,
      description,
      configured: envKey ? Boolean(process.env[envKey]) : true,
      requires: envKey ?? null,
    };
  });

  let database: DatabaseStats;
  try {
    database = getDatabaseStats();
  } catch {
    // Database not initialized yet — report zeros rather than failing.
    database = {
      engine: "SQLite",
      driver: "better-sqlite3 + drizzle-orm",
      features: ["WAL", "FTS5", "sqlite-vec"],
      path: "",
      sizeBytes: 0,
      chatCount: 0,
      messageCount: 0,
      memories: { episodic: 0, semantic: 0, working: 0 },
      queue: { pending: 0, completed: 0, failed: 0 },
      cognitive: {
        daemonRunning: false,
        queueRunnerRunning: false,
        relations: 0,
        unembedded: { episodic: 0, semantic: 0 },
        lastRuns: [],
        lastFailure: null,
      },
    };
  }

  let store: Record<string, unknown> = {};
  try {
    store = getSettingsDb();
  } catch {
    // Database not initialized yet — report an empty store.
  }

  const storedEmbedding =
    typeof store.embedding === "object" && store.embedding !== null
      ? (store.embedding as Record<string, unknown>)
      : {};

  const storedWebSearch =
    typeof store.websearch === "object" && store.websearch !== null
      ? (store.websearch as Record<string, unknown>)
      : {};

  return NextResponse.json({
    ai: {
      baseUrl,
      modelId: defaultModelId,
      apiKeyConfigured,
    },
    embedding: {
      provider:
        storedEmbedding.provider === "ollama" ||
        storedEmbedding.provider === "openai-compatible"
          ? storedEmbedding.provider
          : "server",
      baseUrl:
        typeof storedEmbedding.baseUrl === "string"
          ? storedEmbedding.baseUrl
          : null,
      model:
        typeof storedEmbedding.model === "string" && storedEmbedding.model
          ? storedEmbedding.model
          : "text-embedding-3-small",
      apiKeyConfigured:
        storedEmbedding.provider === "openai-compatible"
          ? Boolean(storedEmbedding.apiKey)
          : apiKeyConfigured,
      dimensions:
        typeof storedEmbedding.dimensions === "number"
          ? storedEmbedding.dimensions
          : null,
      chunkSize:
        typeof storedEmbedding.chunkSize === "number"
          ? storedEmbedding.chunkSize
          : 2000,
      chunkOverlap:
        typeof storedEmbedding.chunkOverlap === "number"
          ? storedEmbedding.chunkOverlap
          : 200,
      fallback: "deterministic-hash-64d",
    },
    webSearch,
    database,
    tools,
    about: {
      name: "Yggdrasil",
      version: pkg.version,
      stack: "Next.js · AI SDK v7 · shadcn/ui · SQLite",
    },
    store: {
      providers: Array.isArray(store.providers) ? store.providers : [],
      embedding: storedEmbedding,
      websearch: storedWebSearch,
      mcpServers: Array.isArray(store.mcpServers) ? store.mcpServers : [],
    },
  });
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch = sanitizeSettingsPayload(body);
  if (!patch) {
    return NextResponse.json(
      { error: "Invalid settings payload" },
      { status: 400 }
    );
  }

  try {
    setSettingsDb(patch);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/settings] Failed to save settings:", error);
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}
