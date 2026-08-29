import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";

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
 * Some OpenAI-compatible gateways append SSE terminator frames
 * (`data: [DONE]`) even to *non-streaming* JSON responses. The AI SDK
 * parses such bodies as plain JSON and fails with
 * "Invalid JSON response", which permanently breaks non-streaming
 * background jobs (sleep_consolidation, reflect_turn).
 *
 * This fetch wrapper strips that stray tail from JSON responses before
 * the SDK sees them. The request body (not response headers) is the
 * reliable discriminator: misbehaving gateways may label non-streaming
 * responses `text/event-stream`, so we only rewrite when the *request*
 * did not ask for streaming.
 */
export async function sanitizeNonStreamJsonFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const response = await fetch(input, init);

  // Only rewrite bodies the caller will read as a single JSON document.
  // Real streaming requests (`stream: true` in the request body) are
  // forwarded untouched so the SSE parser keeps its own [DONE] handling.
  if (init?.body == null || typeof init.body !== "string") return response;
  if (/"stream"\s*:\s*true/.test(init.body)) return response;

  const text = await response.clone().text();
  const cleaned = stripStraySseTail(text);
  if (cleaned === text) {
    return response;
  }

  return new Response(cleaned, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Remove trailing SSE terminator garbage (any mix of `data: [DONE]`,
 * `event: done` markers, blank lines, whitespace) from an otherwise
 * well-formed JSON body. Invalid JSON is returned unchanged so the SDK
 * reports the real error.
 */
export function stripStraySseTail(body: string): string {
  if (!body.includes("[DONE]") && !/event:\s*done/i.test(body)) return body;

  // Repeatedly peel SSE terminator frames off the end. Markers may be
  // glued directly to the JSON (`}data: [DONE]`) or on their own lines.
  const tailPattern =
    /(?:\s*(?:data:\s*\[DONE\]|event:\s*done)\s*)+$/i;

  const candidate = body.replace(tailPattern, "");
  if (candidate === body) return body;

  // Sanity: the remaining prefix must parse as JSON; otherwise leave
  // the original untouched (e.g. marker text inside a payload).
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return body;
  }
}

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
      fetch: sanitizeNonStreamJsonFetch,
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
    fetch: sanitizeNonStreamJsonFetch,
  });
}

export function getDefaultModel() {
  const model = getProvider().chatModel(defaultModelId);
  return wrapLanguageModel({
    model,
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
}

export const llm = {
  chatModel: (modelId: string, overrides?: ProviderOverrides) => {
    const model = getProvider(overrides).chatModel(modelId);
    return wrapLanguageModel({
      model,
      middleware: extractReasoningMiddleware({ tagName: "think" }),
    });
  },
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


