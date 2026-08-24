/**
 * Server-side helper to list the models served by the OpenAI-compatible
 * endpoint. Cached briefly so repeated calls (model selector + per-request
 * validation) don't hammer the upstream.
 */

const baseURL = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;

const CACHE_TTL_MS = 30_000;
let cache: { models: string[]; fetchedAt: number } | null = null;

export async function listModels(): Promise<string[]> {
  if (!baseURL) return [];

  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
      cache: "no-store",
    });

    if (!res.ok) return cache?.models ?? [];

    const data = (await res.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");

    cache = { models, fetchedAt: Date.now() };
    return models;
  } catch {
    return cache?.models ?? [];
  } finally {
    clearTimeout(timeout);
  }
}
