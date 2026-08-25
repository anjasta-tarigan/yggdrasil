/**
 * Client-side settings store (localStorage).
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

const PROVIDERS_KEY = "yggdrasil:providers:v1";
const LEGACY_PROVIDER_KEY = "yggdrasil:settings:provider";
const EMBEDDING_KEY = "yggdrasil:settings:embedding";

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

function readJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn("Failed to persist settings", error);
  }
}

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

/** One-time migration from the old single-provider override key. */
function migrateLegacyProvider(): ProviderConfig[] {
  const legacy = readJson<{
    apiKey?: string;
    baseUrl?: string;
    kind?: string;
    ollamaBaseUrl?: string;
    ollamaModel?: string;
  }>(LEGACY_PROVIDER_KEY);
  if (!legacy) return [];

  const migrated: ProviderConfig[] = [];
  if (legacy.kind === "ollama" && legacy.ollamaBaseUrl) {
    migrated.push({
      baseUrl: legacy.ollamaBaseUrl,
      id: createProviderId("ollama"),
      kind: "ollama",
      name: "Ollama",
    });
  } else if (legacy.baseUrl) {
    migrated.push({
      apiKey: legacy.apiKey,
      baseUrl: legacy.baseUrl,
      id: createProviderId("custom"),
      kind: "openai-compatible",
      name: "Custom endpoint",
    });
  }
  if (migrated.length > 0) {
    writeJson(PROVIDERS_KEY, migrated);
  }
  try {
    window.localStorage.removeItem(LEGACY_PROVIDER_KEY);
  } catch {
    /* non-fatal */
  }
  return migrated;
}

export function createProviderId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/** All user-added providers (the server provider is implicit). */
export function getProviders(): ProviderConfig[] {
  if (typeof window === "undefined") return [];
  const stored = readJson<unknown[]>(PROVIDERS_KEY);
  if (stored === null) return migrateLegacyProvider();
  if (!Array.isArray(stored)) return [];
  return stored.filter(isProviderConfig);
}

export function saveProviders(providers: ProviderConfig[]): void {
  writeJson(PROVIDERS_KEY, providers);
  // Let open model selectors know the registry changed.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("yggdrasil:providers-changed"));
  }
}

export function addProvider(provider: ProviderConfig): void {
  saveProviders([...getProviders(), provider]);
}

export function removeProvider(id: string): void {
  saveProviders(getProviders().filter((p) => p.id !== id));
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

// ---- Embedding settings ----

export function getEmbeddingSettings(): EmbeddingSettings {
  const stored = readJson<EmbeddingSettings>(EMBEDDING_KEY);
  return {
    model: typeof stored?.model === "string" ? stored.model : undefined,
  };
}

export function saveEmbeddingSettings(settings: EmbeddingSettings): void {
  writeJson(EMBEDDING_KEY, {
    model: settings.model?.trim() || undefined,
  });
}
