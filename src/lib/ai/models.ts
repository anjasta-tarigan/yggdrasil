/**
 * Server-side helper to browse the models served by a provider
 * endpoint, including their context-window limits (used by the client to
 * auto-detect the context size of the selected model). Cached briefly so
 * repeated calls (model selector + per-request validation) don't hammer
 * the upstream.
 */

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

type OllamaTag = {
  name?: string;
};

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { models: ModelInfo[]; fetchedAt: number }>();

/** First finite positive number among the candidates. */
function firstPositive(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
  }
  return null;
}

/**
 * List the models served by a provider endpoint, using explicit
 * credentials (no environment reads at module init).
 *
 * - openai-compatible: GET {baseUrl}/models, Bearer auth when a key is
 *   given, parsing context_length/max_completion_tokens with
 *   capabilities fallbacks.
 * - ollama: GET {baseUrl}/api/tags, mapping names with unknown limits.
 */
export async function browseProviderModels(
  baseUrl: string,
  apiKey: string | undefined,
  kind: "openai-compatible" | "ollama"
): Promise<ModelInfo[]> {
  if (!baseUrl) return [];

  const key = `${kind}|${baseUrl}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    if (kind === "ollama") {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) return cached?.models ?? [];

      const data = (await res.json()) as { models?: OllamaTag[] };
      const models = (data.models ?? [])
        .map((m): ModelInfo | null => {
          if (typeof m.name !== "string" || m.name.length === 0) return null;
          return {
            id: m.name,
            contextLength: null,
            maxOutputTokens: null,
          };
        })
        .filter((m): m is ModelInfo => m !== null);

      cache.set(key, { models, fetchedAt: Date.now() });
      return models;
    }

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: apiKey
        ? { Authorization: `Bearer ${apiKey}` }
        : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return cached?.models ?? [];

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

    cache.set(key, { models, fetchedAt: Date.now() });
    return models;
  } catch {
    return cached?.models ?? [];
  } finally {
    clearTimeout(timeout);
  }
}
