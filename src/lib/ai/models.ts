/**
 * Server-side helper to list the models served by the OpenAI-compatible
 * endpoint, including their context-window limits (used by the client to
 * auto-detect the context size of the selected model). Cached briefly so
 * repeated calls (model selector + per-request validation) don't hammer
 * the upstream.
 */

const baseURL = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;

export type ModelInfo = {
  id: string;
  /** Total prompt+completion token budget for one request. */
  contextLength: number | null;
  /** Largest completion the model will generate. */
  maxOutputTokens: number | null;
};

type UpstreamModel = {
  id?: string;
  context_length?: number;
  max_completion_tokens?: number;
  capabilities?: {
    contextWindow?: number;
    maxOutput?: number;
  };
};

const CACHE_TTL_MS = 30_000;
let cache: { models: ModelInfo[]; fetchedAt: number } | null = null;

/** First finite positive number among the candidates. */
function firstPositive(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
  }
  return null;
}

export async function listModels(): Promise<ModelInfo[]> {
  if (!baseURL) return [];

  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
      headers: apiKey
        ? { Authorization: `Bearer ${apiKey}` }
        : undefined,
      signal: controller.signal,
      cache: "no-store",
    });

    if (!res.ok) return cache?.models ?? [];

    const data = (await res.json()) as { data?: UpstreamModel[] };
    const models = (data.data ?? [])
      .map((m): ModelInfo | null => {
        if (typeof m.id !== "string" || m.id.length === 0) return null;
        return {
          id: m.id,
          contextLength: firstPositive(m.context_length, m.capabilities?.contextWindow),
          maxOutputTokens: firstPositive(m.max_completion_tokens, m.capabilities?.maxOutput),
        };
      })
      .filter((m): m is ModelInfo => m !== null);

    cache = { models, fetchedAt: Date.now() };
    return models;
  } catch {
    return cache?.models ?? [];
  } finally {
    clearTimeout(timeout);
  }
}
