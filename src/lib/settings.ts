/**
 * Settings client — SQLite is the single source of truth.
 *
 * Runtime configuration (AI provider registry, embedding settings) lives
 * in the server database and is served by /api/settings. This module
 * keeps a small in-memory cache so existing call sites can read
 * synchronously (e.g. building a chat request body), while all writes
 * go straight to the database. Call `hydrateSettings()` once at app
 * boot before relying on the cache.
 *
 * AI providers are a registry: the built-in server provider (from
 * .env.local) is always present, and the user can add any number of
 * extra providers (OpenAI-compatible endpoints, Ollama instances) from
 * the Settings page. Every saved provider is active at once — the chat
 * model selector lists all of their models grouped per provider, and
 * picking one routes the request to that provider.
 *
 * The selected model is stored as a qualified ref "providerId::modelId"
 * so identical model names on different providers never collide.
 *
 * This is a single-user self-hosted app; keys never leave the machine.
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

/** Id of the built-in provider served by this app's own environment. */
export const SERVER_PROVIDER_ID = "server";

export type ProviderKind = "openai-compatible" | "ollama";

export type {
  McpServerConfig,
  McpTransportKind,
} from "@/lib/ai/mcp/config";
export { createMcpServerId } from "@/lib/ai/mcp/config";

export type ProviderConfig = {
  /** Unique stable id (generated); used inside qualified model refs. */
  id: string;
  kind: ProviderKind;
  /** Display name shown in the model selector group heading. */
  name: string;
  baseUrl: string;
  /** OpenAI-compatible only; Ollama needs no key. */
  apiKey?: string;
};

export type EmbeddingProviderKind = "server" | "openai-compatible" | "ollama";

/** App-facing alias for the web search provider entry type. */
export type WebSearchProviderEntry = WebSearchProviderConfig;
export type { WebSearchProviderKind, WebSearchSettings };

export type EmbeddingSettings = {
  /** Where embeddings are computed. Defaults to the server's own endpoint. */
  provider?: EmbeddingProviderKind;
  /** openai-compatible / ollama only. */
  baseUrl?: string;
  /** openai-compatible only. */
  apiKey?: string;
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
  providers: ProviderConfig[];
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
    (p.kind === "openai-compatible" || p.kind === "ollama")
  );
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
 * Load the settings store from the server into the local cache. Safe to
 * call repeatedly; concurrent calls share one request. Failures keep
 * the current cache (empty defaults at worst) and are logged.
 */
export function hydrateSettings(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (!hydrating) {
    hydrating = (async () => {
      purgeLegacySettingsStorage();
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          store?: {
            providers?: unknown;
            embedding?: unknown;
            websearch?: unknown;
            mcpServers?: unknown;
          };
        };
        const providers = Array.isArray(data.store?.providers)
          ? (data.store?.providers as unknown[]).filter(isProviderConfig)
          : [];
        const mcpServers = sanitizeMcpServerList(data.store?.mcpServers) ?? [];
        const ws = data.store?.websearch;
        const wsProviders =
          typeof ws === "object" && ws !== null
            ? (ws as { providers?: unknown }).providers
            : undefined;
        const websearch = Array.isArray(wsProviders)
          ? wsProviders.filter(isWebSearchProviderEntry)
          : [];
        const emb = data.store?.embedding;
        const embedding: EmbeddingSettings = {};
        if (typeof emb === "object" && emb !== null) {
          const e = emb as Record<string, unknown>;
          if (e.provider === "ollama" || e.provider === "openai-compatible") {
            embedding.provider = e.provider;
          }
          if (typeof e.baseUrl === "string" && e.baseUrl) {
            embedding.baseUrl = e.baseUrl;
          }
          if (typeof e.apiKey === "string" && e.apiKey) {
            embedding.apiKey = e.apiKey;
          }
          if (typeof e.model === "string" && e.model) {
            embedding.model = e.model;
          }
          if (typeof e.dimensions === "number" && e.dimensions > 0) {
            embedding.dimensions = e.dimensions;
          }
          if (typeof e.chunkSize === "number" && e.chunkSize > 0) {
            embedding.chunkSize = e.chunkSize;
          }
          if (typeof e.chunkOverlap === "number" && e.chunkOverlap >= 0) {
            embedding.chunkOverlap = e.chunkOverlap;
          }
        }
        cache.providers = providers;
        cache.embedding = embedding;
        cache.websearch = websearch;
        cache.mcpServers = mcpServers;
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

/** All user-added providers (the server provider is implicit). */
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

async function persist(patch: {
  providers?: ProviderConfig[];
  embedding?: EmbeddingSettings;
  websearch?: WebSearchSettings;
  mcpServers?: McpServerConfig[];
}): Promise<void> {
  try {
    const res = await fetch("/api/settings", {
      body: JSON.stringify(patch),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
  } catch (error) {
    console.warn("Failed to persist settings; re-syncing from server", error);
    void hydrateSettings();
    throw error;
  }
}

/** Replace the whole provider registry (cache first, then database). */
export async function saveProviders(
  providers: ProviderConfig[]
): Promise<void> {
  cache.providers = providers;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PROVIDERS_CHANGED_EVENT));
  }
  await persist({ providers });
}

export async function addProvider(provider: ProviderConfig): Promise<void> {
  await saveProviders([...getProviders(), provider]);
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
  await persist({ embedding: next });
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
  await persist({ websearch: { providers: next } });
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
  await persist({ mcpServers: servers });
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
  const { modelId } = decodeModelRef(ref);
  if (!modelId && !chatId) return undefined;

  return {
    ...(modelId ? { model: modelId } : {}),
    ...(chatId ? { chatId } : {}),
  };
}
