/**
 * Client-side settings store (localStorage).
 *
 * Provider overrides saved here are attached to every chat request body
 * and honored by /api/chat ahead of the server's .env.local values, so
 * the Settings page can repoint the assistant at another OpenAI-
 * compatible endpoint without editing environment files. This is a
 * single-user self-hosted app; the key never leaves the local machine.
 */

const PROVIDER_KEY = "yggdrasil:settings:provider";
const EMBEDDING_KEY = "yggdrasil:settings:embedding";

export type ProviderSettings = {
  apiKey?: string;
  baseUrl?: string;
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

export function getProviderSettings(): ProviderSettings {
  const stored = readJson<ProviderSettings>(PROVIDER_KEY);
  return {
    apiKey: typeof stored?.apiKey === "string" ? stored.apiKey : undefined,
    baseUrl: typeof stored?.baseUrl === "string" ? stored.baseUrl : undefined,
  };
}

export function saveProviderSettings(settings: ProviderSettings): void {
  writeJson(PROVIDER_KEY, {
    apiKey: settings.apiKey?.trim() || undefined,
    baseUrl: settings.baseUrl?.trim() || undefined,
  });
}

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

/**
 * Extra chat-request body fields derived from saved settings. Returns
 * undefined when nothing is overridden so callers can pass it through
 * unchanged.
 */
export function providerRequestBody(): { provider: ProviderSettings } | undefined {
  const { apiKey, baseUrl } = getProviderSettings();
  if (!apiKey && !baseUrl) return undefined;
  return { provider: { apiKey, baseUrl } };
}

/** Merge model selection + provider overrides into one request body. */
export function chatRequestBody(
  model: string | null
): { model?: string; provider?: ProviderSettings } | undefined {
  const provider = providerRequestBody();
  if (!model && !provider) return undefined;
  return { ...(model ? { model } : {}), ...(provider ?? {}) };
}
