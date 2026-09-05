/**
 * Settings client — Provider registry (`/api/providers`) + Settings (`/api/settings`).
 *
 * Runtime configuration lives in the server files/database and is served by
 * /api/providers and /api/settings. This module keeps a small in-memory cache
 * so existing call sites can read synchronously (e.g. building a chat request
 * body), while writes go straight to the server endpoints. Call
 * `hydrateSettings()` once at app boot before relying on the cache.
 *
 * AI providers are a curated registry: the built-in server provider (from
 * .env.local) is present along with any user-added providers.
 *
 * The selected model is stored as a qualified ref "providerId::modelId"
 * so identical model names on different providers never collide.
 *
 * This is a single-user self-hosted app; keys never enter client cache.
 */

import {
  sanitizeMcpServerList,
  type McpServerConfig,
} from "@/lib/ai/mcp/config";
import type {
  WebSearchProviderConfig,
  WebSearchProviderKind,
  WebSearchSettings,
} from "@/lib/web-search";
import type {
  ProviderEntryView,
  ModelEntry,
  ProviderKind,
  EmbeddingBlock,
} from "@/lib/ai/provider-config/schema";

/** Id of the built-in provider served by this app's own environment. */
export const SERVER_PROVIDER_ID = "server";

export type { ProviderKind, ProviderEntryView, ModelEntry };

export type {
  McpServerConfig,
  McpTransportKind,
} from "@/lib/ai/mcp/config";
export { createMcpServerId } from "@/lib/ai/mcp/config";

/**
 * Client-facing ProviderConfig is an alias of the redacted ProviderEntryView.
 * It carries apiKeyConfigured: boolean instead of plaintext apiKey.
 */
export type ProviderConfig = ProviderEntryView;

export type EmbeddingProviderKind = "server" | "openai-compatible" | "ollama";

/** App-facing alias for the web search provider entry type. */
export type WebSearchProviderEntry = WebSearchProviderConfig;
export type { WebSearchProviderKind, WebSearchSettings };

export type EmbeddingSettings = {
  /** Where embeddings are computed. Provider ID or kind. */
  provider?: EmbeddingProviderKind;
  providerId?: string | null;
  /** openai-compatible / ollama only. */
  baseUrl?: string;
  /** openai-compatible only. */
  apiKey?: string;
  apiKeyEnv?: string;
  model?: string;
  /** Auto-detected native vector dimension of the model. */
  dimensions?: number;
  /** Chunk size in characters (≈4 chars/token). Default 2000 (≈512 tokens). */
  chunkSize?: number;
  /** Chunk overlap in characters. Default 200 (10%). */
  chunkOverlap?: number;
};

/** Event dispatched on window whenever the provider registry changes. */
export const PROVIDERS_CHANGED_EVENT = "yggdrasil:providers-changed";

/** Event dispatched on window whenever the MCP server registry changes. */
export const MCP_SERVERS_CHANGED_EVENT = "yggdrasil:mcp-servers-changed";

/** Legacy browser keys that no longer hold any data. */
const LEGACY_KEYS = [
  "yggdrasil:providers:v1",
  "yggdrasil:settings:provider",
  "yggdrasil:settings:embedding",
];

type SettingsCache = {
  providers: ProviderEntryView[];
  embedding: EmbeddingSettings;
  websearch: WebSearchProviderEntry[];
  mcpServers: McpServerConfig[];
};

const cache: SettingsCache = {
  providers: [],
  embedding: {},
  websearch: [],
  mcpServers: [],
};

let hydrating: Promise<void> | null = null;

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.baseUrl === "string" &&
    /^https?:\/\//.test(p.baseUrl) &&
    (p.kind === "openai-compatible" || p.kind === "ollama") &&
    typeof p.apiKeyConfigured === "boolean" &&
    Array.isArray(p.models)
  );
}

function sanitizeProviderView(provider: ProviderConfig): ProviderConfig {
  // Defense in depth: ensure apiKey is never present on cached provider views
  const sanitized = { ...provider };
  if ("apiKey" in sanitized) {
    delete (sanitized as Record<string, unknown>).apiKey;
  }
  return sanitized;
}

function isWebSearchProviderEntry(
  value: unknown
): value is WebSearchProviderEntry {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    (p.kind === "exa" || p.kind === "firecrawl" || p.kind === "searxng") &&
    typeof p.enabled === "boolean" &&
    (p.apiKey === undefined || typeof p.apiKey === "string") &&
    (p.baseUrl === undefined || typeof p.baseUrl === "string")
  );
}

/** Remove obsolete localStorage settings keys (one-time cleanup). */
function purgeLegacySettingsStorage(): void {
  if (typeof window === "undefined") return;
  try {
    for (const key of LEGACY_KEYS) {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Load settings and providers from the server into the local cache. Safe to
 * call repeatedly; concurrent calls share one request. Failures keep
 * the current cache (empty defaults at worst) and are logged.
 */
export function hydrateSettings(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (!hydrating) {
    hydrating = (async () => {
      purgeLegacySettingsStorage();
      try {
        const [providersRes, settingsRes] = await Promise.all([
          fetch("/api/providers", { cache: "no-store" }),
          fetch("/api/settings", { cache: "no-store" }),
        ]);

        if (providersRes.ok) {
          const providersData = (await providersRes.json()) as {
            providers?: unknown;
            embedding?: EmbeddingBlock | null;
          };
          if (Array.isArray(providersData.providers)) {
            cache.providers = providersData.providers
              .filter(isProviderConfig)
              .map(sanitizeProviderView);
          }
          if (
            typeof providersData.embedding === "object" &&
            providersData.embedding !== null
          ) {
            const emb = providersData.embedding;
            cache.embedding = {
              providerId: emb.providerId ?? undefined,
              baseUrl: emb.baseUrl,
              apiKeyEnv: emb.apiKeyEnv,
              model: emb.model,
              dimensions: emb.dimensions,
              chunkSize: emb.chunkSize,
              chunkOverlap: emb.chunkOverlap,
            };
          }
        }

        if (settingsRes.ok) {
          const settingsData = (await settingsRes.json()) as {
            store?: {
              websearch?: unknown;
              mcpServers?: unknown;
            };
          };
          const mcpServers = sanitizeMcpServerList(settingsData.store?.mcpServers) ?? [];
          const ws = settingsData.store?.websearch;
          const wsProviders =
            typeof ws === "object" && ws !== null
              ? (ws as { providers?: unknown }).providers
              : undefined;
          const websearch = Array.isArray(wsProviders)
            ? wsProviders.filter(isWebSearchProviderEntry)
            : [];

          cache.websearch = websearch;
          cache.mcpServers = mcpServers;
        }
      } catch (error) {
        console.warn("Failed to hydrate settings from server", error);
      } finally {
        // Allow later explicit refreshes to hit the network again.
        hydrating = null;
      }
    })();
  }
  return hydrating;
}

export function createProviderId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/** All configured providers in the registry. */
export function getProviders(): ProviderConfig[] {
  return cache.providers;
}

export function getEmbeddingSettings(): EmbeddingSettings {
  return { ...cache.embedding };
}

/** The stored web search provider chain (may be empty → env defaults). */
export function getWebSearchProviders(): WebSearchProviderEntry[] {
  return cache.websearch.map((p) => ({ ...p }));
}

/** Replace the whole provider registry (cache first, then database/file). */
export async function saveProviders(
  providers: ProviderConfig[]
): Promise<void> {
  const sanitized = providers.map(sanitizeProviderView);
  cache.providers = sanitized;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PROVIDERS_CHANGED_EVENT));
  }
  try {
    const res = await fetch("/api/providers", {
      body: JSON.stringify({ providers: sanitized }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
  } catch (error) {
    console.warn("Failed to persist providers; re-syncing from server", error);
    void hydrateSettings();
    throw error;
  }
}

// Legacy helper for callers not yet migrated to the new ProviderEntryView shape.
export type LegacyProviderConfig = {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyConfigured?: boolean;
  models?: ModelEntry[];
};

export async function addProvider(provider: ProviderConfig | LegacyProviderConfig): Promise<void> {
  const fullProvider: ProviderConfig = {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKeyConfigured: provider.apiKeyConfigured ?? false,
    models: provider.models ?? [],
    ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
  };
  await saveProviders([...getProviders(), fullProvider]);
}

export async function removeProvider(id: string): Promise<void> {
  await saveProviders(getProviders().filter((p) => p.id !== id));
}

export async function saveEmbeddingSettings(
  settingsPatch: EmbeddingSettings
): Promise<void> {
  const next: EmbeddingSettings = {
    provider: settingsPatch.provider,
    baseUrl: settingsPatch.baseUrl?.trim() || undefined,
    apiKey: settingsPatch.apiKey || undefined,
    model: settingsPatch.model?.trim() || undefined,
    dimensions: settingsPatch.dimensions,
    chunkSize: settingsPatch.chunkSize,
    chunkOverlap: settingsPatch.chunkOverlap,
  };
  cache.embedding = next;
  try {
    const res = await fetch("/api/settings", {
      body: JSON.stringify({ embedding: next }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
  } catch (error) {
    console.warn("Failed to persist embedding settings; re-syncing from server", error);
    void hydrateSettings();
    throw error;
  }
}

/**
 * Replace the web search provider chain (cache first, then database).
 * Entries are saved in the given order — order encodes fallback priority.
 */
export async function saveWebSearchProviders(
  providers: WebSearchProviderEntry[]
): Promise<void> {
  const next = providers.map((p) => ({
    kind: p.kind,
    enabled: p.enabled,
    apiKey: p.apiKey?.trim() || undefined,
    baseUrl: p.baseUrl?.trim() || undefined,
  }));
  cache.websearch = next;
  try {
    const res = await fetch("/api/settings", {
      body: JSON.stringify({ websearch: { providers: next } }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
  } catch (error) {
    console.warn("Failed to persist web search settings; re-syncing from server", error);
    void hydrateSettings();
    throw error;
  }
}

// ---- MCP server registry ----

/** All configured MCP servers (including disabled ones). */
export function getMcpServers(): McpServerConfig[] {
  return cache.mcpServers.map((s) => ({ ...s }));
}

/** Replace the whole MCP server registry (cache first, then database). */
export async function saveMcpServers(
  servers: McpServerConfig[]
): Promise<void> {
  cache.mcpServers = servers.map((s) => ({ ...s }));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(MCP_SERVERS_CHANGED_EVENT));
  }
  try {
    const res = await fetch("/api/settings", {
      body: JSON.stringify({ mcpServers: servers }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
  } catch (error) {
    console.warn("Failed to persist MCP servers; re-syncing from server", error);
    void hydrateSettings();
    throw error;
  }
}

export async function addMcpServer(server: McpServerConfig): Promise<void> {
  await saveMcpServers([...getMcpServers(), server]);
}

export async function removeMcpServer(id: string): Promise<void> {
  await saveMcpServers(getMcpServers().filter((s) => s.id !== id));
}

// ---- Qualified model refs: "providerId::modelId" ----

export function encodeModelRef(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function decodeModelRef(ref: string | null): {
  modelId: string | null;
  providerId: string;
} {
  if (!ref) return { modelId: null, providerId: SERVER_PROVIDER_ID };
  const separator = ref.indexOf("::");
  if (separator === -1) {
    // Legacy bare model id → server provider.
    return { modelId: ref, providerId: SERVER_PROVIDER_ID };
  }
  return {
    modelId: ref.slice(separator + 2) || null,
    providerId: ref.slice(0, separator),
  };
}

/**
 * Build the chat request body for a qualified model ref. The server
 * resolves the ref against its provider registry — the client never
 * sends provider credentials. Returns undefined when nothing is
 * selected.
 */
export function chatRequestBody(
  ref: string | null,
  chatId?: string
): { model?: string; chatId?: string } | undefined {
  if (!ref && !chatId) return undefined;
  return {
    ...(ref ? { model: ref } : {}),
    ...(chatId ? { chatId } : {}),
  };
}
