import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";
import { loadRegistry, resolveApiKey } from "./provider-config/store";
import type { ModelEntry, ProviderEntry } from "./provider-config/schema";
import { createRotatingProviderFetch } from "./provider-fetch";
import { createWebProviderModel } from "./web-provider/language-model";
import type { WebProviderSession } from "./web-provider/types";

/**
 * Registry-backed provider factory: builds AI SDK providers and chat
 * models from provider-config registry entries. The registry (written by
 * the Settings → Providers UI) is the single source of truth for
 * base URLs, API keys and model lists.
 */

/**
 * Some OpenAI-compatible gateways append SSE terminator frames
 * (`data: [DONE]`) even to *non-streaming* JSON responses. The AI SDK
 * parses such bodies as plain JSON and fails with
 * "Invalid JSON response", which permanently breaks non-streaming
 * background jobs (sleep_consolidation, reflect_turn).
 *
 * Furthermore, some reasoning models and gateways (e.g. Poolside Laguna,
 * DeepSeek R1) output the constrained decoding result into `reasoning_content`
 * (or `reasoning`) while leaving `content: null` when `response_format` is
 * enabled. When `content` is empty/null, the AI SDK treats `text` as empty
 * and fails structured output (`Output.object`) with `AI_NoObjectGeneratedError`.
 *
 * This fetch wrapper:
 * 1. Strips stray SSE tail markers from non-streaming JSON responses.
 * 2. Promotes `reasoning_content` to `content` if `content` was left empty/null,
 *    ensuring structured outputs and non-streaming text extractors can read it.
 *
 * The request body (not response headers) is the reliable discriminator:
 * misbehaving gateways may label non-streaming responses `text/event-stream`,
 * so we only rewrite when the *request* did not ask for streaming.
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
  const promoted = promoteEmptyContentReasoning(cleaned);
  if (promoted === text) {
    return response;
  }

  return new Response(promoted, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * When an OpenAI-compatible model emits its response in `reasoning_content`
 * or `reasoning` while leaving `content` null or empty, copy that text into
 * `content` so downstream SDK parsers and structured output extractors
 * receive the generated text instead of an empty string.
 */
export function promoteEmptyContentReasoning(body: string): string {
  if (!body.includes("reasoning")) return body;

  try {
    const data = JSON.parse(body);
    if (!data || typeof data !== "object" || !Array.isArray(data.choices)) {
      return body;
    }

    let modified = false;
    for (const choice of data.choices) {
      const msg = choice?.message;
      if (!msg || typeof msg !== "object") continue;

      const content = msg.content;
      const reasoning = msg.reasoning_content ?? msg.reasoning;

      const isContentEmpty =
        content == null ||
        (typeof content === "string" && content.trim().length === 0);

      const hasReasoning =
        typeof reasoning === "string" && reasoning.trim().length > 0;

      if (isContentEmpty && hasReasoning) {
        msg.content = reasoning;
        modified = true;
      }
    }

    return modified ? JSON.stringify(data) : body;
  } catch (err) {
    console.debug(`[provider] Error: ${err instanceof Error ? err.message : String(err)}`);
    return body;
  }
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
  } catch (err) {
    console.debug(`[provider] Error: ${err instanceof Error ? err.message : String(err)}`);
    return body;
  }
}

/**
 * Internal factory: builds an OpenAI-compatible provider instance with
 * standard base URL normalization, structured outputs support, and the
 * non-stream JSON SSE-tail sanitizer.
 *
 * - kind "ollama" routes through Ollama's OpenAI-compatible /v1 API and
 *   needs no API key (the SDK only requires a non-empty dummy string).
 * - kind "openai-compatible" uses the entry ID or "openai-compatible"
 *   as its provider name instead of a hardcoded server label.
 * - supportsStructuredOutputs enables JSON schema enforcement on cloud
 *   and modern local engines (resolving AI SDK responseFormat warnings).
 */
function createProviderInstance(entry: ProviderEntry, apiKey?: string) {
  if (!entry.baseUrl) {
    throw new Error(
      `Provider "${entry.id}" has no baseUrl configured — add one in Settings → Providers.`
    );
  }

  const isOllama = entry.kind === "ollama";
  return createOpenAICompatible({
    name: isOllama ? "ollama" : (entry.id || "openai-compatible"),
    baseURL: isOllama
      ? `${entry.baseUrl.replace(/\/$/, "")}/v1`
      : entry.baseUrl,
    apiKey: isOllama ? "ollama" : (apiKey ?? undefined),
    supportsStructuredOutputs: true,
    fetch: entry.apiKeys?.length
      ? createRotatingProviderFetch(entry, sanitizeNonStreamJsonFetch)
      : sanitizeNonStreamJsonFetch,
  });
}

/**
 * Registry entry → OpenAI-compatible provider instance.
 */
export async function getProviderForEntry(entry: ProviderEntry) {
  const apiKey =
    entry.kind === "ollama" ? "ollama" : await resolveApiKey(entry);
  return createProviderInstance(entry, apiKey);
}

/**
 * Sync model builder from a registry entry: builds the provider instance
 * and wraps the chat model with the extract-reasoning middleware so <think>
 * blocks are separated from the visible answer.
 *
 * `kind: "web-session"` short-circuits before provider construction: those
 * entries (DeepSeek Web) carry a browser-session token instead of an API key
 * and speak the site's private SSE protocol, so they are served by
 * `createWebProviderModel` and never by `createOpenAICompatible`. Branching
 * here — not at the call sites — keeps every caller on one code path while
 * guaranteeing a web-session entry can never be handed to the OpenAI
 * provider (which would request a key that does not exist).
 *
 * `session` is the verified session the chat route resolved; a caller that
 * omits it gets a model that fails loudly on generation rather than an empty
 * stream.
 */
export function chatModelForEntry(
  modelId: string,
  entry: ProviderEntry,
  apiKey?: string,
  session?: WebProviderSession | null
) {
  if (entry.kind === "web-session") {
    return createWebProviderModel(entry, modelId, session ?? null);
  }
  const provider = createProviderInstance(entry, apiKey);
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
 * The registry's default model: the single isDefault:true entry, or null
 * when none is marked. Never falls back to "first model of first
 * provider" — a silent fallback runs unattended background jobs (memory
 * reflection, consolidation, subagents) on a model the user never chose.
 * A fresh install has no default until the user sets one in
 * Settings → Providers.
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
  return null;
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
