import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";
import { loadRegistry, resolveApiKey } from "./provider-config/store";
import type { ModelEntry, ProviderEntry } from "./provider-config/schema";

/**
 * Registry-backed provider factory: builds AI SDK providers and chat
 * models from provider-config registry entries. The registry (written by
 * the Settings → Providers UI) is the single source of truth for
 * base URLs, API keys and model lists.
 */

/** @deprecated temporary bridge — removed in Task 6 */
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
 * Registry entry → OpenAI-compatible provider instance.
 *
 * - kind "ollama" routes through Ollama's OpenAI-compatible /v1 API and
 *   needs no API key (the SDK only requires a non-empty string).
 * - kind "openai-compatible" may be keyless (apiKey undefined).
 */
export async function getProviderForEntry(entry: ProviderEntry) {
  if (!entry.baseUrl) {
    throw new Error(
      `Provider "${entry.id}" has no baseUrl configured — add one in Settings → Providers.`
    );
  }
  const apiKey =
    entry.kind === "ollama" ? "ollama" : await resolveApiKey(entry);
  return createOpenAICompatible({
    name: entry.kind === "ollama" ? "ollama" : "vllm",
    baseURL:
      entry.kind === "ollama"
        ? `${entry.baseUrl.replace(/\/$/, "")}/v1`
        : entry.baseUrl,
    apiKey,
    fetch: sanitizeNonStreamJsonFetch,
  });
}

/**
 * Sync model builder from a registry entry: builds the provider inline
 * (same rules as getProviderForEntry) and wraps the chat model with
 * the extract-reasoning middleware so <think> blocks are separated
 * from the visible answer. `apiKey` is passed directly (the caller
 * resolves it); ollama entries force the "ollama" literal.
 */
export function chatModelForEntry(
  modelId: string,
  entry: ProviderEntry,
  apiKey?: string
) {
  if (!entry.baseUrl) {
    throw new Error(
      `Provider "${entry.id}" has no baseUrl configured — add one in Settings → Providers.`
    );
  }
  const provider = createOpenAICompatible({
    name: entry.kind === "ollama" ? "ollama" : "vllm",
    baseURL:
      entry.kind === "ollama"
        ? `${entry.baseUrl.replace(/\/$/, "")}/v1`
        : entry.baseUrl,
    apiKey:
      entry.kind === "ollama" ? "ollama" : (apiKey ?? undefined),
    fetch: sanitizeNonStreamJsonFetch,
  });
  return wrapLanguageModel({
    model: provider.chatModel(modelId),
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
}

/** Look up a registry provider by id and build its SDK provider. */
export async function getProviderById(id: string) {
  const entry = (await loadRegistry()).providers.find(
    (p) => p.id === id
  );
  if (!entry) {
    throw new Error(`Provider "${id}" not found`);
  }
  return getProviderForEntry(entry);
}

/**
 * The registry's default model: the single isDefault:true model, else
 * the first model of the first provider, else null (empty registry).
 * ProviderConfigError from loadRegistry propagates — callers catch it
 * per use case.
 */
export async function getDefaultModelEntry(): Promise<{
  provider: ProviderEntry;
  model: ModelEntry;
} | null> {
  const doc = await loadRegistry();
  for (const provider of doc.providers) {
    for (const model of provider.models) {
      if (model.isDefault) {
        return { provider, model };
      }
    }
  }
  const fallback = doc.providers.find((p) => p.models.length > 0);
  if (!fallback) return null;
  return { provider: fallback, model: fallback.models[0] };
}

/**
 * Registry-backed default chat model. Throws a user-actionable error
 * when no provider/model is configured at all.
 */
export async function getDefaultModel() {
  const e = await getDefaultModelEntry();
  if (!e) {
    throw new Error(
      "No default model configured — add a provider and model in Settings → Providers."
    );
  }
  return chatModelForEntry(
    e.model.modelId,
    e.provider,
    await resolveApiKey(e.provider)
  );
}

/** @deprecated temporary bridge — removed in Task 6 */
export type ProviderOverrides = {
  apiKey?: string;
  baseUrl?: string;
  kind?: "ollama" | "openai-compatible";
};

/** @deprecated temporary bridge — removed in Task 6 */
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

/** @deprecated temporary bridge — removed in Task 6 */
export const llm = {
  chatModel: (modelId: string, overrides?: ProviderOverrides) => {
    const model = getProvider(overrides).chatModel(modelId);
    return wrapLanguageModel({
      model,
      middleware: extractReasoningMiddleware({ tagName: "think" }),
    });
  },
};

/**
 * @deprecated temporary bridge — removed in Task 6
 *
 * The chat route and subagent-runner still consume the synchronous
 * default model. Migrating them (Tasks 5-6) removes this proxy.
 */
export const defaultModel = new Proxy({} as ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]>, {
  get(_target, prop, receiver) {
    const target = getDefaultModelForProxy();
    const value = Reflect.get(target, prop, receiver);
    if (typeof value === "function") {
      return value.bind(target);
    }
    return value;
  },
});

function getDefaultModelForProxy() {
  const model = getProvider().chatModel(defaultModelId);
  return wrapLanguageModel({
    model,
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
}

/** @deprecated temporary bridge — removed in Task 6 */
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


