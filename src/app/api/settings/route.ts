import { NextResponse } from "next/server";
import { chatTools } from "@/lib/ai/tools";
import {
  getDisabledTools,
  PROTECTED_TOOLS,
  sanitizeDisabledTools,
} from "@/lib/ai/tool-toggles";
import { sanitizeMcpServerList, slugifyServerName, type McpServerConfig } from "@/lib/ai/mcp/config";
import { getMcpStatusMap } from "@/lib/ai/mcp/manager";
import { maskMcpServerConfig } from "@/lib/ai/mcp/secrets";
import {
  getDatabaseStats,
  type DatabaseStats,
} from "@/lib/database-service";
import { applyRegistryPatch } from "@/lib/ai/provider-config/api-helpers";
import {
  getRegistryView,
  loadRegistry,
  ProviderConfigError,
} from "@/lib/ai/provider-config/store";
import { getSettingsDb, getSettingDb, setSettingsDb } from "@/lib/settings-service";
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
 *
 * `providers` and `embedding` are no longer settings-store keys: they
 * live in the provider registry, and PUT patches are delegated to
 * `applyRegistryPatch` (the same SSOT path /api/providers writes
 * through) after being merged onto the current registry document.
 */

const TOOL_KEY_ENV: Record<string, string | undefined> = {
  web_fetch: "FIRECRAWL_API_KEY",
};

/** Settings key under which the last-known embedding model is persisted. */
const EMBEDDING_MODEL_KEY = "embedding_model";

/**
 * Settings key under which the embedding model-change confirmation flag is
 * persisted. When the PUT handler detects a model change, it sets this key
 * to the new model; the GET handler surfaces it once so the client can show
 * a confirmation dialog, then clears it.
 */
const EMBEDDING_MODEL_CHANGED_KEY = "embedding_model_changed";

/** Read the last-known embedding model tag from the settings store. */
function getStoredEmbeddingModel(): string | null {
  const stored = getSettingDb(EMBEDDING_MODEL_KEY);
  return typeof stored === "string" && stored.length > 0 ? stored : null;
}

/**
 * Read the embedding model that would be used by `generateEmbedding` for the
 * resolved embedding model. Mirrors resolveEmbeddingModel from the memory
 * module but resolves server-side from the provider registry.
 */
async function resolveLiveEmbeddingModel(): Promise<string> {
  const { resolveEmbeddingModel } = await import("@/lib/memory/embeddings");
  return resolveEmbeddingModel();
}

/**
 * Check whether the current live embedding model differs from the stored one.
 * Returns { oldModel, newModel } when changed, or null when unchanged.
 */
async function checkEmbeddingModelChange(): Promise<
  { oldModel: string | null; newModel: string } | null
> {
  const stored = getStoredEmbeddingModel();
  const live = await resolveLiveEmbeddingModel();
  const liveClean = live.length > 0 ? live : null;
  if (stored !== liveClean) {
    return { oldModel: stored, newModel: live };
  }
  return null;
}

/** Canonical provider order used when the settings UI saves the chain. */
const WEB_SEARCH_KINDS: readonly WebSearchProviderKind[] = [
  "exa",
  "firecrawl",
  "searxng",
];

type SettingsKey = "websearch" | "mcpServers" | "toolToggles" | "reasoning_effort";

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

  if (payload.toolToggles !== undefined) {
    // Pure validation via the lib (known names only, protected tools
    // rejected); persistence happens once below through setSettingsDb.
    if (
      typeof payload.toolToggles !== "object" ||
      payload.toolToggles === null ||
      Array.isArray(payload.toolToggles)
    ) {
      return null;
    }
    const disabled = (payload.toolToggles as { disabled?: unknown })
      .disabled;
    const clean = sanitizeDisabledTools(disabled);
    if (clean === null) return null;
    result.toolToggles = { disabled: clean };
  }

  if (payload.reasoning_effort !== undefined) {
    if (
      typeof payload.reasoning_effort !== "string" ||
      !["auto", "xhigh", "high", "medium", "low", "none"].includes(
        payload.reasoning_effort
      )
    ) {
      return null;
    }
    result.reasoning_effort = payload.reasoning_effort;
  }

  // Require at least one known settings key; reject no-op payloads.
  if (Object.keys(result).length === 0) return null;

  return result as Record<SettingsKey, unknown>;
}

/**
 * Distinguish a not-yet-migrated registry (ENOENT — no providers is a
 * legitimate first-boot state, GET falls back to an empty view) from a
 * corrupt one (invalid JSON / schema — spec §6 fails fast with the
 * named path; swallowing it would render the corrupt file as "no
 * providers" and a later PUT would overwrite it, losing data).
 */
function isMissingRegistryError(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return (
    code === "ENOENT" ||
    (error instanceof ProviderConfigError &&
      error.message.includes("not initialized"))
  );
}

export async function GET() {
  let registryView: Awaited<ReturnType<typeof getRegistryView>> | null = null;
  try {
    registryView = await getRegistryView();
  } catch (error) {
    if (!isMissingRegistryError(error)) {
      // Corrupt registry: surface the named failure, never an empty view.
      console.error(
        "[api/settings] Failed to load provider registry:",
        error instanceof Error ? error.message : error,
      );
      return NextResponse.json(
        {
          error: `Provider registry unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
        },
        { status: 500 },
      );
    }
    // ENOENT — first boot before migration: empty view is correct.
  }

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

  // Disabled list from the toggle store (validated on read), exposed as
  // a per-tool `enabled` flag the Tools page binds its switches to.
  const disabledTools = new Set(getDisabledTools());

  const tools = Object.entries(chatTools).map(([name, tool]) => {
    const description =
      (tool as { description?: string }).description?.split("\n")[0] ?? "";
    const base = {
      name,
      description,
      enabled: !disabledTools.has(name),
      // Protected tools cannot be disabled — the UI renders them locked.
      disableable: !PROTECTED_TOOLS.has(name),
    };
    if (name === "web_search") {
      return {
        ...base,
        configured: webSearch.chain.length > 0,
        requires: "EXA_API_KEY / FIRECRAWL_API_KEY / SEARXNG_BASE_URL (any)",
      };
    }
    const envKey = TOOL_KEY_ENV[name];
    return {
      ...base,
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

  // Built-in tools currently served by an MCP duplicate instead: the
  // user released the duplicate (or disabled the built-in, which lets
  // the duplicate flow). Surfaced on the Tools tab as a hint so the
  // capability's state is never silently surprising.
  let mcpDuplicates: Array<{
    tool: string;
    servers: Array<{ name: string; exposedName: string }>;
  }> = [];
  try {
    const statusMap = getMcpStatusMap();
    const byTool = new Map<string, Array<{ name: string; exposedName: string }>>();
    for (const [serverId, status] of Object.entries(statusMap)) {
      for (const tool of status.exposedDuplicates ?? []) {
        const slug = slugifyServerName(status.serverName ?? serverId);
        const entry = { name: status.serverName ?? serverId, exposedName: `${slug}__${tool}` };
        const list = byTool.get(tool) ?? [];
        list.push(entry);
        byTool.set(tool, list);
      }
    }
    mcpDuplicates = Array.from(byTool.entries()).map(([tool, servers]) => ({
      tool,
      servers,
    }));
  } catch {
    // Status store unavailable — no hints, tools list still renders.
  }

  let store: Record<string, unknown> = {};
  try {
    store = getSettingsDb();
  } catch {
    // Database not initialized yet — report an empty store.
  }

  const storedWebSearch =
    typeof store.websearch === "object" && store.websearch !== null
      ? (store.websearch as Record<string, unknown>)
      : {};

  // Surface the embedding-model-change flag (set by PUT when the model differs
  // from the stored tag). The client consumes it once and clears it via the
  // dedicated endpoint; the flag is ephemeral so it doesn't persist stale
  // prompts across unrelated setting changes.
  const modelChangedFlag = store[EMBEDDING_MODEL_CHANGED_KEY];
  const embeddingModelChanged =
    typeof modelChangedFlag === "string" && modelChangedFlag.length > 0
      ? modelChangedFlag
      : null;

  return NextResponse.json({
    embedding: registryView?.embedding ?? null,
    embeddingModelChanged,
    webSearch,
    database,
    tools,
    mcpDuplicates,
    about: {
      name: "Yggdrasil",
      version: pkg.version,
      stack: "Next.js · AI SDK v7 · shadcn/ui · SQLite",
    },
    store: {
      providers: registryView?.providers ?? [],
      websearch: storedWebSearch,
      mcpServers: Array.isArray(store.mcpServers)
        ? (store.mcpServers as McpServerConfig[]).map(maskMcpServerConfig)
        : [],
      reasoning_effort:
        typeof store.reasoning_effort === "string" ? store.reasoning_effort : "auto",
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

  const raw =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const wantsRegistry =
    raw !== null && (raw.providers !== undefined || raw.embedding !== undefined);
  if (wantsRegistry) {
    // The settings client sends partial registry patches (a providers
    // list and/or an embedding block, no document version), while the
    // registry write path validates full documents. Merge the patch
    // onto the current registry so untouched sections survive the
    // round-trip.
    let current: {
      version: number;
      providers: unknown[];
      embedding?: unknown;
    };
    try {
      const doc = await loadRegistry();
      current = {
        version: doc.version,
        providers: doc.providers,
        embedding: doc.embedding,
      };
    } catch (error) {
      if (!isMissingRegistryError(error)) {
        // Corrupt registry: a patch must never replace it with a fresh
        // document — that would silently discard every provider on the
        // next settings save. Fail fast with the named path (spec §6).
        console.error(
          "[api/settings] Failed to load provider registry for patch:",
          error instanceof Error ? error.message : error,
        );
        return NextResponse.json(
          {
            error: `Provider registry unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
          },
          { status: 500 },
        );
      }
      // ENOENT — first write before migration ran: the patch seeds it.
      current = { version: 1, providers: [], embedding: undefined };
    }

    const patchProviders = raw!.providers;
    const patchEmbedding = raw!.embedding;

    // Provider ids the merged document will hold — used to drop a
    // stale embedding pointer left behind by a providers replace.
    const mergedIds = new Set(
      (Array.isArray(patchProviders) ? patchProviders : current.providers)
        .filter(
          (entry) =>
            typeof entry === "object" && entry !== null && !Array.isArray(entry),
        )
        .map((entry) => (entry as Record<string, unknown>).id)
        .filter((id): id is string => typeof id === "string"),
    );

    const merged: Record<string, unknown> = {
      version: current.version,
      providers:
        patchProviders === undefined
          ? current.providers
          : Array.isArray(patchProviders)
            ? patchProviders.map((entry) => {
                if (
                  typeof entry !== "object" ||
                  entry === null ||
                  Array.isArray(entry)
                ) {
                  return entry;
                }
                const provider = { ...(entry as Record<string, unknown>) };
                // Ollama needs no API key (legacy settings semantics).
                if (provider.kind === "ollama") delete provider.apiKey;
                // The isDefault-demotion pass inside applyRegistryPatch
                // walks `models` before Zod applies its `default([])`.
                if (provider.models === undefined) provider.models = [];
                return provider;
              })
            : patchProviders,
    };

    const storedEmbedding =
      typeof current.embedding === "object" && current.embedding !== null
        ? (current.embedding as Record<string, unknown>)
        : null;

    if (patchEmbedding !== undefined) {
      if (
        typeof patchEmbedding === "object" &&
        patchEmbedding !== null &&
        !Array.isArray(patchEmbedding)
      ) {
        // Partial embedding block: carry the stored fields the patch
        // omits so a small tweak does not drop the rest.
        const combined = {
          ...(storedEmbedding ?? {}),
          ...(patchEmbedding as Record<string, unknown>),
        };
        if (
          (patchEmbedding as Record<string, unknown>).providerId ===
            undefined &&
          typeof combined.providerId === "string" &&
          !mergedIds.has(combined.providerId)
        ) {
          // The patch replaces the provider list and the stored
          // embedding's provider did not survive: keep the block but
          // drop the stale pointer.
          combined.providerId = null;
        }
        merged.embedding = combined;
      } else {
        merged.embedding = patchEmbedding;
      }
    } else if (
      storedEmbedding !== null &&
      typeof storedEmbedding.providerId === "string" &&
      !mergedIds.has(storedEmbedding.providerId)
    ) {
      merged.embedding = { ...storedEmbedding, providerId: null };
    } else if (current.embedding !== undefined) {
      merged.embedding = current.embedding;
    }

    const result = await applyRegistryPatch(merged);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Detect embedding model change: compare the live model (now resolved from
    // the just-saved registry) against the stored tag. When changed, persist
    // the new model and surface a flag so the client can prompt the user to
    // rebuild embeddings.
    if (wantsRegistry && raw!.embedding !== undefined) {
      const change = await checkEmbeddingModelChange();
      if (change) {
        setSettingsDb({
          [EMBEDDING_MODEL_KEY]: change.newModel,
          [EMBEDDING_MODEL_CHANGED_KEY]: change.newModel,
        });
      }
    }
  }

  const patch = sanitizeSettingsPayload(body);
  if (!patch) {
    if (wantsRegistry) return NextResponse.json({ success: true });
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
