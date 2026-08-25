/**
 * Client-side settings store (localStorage).
 *
 * Provider settings saved here are attached to every chat request body
 * and honored by /api/chat ahead of the server's .env.local values, so
 * the Settings page can repoint the assistant without editing
 * environment files. Two provider kinds are supported:
 *
 * - "openai-compatible" (default): any OpenAI-compatible endpoint,
 *   optional base URL + API key overrides.
 * - "ollama": endpoint auto-detected server-side (/api/ollama), no API
 *   key, model list pulled from the device. Routed through Ollama's
 *   OpenAI-compatible /v1 API.
 *
 * This is a single-user self-hosted app; keys never leave the machine.
 */

const PROVIDER_KEY = "yggdrasil:settings:provider";
const EMBEDDING_KEY = "yggdrasil:settings:embedding";

export type ProviderKind = "openai-compatible" | "ollama";

export type ProviderSettings = {
  apiKey?: string;
  baseUrl?: string;
  /** Absent means the default openai-compatible server provider. */
  kind?: ProviderKind;
  /** Detected Ollama endpoint (e.g. http://localhost:11434). */
  ollamaBaseUrl?: string;
  /** Selected Ollama model name (e.g. qwen2.5:1.5b). */
  ollamaModel?: string;
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function getProviderSettings(): ProviderSettings {
  const stored = readJson<ProviderSettings>(PROVIDER_KEY);
  return {
    apiKey: optionalString(stored?.apiKey),
    baseUrl: optionalString(stored?.baseUrl),
    kind: stored?.kind === "ollama" ? "ollama" : "openai-compatible",
    ollamaBaseUrl: optionalString(stored?.ollamaBaseUrl),
    ollamaModel: optionalString(stored?.ollamaModel),
  };
}

export function saveProviderSettings(settings: ProviderSettings): void {
  writeJson(PROVIDER_KEY, {
    apiKey: settings.apiKey?.trim() || undefined,
    baseUrl: settings.baseUrl?.trim() || undefined,
    kind: settings.kind === "ollama" ? "ollama" : undefined,
    ollamaBaseUrl: settings.ollamaBaseUrl?.trim() || undefined,
    ollamaModel: settings.ollamaModel?.trim() || undefined,
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

/** Shape of the provider field accepted by /api/chat. */
export type ChatRequestProvider =
  | { apiKey?: string; baseUrl?: string }
  | { baseUrl: string; kind: "ollama" };

/**
 * Extra chat-request body fields derived from saved settings. Returns
 * undefined when nothing is overridden so callers can pass it through
 * unchanged.
 */
export function providerRequestBody():
  | { provider: ChatRequestProvider }
  | undefined {
  const settings = getProviderSettings();

  if (settings.kind === "ollama") {
    // Incomplete Ollama setup falls back to the server default rather
    // than sending a half-configured provider.
    if (!settings.ollamaBaseUrl) return undefined;
    return {
      provider: { baseUrl: settings.ollamaBaseUrl, kind: "ollama" },
    };
  }

  const { apiKey, baseUrl } = settings;
  if (!apiKey && !baseUrl) return undefined;
  return { provider: { apiKey, baseUrl } };
}

/**
 * Merge model selection + provider settings into one request body.
 * With Ollama active, the model chosen in Settings wins over the chat
 * header selector (which lists the default server's models).
 */
export function chatRequestBody(
  model: string | null
): { model?: string; provider?: ChatRequestProvider } | undefined {
  const settings = getProviderSettings();

  if (settings.kind === "ollama" && settings.ollamaBaseUrl) {
    return {
      model: settings.ollamaModel || undefined,
      provider: { baseUrl: settings.ollamaBaseUrl, kind: "ollama" },
    };
  }

  const provider = providerRequestBody();
  if (!model && !provider) return undefined;
  return { ...(model ? { model } : {}), ...(provider ?? {}) };
}
