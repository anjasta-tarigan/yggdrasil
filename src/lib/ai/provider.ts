import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * OpenAI-compatible provider pointing at the self-hosted vLLM server.
 *
 * Configuration comes from environment variables (see .env.example):
 * - LLM_BASE_URL  e.g. http://localhost:20128/v1
 * - LLM_MODEL_ID  e.g. ps/poolside/laguna-s-2.1
 * - LLM_API_KEY   bearer token when the server was started with --api-key
 */

export const defaultModelId =
  process.env.LLM_MODEL_ID ?? "ps/poolside/laguna-s-2.1";

/**
 * Per-request provider overrides coming from the client Settings page.
 * Empty/absent fields fall back to the server environment.
 *
 * kind "ollama" routes through Ollama's OpenAI-compatible /v1 API —
 * Ollama needs no API key (the SDK only requires a non-empty string).
 */
export type ProviderOverrides = {
  apiKey?: string;
  baseUrl?: string;
  kind?: "ollama" | "openai-compatible";
};

export function getProvider(overrides?: ProviderOverrides) {
  if (overrides?.kind === "ollama" && overrides.baseUrl) {
    return createOpenAICompatible({
      name: "ollama",
      baseURL: `${overrides.baseUrl.replace(/\/$/, "")}/v1`,
      apiKey: "ollama",
    });
  }

  const baseURL = overrides?.baseUrl || process.env.LLM_BASE_URL;
  if (!baseURL) {
    throw new Error("LLM_BASE_URL is not set. Add it to .env.local");
  }
  // If baseUrl was overridden by the user, only use the user's explicit apiKey
  // to avoid leaking the server's private LLM_API_KEY to third-party endpoints.
  const apiKey = overrides?.baseUrl
    ? overrides.apiKey || undefined
    : overrides?.apiKey || process.env.LLM_API_KEY || undefined;

  return createOpenAICompatible({
    name: "vllm",
    baseURL,
    apiKey,
  });
}

export function getDefaultModel() {
  return getProvider().chatModel(defaultModelId);
}

export const llm = {
  chatModel: (modelId: string, overrides?: ProviderOverrides) =>
    getProvider(overrides).chatModel(modelId),
};

export const defaultModel = new Proxy({} as ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]>, {
  get(_target, prop, receiver) {
    const target = getDefaultModel();
    const value = Reflect.get(target, prop, receiver);
    if (typeof value === "function") {
      return value.bind(target);
    }
    return value;
  },
});

/**
 * Shape-guard client provider settings. Only http(s) base URLs and
 * bounded strings are accepted; anything malformed is ignored so the
 * server environment stays authoritative.
 */
export function sanitizeProviderOverrides(
  value: unknown
): ProviderOverrides | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const baseUrl =
    typeof v.baseUrl === "string" &&
    v.baseUrl.length <= 2048 &&
    /^https?:\/\//.test(v.baseUrl)
      ? v.baseUrl.trim()
      : undefined;

  // Ollama: endpoint only, no API key.
  if (v.kind === "ollama") {
    return baseUrl ? { baseUrl, kind: "ollama" } : undefined;
  }

  const apiKey =
    typeof v.apiKey === "string" && v.apiKey.length <= 2048
      ? v.apiKey.trim() || undefined
      : undefined;
  if (!baseUrl && !apiKey) return undefined;
  return { apiKey, baseUrl };
}


