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

/** Id of the built-in provider served by this app's own environment. */
export const SERVER_PROVIDER_ID = "server";

export type ProviderKind = "openai-compatible" | "ollama";

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

export type EmbeddingSettings = {
  model?: string;
};

/** Event dispatched on window whenever the provider registry changes. */
export const PROVIDERS_CHANGED_EVENT = "yggdrasil:providers-changed";

/** Legacy browser keys that no longer hold any data. */
const LEGACY_KEYS = [
  "yggdrasil:providers:v1",
  "yggdrasil:settings:provider",
  "yggdrasil:settings:embedding",
];

type SettingsCache = {
  providers: ProviderConfig[];
  embedding: EmbeddingSettings;
};

const cache: SettingsCache = { providers: [], embedding: {} };

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
          store?: { providers?: unknown; embedding?: unknown };
        };
        const providers = Array.isArray(data.store?.providers)
          ? (data.store?.providers as unknown[]).filter(isProviderConfig)
          : [];
        const emb = data.store?.embedding;
        const embedding: EmbeddingSettings =
          typeof emb === "object" &&
          emb !== null &&
          typeof (emb as Record<string, unknown>).model === "string"
            ? { model: (emb as Record<string, unknown>).model as string }
            : {};
        cache.providers = providers;
        cache.embedding = embedding;
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

async function persist(patch: {
  providers?: ProviderConfig[];
  embedding?: EmbeddingSettings;
}): Promise<void> {
  try {
    const res = await fetch("/api/settings", {
      body: JSON.stringify(patch),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    console.warn("Failed to persist settings; re-syncing from server", error);
    void hydrateSettings();
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
    model: settingsPatch.model?.trim() || undefined,
  };
  cache.embedding = next;
  await persist({ embedding: next });
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

/** Shape of the provider field accepted by /api/chat. */
export type ChatRequestProvider =
  | { apiKey?: string; baseUrl?: string }
  | { baseUrl: string; kind: "ollama" };

/**
 * Build the chat request body for a qualified model ref: the model id
 * plus, for non-server providers, the provider override that /api/chat
 * uses to reach it. Returns undefined when nothing is selected.
 */
export function chatRequestBody(
  ref: string | null,
  chatId?: string
): { model?: string; provider?: ChatRequestProvider; chatId?: string } | undefined {
  const { modelId, providerId } = decodeModelRef(ref);
  if (!modelId && !chatId) return undefined;

  const baseBody: { model?: string; chatId?: string; provider?: ChatRequestProvider } = {
    ...(modelId ? { model: modelId } : {}),
    ...(chatId ? { chatId } : {}),
  };

  if (providerId === SERVER_PROVIDER_ID) {
    return baseBody;
  }

  const provider = getProviders().find((p) => p.id === providerId);
  if (!provider) {
    return baseBody;
  }

  if (provider.kind === "ollama") {
    return {
      ...baseBody,
      provider: { baseUrl: provider.baseUrl, kind: "ollama" },
    };
  }
  return {
    ...baseBody,
    provider: { apiKey: provider.apiKey, baseUrl: provider.baseUrl },
  };
}
