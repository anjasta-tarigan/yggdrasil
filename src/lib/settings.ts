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
import type { DiscoveryCacheState } from "@/lib/ai/web-provider/discovery";
import type { SessionStatus } from "@/lib/ai/web-provider/types";
import { NIM_BASE_URL } from "@/lib/ai/provider-config/schema";

/** Id of the built-in provider served by this app's own environment. */
export const SERVER_PROVIDER_ID = "server";

export type { ProviderKind, ProviderEntryView, ModelEntry };

export type {
  McpServerConfig,
  McpTransportKind,
} from "@/lib/ai/mcp/config";
export { createMcpServerId } from "@/lib/ai/mcp/config";

/** Credential key row on a cached (client-facing) provider view: id plus
 * configured-only, never the server env name. */
export type ProviderApiKeyView = { id: string; configured: boolean };

/**
 * Client-facing ProviderConfig is the redacted provider view minus server-side
 * credential identifiers (e.g. apiKeyEnv). It carries apiKeyConfigured:
 * boolean instead of plaintext apiKey, and apiKeys rows expose only { id,
 * configured }.
 */
export type ProviderConfig = Omit<ProviderEntryView, "apiKeys"> & {
  apiKeys?: ProviderApiKeyView[];
};

/** Credential rows as the UI holds them: ids plus values being replaced. */
export type ProviderApiKeyRow = {
  id: string;
  /** Only set for rows whose stored key should be replaced. */
  value?: string;
};

/** The preset the NVIDIA NIM UI wires up. */
export const NIM_PRESET = "nvidia-nim";
export { NIM_BASE_URL };

export type EmbeddingProviderKind = "server" | "openai-compatible" | "ollama" | "onnx";

/** App-facing alias for the web search provider entry type. */
export type WebSearchProviderEntry = WebSearchProviderConfig;
export type { WebSearchProviderKind, WebSearchSettings };

export type EmbeddingSettings = {
  /** Registry provider id; null = standalone endpoint below. */
  providerId?: string | null;
  /** Standalone endpoint (used when providerId is null). */
  baseUrl?: string;
  /** Write-only: non-empty stores it server-side; never read back. */
  apiKey?: string;
  /** Set with the save to remove the stored key. */
  clearApiKey?: boolean;
  apiKeyEnv?: string;
  /** Provider kind: "server" | "openai-compatible" | "ollama" | "onnx". */
  provider?: EmbeddingProviderKind;
  model?: string;
  /** ONNX model file (absolute path or filename in data/models/embedding/). */
  modelPath?: string;
  /** Pooling mode for token-level embedding models. */
  poolingMode?: "mean" | "cls" | "lasttoken" | "max";
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
  reasoningEffort: string;
};

const cache: SettingsCache = {
  providers: [],
  embedding: {},
  websearch: [],
  mcpServers: [],
  reasoningEffort: "auto",
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
    (p.kind === "openai-compatible" ||
      p.kind === "ollama" ||
      p.kind === "web-session") &&
    typeof p.apiKeyConfigured === "boolean" &&
    Array.isArray(p.models)
  );
}

function sanitizeProviderView(provider: ProviderConfig): ProviderConfig {
  const sanitized = { ...provider };
  delete (sanitized as Record<string, unknown>).apiKey;
  delete (sanitized as Record<string, unknown>).clearApiKey;
  if (sanitized.apiKeys) {
    sanitized.apiKeys = sanitized.apiKeys.map(({ id, configured }) => ({ id, configured }));
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
  } catch (err) {
    console.debug(`[settings] Error: ${err instanceof Error ? err.message : String(err)}`);
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
              provider: emb.provider,
              baseUrl: emb.baseUrl,
              apiKeyEnv: emb.apiKeyEnv,
              model: emb.model,
              modelPath: emb.modelPath,
              poolingMode: emb.poolingMode,
              dimensions: emb.dimensions,
              chunkSize: emb.chunkSize,
              chunkOverlap: emb.chunkOverlap,
            };
          }
        } else {
          console.warn(
            `hydrateSettings: /api/providers returned ${providersRes.status}; keeping cached providers`,
          );
        }

        if (settingsRes.ok) {
          const settingsData = (await settingsRes.json()) as {
            store?: {
              websearch?: unknown;
              mcpServers?: unknown;
              reasoning_effort?: unknown;
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
          if (typeof settingsData.store?.reasoning_effort === "string") {
            cache.reasoningEffort = settingsData.store.reasoning_effort;
          }
        } else {
          console.warn(
            `hydrateSettings: /api/settings returned ${settingsRes.status}; keeping cached settings`,
          );
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

/** Write-only row intent: id plus an optional value to replace it with. */
export type ProviderApiKeyWriteRow = { id: string; value?: string };

/**
 * Write intent: the cached view with write-only credential fields allowed
 * (single legacy key, or NIM key rows carrying values) and `apiKeyConfigured`
 * optional. `apiKeys` carries write rows, not cached view rows.
 */
export type ProviderWriteInput = Omit<ProviderConfig, "apiKeys" | "apiKeyConfigured"> & {
  apiKeyConfigured?: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
  apiKeys?: ProviderApiKeyWriteRow[];
};

/** Convert a write intent into the minimal server payload: view fields
 * plus write-only key rows/legacy key, dropping credential values. */
function toWriteInput(provider: ProviderConfig | ProviderWriteInput): Record<string, unknown> {
  const source = provider as Record<string, unknown>;
  const out: Record<string, unknown> = {
    id: source.id, kind: source.kind, name: source.name, baseUrl: source.baseUrl,
    ...(source.preset ? { preset: source.preset } : {}),
    models: source.models ?? [],
  };
  if (source.apiKeyEnv !== undefined) out.apiKeyEnv = source.apiKeyEnv;
  if (source.apiKey !== undefined) out.apiKey = source.apiKey;
  if (source.clearApiKey !== undefined) out.clearApiKey = source.clearApiKey;
  if (source.apiKeys !== undefined) out.apiKeys = source.apiKeys;
  return out;
}

/** Replace the whole provider registry (cache first, then server). */
export async function saveProviders(
  providers: Array<ProviderConfig | ProviderWriteInput>
): Promise<void> {
  const inputs = providers.map(toWriteInput);
  cache.providers = inputs.map((input) =>
    sanitizeProviderView(input as unknown as ProviderConfig),
  );
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PROVIDERS_CHANGED_EVENT));
  }
  try {
    const res = await fetch("/api/providers", {
      body: JSON.stringify({ providers: inputs }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
    const data = (await res.json().catch(() => null)) as { providers?: ProviderConfig[] } | null;
    if (Array.isArray(data?.providers)) {
      cache.providers = data.providers.filter(isProviderConfig).map(sanitizeProviderView);
    } else {
      cache.providers = inputs.map((input) =>
        sanitizeProviderView(input as unknown as ProviderConfig),
      );
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

export async function addProvider(
  provider: ProviderConfig | LegacyProviderConfig | ProviderWriteInput
): Promise<void> {
  const fullProvider: ProviderWriteInput = {
    ...provider,
    models: provider.models ?? [],
  };
  await saveProviders([...getProviders(), fullProvider]);
}

export async function removeProvider(id: string): Promise<void> {
  await saveProviders(getProviders().filter((p) => p.id !== id));
}

export async function saveEmbeddingSettings(
  settingsPatch: EmbeddingSettings
): Promise<{ embeddingModelChanged?: string | null }> {
  // The stored block never carries a key VALUE — the server maps a
  // non-empty apiKey into the secrets file and keeps only the env name.
  const next: EmbeddingSettings = {
    providerId: settingsPatch.providerId ?? null,
    provider: settingsPatch.provider,
    baseUrl: settingsPatch.baseUrl?.trim() || undefined,
    apiKey: settingsPatch.apiKey || undefined,
    model: settingsPatch.model?.trim() || undefined,
    modelPath: settingsPatch.modelPath,
    poolingMode: settingsPatch.poolingMode,
    dimensions: settingsPatch.dimensions,
    chunkSize: settingsPatch.chunkSize,
    chunkOverlap: settingsPatch.chunkOverlap,
  };
  cache.embedding = next;
  try {
    const res = await fetch("/api/settings", {
      body: JSON.stringify({
        embedding: {
          ...next,
          ...(settingsPatch.clearApiKey ? { clearApiKey: true } : {}),
        },
      }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      embeddingModelChanged?: string | null;
    } | null;
    return { embeddingModelChanged: data?.embeddingModelChanged ?? null };
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

export function getReasoningEffort(): string {
  return cache.reasoningEffort;
}

export async function saveReasoningEffort(effort: string): Promise<void> {
  cache.reasoningEffort = effort;
  try {
    const res = await fetch("/api/settings", {
      body: JSON.stringify({ reasoning_effort: effort }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
  } catch (error) {
    console.warn("Failed to persist reasoning effort setting", error);
  }
}

// ---- Web provider sessions (experimental) ----

/**
 * Web providers expose a dedicated management surface instead of the generic
 * provider registry. Only `deepseek-web` has routes today; an unknown id is
 * rejected before any request so a helper can never be pointed at another
 * provider's session route.
 */
const WEB_PROVIDER_BASES: Record<string, string> = {
  "deepseek-web": "/api/web-providers/deepseek",
};

function webProviderBase(providerId: string): string {
  const base = WEB_PROVIDER_BASES[providerId];
  if (!base) throw new Error(`Unknown web provider: ${providerId}`);
  return base;
}

export type WebProviderUserAgentMode = "browser" | "server-default" | "custom";

/** Session candidate as the UI holds it. The token is write-only (Spec §4.3). */
export type WebProviderSessionCandidate = {
  providerId: string;
  userToken: string;
  userAgentMode: WebProviderUserAgentMode;
  userAgent?: string;
};

export type WebProviderSessionResult = {
  ok: boolean;
  code?: string;
  message?: string;
  lastCheckedAt?: string;
};

export type WebProviderDiscoveryResult = {
  ok: boolean;
  models?: ModelEntry[];
  cache?: DiscoveryCacheState;
  code?: string;
  message?: string;
};

/**
 * The check/save routes parse with a strict schema that accepts only these
 * three fields, so `providerId` is routing information and must not be sent.
 */
function sessionCandidateBody(
  input: WebProviderSessionCandidate
): Record<string, unknown> {
  return {
    userToken: input.userToken,
    userAgentMode: input.userAgentMode,
    ...(input.userAgent ? { userAgent: input.userAgent } : {}),
  };
}

/** Read a JSON object body; a non-JSON or empty body yields null, not a throw. */
async function readJsonObject(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    // Upstream/proxy responses may not be JSON; the HTTP status still stands.
    return null;
  }
}

function readSafeCode(body: Record<string, unknown> | null): string | undefined {
  return typeof body?.code === "string" ? body.code : undefined;
}

function readSafeMessage(body: Record<string, unknown> | null): string | undefined {
  return typeof body?.message === "string" ? body.message : undefined;
}

/**
 * Validate a session candidate without saving it. Sends the token only to the
 * check route; nothing is cached client-side.
 */
export async function checkWebProviderSession(
  input: WebProviderSessionCandidate
): Promise<WebProviderSessionResult> {
  const res = await fetch(`${webProviderBase(input.providerId)}/session/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionCandidateBody(input)),
  });
  const body = await readJsonObject(res);
  const code = readSafeCode(body);
  const message = readSafeMessage(body);
  return {
    ok: res.ok && body?.ok !== false,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

/**
 * Revalidate a candidate on the server and, only on success, persist it
 * encrypted. The response carries redacted status plus `lastCheckedAt`.
 */
export async function saveWebProviderSession(
  input: WebProviderSessionCandidate
): Promise<WebProviderSessionResult> {
  const res = await fetch(`${webProviderBase(input.providerId)}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionCandidateBody(input)),
  });
  const body = await readJsonObject(res);
  const code = readSafeCode(body);
  const message = readSafeMessage(body);
  const lastCheckedAt = typeof body?.lastCheckedAt === "string" ? body.lastCheckedAt : undefined;
  return {
    ok: res.ok && body?.ok !== false,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
  };
}

/**
 * Delete the stored session. Returns nothing, so a failure throws rather than
 * reporting a silent success (Rule 02).
 */
export async function deleteWebProviderSession(providerId: string): Promise<void> {
  const res = await fetch(`${webProviderBase(providerId)}/session`, { method: "DELETE" });
  if (res.ok) return;
  const body = await readJsonObject(res);
  const code = readSafeCode(body);
  const message = readSafeMessage(body) ?? `HTTP ${res.status}`;
  throw new Error(code ? `${message} (${code})` : message);
}

/**
 * Re-check the stored session against the provider. Never obtains a new token
 * or extends a cookie (Spec §6.5).
 */
export async function revalidateWebProviderSession(
  providerId: string
): Promise<WebProviderSessionResult> {
  const res = await fetch(`${webProviderBase(providerId)}/session/revalidate`, { method: "POST" });
  const body = await readJsonObject(res);
  const code = readSafeCode(body);
  const message = readSafeMessage(body);
  return {
    ok: res.ok && body?.ok !== false,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

/**
 * Refresh the model list from the stored server-side session. The request
 * carries only the refresh intent — no token, cookie, endpoint, or User-Agent.
 */
export async function discoverWebProviderModels(
  providerId: string,
  force = false
): Promise<WebProviderDiscoveryResult> {
  const res = await fetch(`${webProviderBase(providerId)}/models/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  const body = await readJsonObject(res);
  const code = readSafeCode(body);
  const message = readSafeMessage(body);
  const models = Array.isArray(body?.models) ? (body.models as ModelEntry[]) : undefined;
  const cache =
    typeof body?.cache === "string" ? (body.cache as DiscoveryCacheState) : undefined;
  return {
    ok: res.ok && body?.ok !== false,
    ...(models ? { models } : {}),
    ...(cache ? { cache } : {}),
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

/** Redacted session state the GET catalog reports for a web provider. */
export type WebProviderCatalogSession = {
  status: SessionStatus;
  lastCheckedAt: string | null;
};

/** One entry of `GET /api/web-providers` (Spec §6.2). */
export type WebProviderCatalogEntry = {
  id: string;
  name: string;
  experimental: boolean;
  enabled: boolean;
  models: ModelEntry[];
  session: WebProviderCatalogSession;
};

/**
 * Read the web-provider catalog (Spec §6.2).
 *
 * Returns `null` when the surface is unavailable — a non-OK response (the
 * feature-disabled route answers 404) or a transport failure. The UI treats
 * `null` as "do not offer a session action" rather than as an empty catalog
 * (Spec §11.2).
 */
export async function fetchWebProviderCatalog(): Promise<
  WebProviderCatalogEntry[] | null
> {
  try {
    const res = await fetch("/api/web-providers", { cache: "no-store" });
    if (!res.ok) return null;
    const body = await readJsonObject(res);
    if (!Array.isArray(body?.providers)) return null;
    return (body.providers as unknown[]).flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const row = entry as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.name !== "string") return [];
      const session = (row.session ?? {}) as Record<string, unknown>;
      return [{
        id: row.id,
        name: row.name,
        experimental: row.experimental === true,
        enabled: row.enabled !== false,
        models: Array.isArray(row.models) ? (row.models as ModelEntry[]) : [],
        session: {
          status:
            typeof session.status === "string"
              ? (session.status as SessionStatus)
              : "not-configured",
          lastCheckedAt:
            typeof session.lastCheckedAt === "string" ? session.lastCheckedAt : null,
        },
      }];
    });
  } catch (error) {
    console.warn("Failed to load web provider catalog", error);
    return null;
  }
}

/**
 * Re-read the provider registry (`GET /api/providers`).
 *
 * The module cache is hydrated once at boot and only re-synced from this route
 * on demand; a web-provider discovery writes models server-side, so a caller
 * that must show the new count reads them here rather than trusting the stale
 * cache. Returns `null` on failure so the caller keeps what it already shows.
 */
export async function fetchProviderRegistry(): Promise<ProviderConfig[] | null> {
  try {
    const res = await fetch("/api/providers", { cache: "no-store" });
    if (!res.ok) return null;
    const body = await readJsonObject(res);
    if (!Array.isArray(body?.providers)) return null;
    // Same validation and redaction the boot hydration applies, so a caller
    // gets the identical ProviderConfig shape it already holds.
    return body.providers
      .filter(isProviderConfig)
      .map(sanitizeProviderView);
  } catch (error) {
    console.warn("Failed to reload provider registry", error);
    return null;
  }
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
  chatId?: string,
  effort?: string
): { model?: string; chatId?: string; effort?: string } | undefined {
  if (!ref && !chatId && !effort) return undefined;
  return {
    ...(ref ? { model: ref } : {}),
    ...(chatId ? { chatId } : {}),
    ...(effort ? { effort } : {}),
  };
}
