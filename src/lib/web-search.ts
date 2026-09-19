import { refreshEnv, type AppEnv } from "@/env";

import { getSettingDb } from "@/lib/settings-service";

/**
 * Multi-provider web search with automatic fallback.
 *
 * Providers are tried in priority order (Settings → Tools). When a
 * provider fails — quota exhausted (402/429), auth rejected (401/403),
 * network error, or empty results — the next enabled provider is tried.
 * Quota/auth failures put a provider on a temporary cooldown so an
 * exhausted key is not hammered on every search.
 *
 * Providers:
 *  - exa       — Exa neural search (EXA_API_KEY env or stored override)
 *  - firecrawl — Firecrawl /v2/search (FIRECRAWL_API_KEY env or override)
 *  - searxng   — self-hosted SearXNG instance JSON API (no key; needs the
 *                instance URL from SEARXNG_BASE_URL env or stored override)
 */

export type WebSearchProviderKind = "exa" | "firecrawl" | "searxng";

export type WebSearchProviderConfig = {
  kind: WebSearchProviderKind;
  enabled: boolean;
  /** Optional API key override; falls back to the provider's env var. */
  apiKey?: string;
  /** SearXNG instance URL, or a self-hosted Firecrawl base URL. */
  baseUrl?: string;
};

export type WebSearchSettings = {
  /** Ordered by priority — first enabled provider is tried first. */
  providers: WebSearchProviderConfig[];
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

export type WebSearchAttempt = {
  provider: WebSearchProviderKind;
  ok: boolean;
  /** Present when the attempt failed or was skipped. */
  error?: string;
};

export type WebSearchOutcome = {
  query: string;
  /** Provider that produced the results. */
  provider: WebSearchProviderKind;
  results: WebSearchResult[];
  /** Every attempt in order; length > 1 means a fallback happened. */
  attempts: WebSearchAttempt[];
};

export type WebSearchOptions = {
  numResults?: number;
  includeText?: boolean;
  /** Per-provider request timeout in milliseconds. */
  timeoutMs?: number;
};

/** Cooldown applied after quota/auth failures (15 minutes). */
export const QUOTA_COOLDOWN_MS = 15 * 60 * 1000;

const DEFAULT_TIMEOUT_MS = 10_000;

/** HTTP statuses that mean "this provider is unusable for a while". */
const QUOTA_STATUSES = new Set([401, 402, 403, 429]);

// In-memory cooldown registry: provider kind -> usable again at (epoch ms).
const cooldownUntil = new Map<WebSearchProviderKind, number>();

/** Test hook: clear all provider cooldowns. */
export function resetSearchCooldowns(): void {
  cooldownUntil.clear();
}

/** Test/inspection hook: whether a provider is currently cooling down. */
export function isProviderCoolingDown(
  kind: WebSearchProviderKind,
  now: number = Date.now()
): boolean {
  const until = cooldownUntil.get(kind);
  return until !== undefined && until > now;
}

function setCooldown(kind: WebSearchProviderKind, now: number = Date.now()) {
  cooldownUntil.set(kind, now + QUOTA_COOLDOWN_MS);
}

class ProviderError extends Error {
  constructor(
    message: string,
    /** True when the failure is quota/auth related (triggers cooldown). */
    readonly quota: boolean
  ) {
    super(message);
  }
}

// ---- Configuration ----

function isProviderConfig(value: unknown): value is WebSearchProviderConfig {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    (p.kind === "exa" || p.kind === "firecrawl" || p.kind === "searxng") &&
    typeof p.enabled === "boolean"
  );
}

/**
 * Effective provider chain: the stored configuration when present,
 * otherwise a default chain built from whichever env vars exist
 * (exa first, then firecrawl, then searxng). SearXNG only appears when
 * it has an instance URL — it is self-hosted, so there is no default.
 */
export function getWebSearchChain(
  runtimeEnv: AppEnv = refreshEnv()
): WebSearchProviderConfig[] {
  let stored: unknown;
  try {
    stored = getSettingDb("websearch");
  } catch (err) {
    console.debug(`[web-search] Error: ${err instanceof Error ? err.message : String(err)}`);
    stored = undefined;
  }

  if (
    typeof stored === "object" &&
    stored !== null &&
    Array.isArray((stored as { providers?: unknown }).providers)
  ) {
    const providers = (stored as { providers: unknown[] }).providers
      .filter(isProviderConfig)
      .map((p) => ({
        kind: p.kind,
        enabled: p.enabled,
        apiKey: typeof p.apiKey === "string" && p.apiKey ? p.apiKey : undefined,
        baseUrl:
          typeof p.baseUrl === "string" && p.baseUrl ? p.baseUrl : undefined,
      }));
    if (providers.length > 0) return providers;
  }

  // `runtimeEnv` is the call-time snapshot (passed in by `runWebSearch`, or
  // freshly parsed as the default) — the module-level `env` singleton is
  // parsed once at load, so callers that rotate keys at runtime need this.
  const defaults: WebSearchProviderConfig[] = [];
  if (runtimeEnv.EXA_API_KEY) {
    defaults.push({ kind: "exa", enabled: true });
  }
  if (runtimeEnv.FIRECRAWL_API_KEY) {
    defaults.push({ kind: "firecrawl", enabled: true });
  }
  if (runtimeEnv.SEARXNG_BASE_URL) {
    defaults.push({
      kind: "searxng",
      enabled: true,
      baseUrl: runtimeEnv.SEARXNG_BASE_URL,
    });
  }
  return defaults;
}

/**
 * Whether a provider entry can actually serve requests right now — its
 * credentials (API key or instance URL) resolve from the entry itself or
 * the environment.
 */
export function isProviderReady(
  config: WebSearchProviderConfig,
  runtimeEnv: AppEnv = refreshEnv()
): boolean {
  switch (config.kind) {
    case "exa":
      return Boolean(config.apiKey || runtimeEnv.EXA_API_KEY);
    case "firecrawl":
      return Boolean(config.apiKey || runtimeEnv.FIRECRAWL_API_KEY);
    case "searxng":
      return Boolean(config.baseUrl || runtimeEnv.SEARXNG_BASE_URL);
  }
}

// ---- Providers ----

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function searchExa(
  query: string,
  opts: Required<Pick<WebSearchOptions, "numResults" | "includeText">>,
  config: WebSearchProviderConfig,
  timeoutMs: number,
  runtimeEnv: AppEnv
): Promise<WebSearchResult[]> {
  const apiKey = config.apiKey || runtimeEnv.EXA_API_KEY;
  if (!apiKey) throw new ProviderError("Exa API key not configured", false);

  const res = await fetchWithTimeout(
    "https://api.exa.ai/search",
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        numResults: opts.numResults,
        ...(opts.includeText
          ? { contents: { text: { maxCharacters: 1000 } } }
          : {}),
      }),
    },
    timeoutMs
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(
      `Exa search failed (${res.status}): ${body.slice(0, 200)}`,
      QUOTA_STATUSES.has(res.status)
    );
  }

  const data = (await res.json()) as {
    results?: Array<{ id?: string; title?: string; url?: string; text?: string }>;
  };
  return (data.results ?? []).map((r) => ({
    title: r.title ?? r.url ?? r.id ?? "Untitled",
    url: r.url ?? r.id ?? "",
    ...(r.text ? { snippet: r.text } : {}),
  }));
}

async function searchFirecrawl(
  query: string,
  opts: Required<Pick<WebSearchOptions, "numResults" | "includeText">>,
  config: WebSearchProviderConfig,
  timeoutMs: number,
  runtimeEnv: AppEnv
): Promise<WebSearchResult[]> {
  const apiKey = config.apiKey || runtimeEnv.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new ProviderError("Firecrawl API key not configured", false);
  }
  const base = (config.baseUrl || "https://api.firecrawl.dev").replace(
    /\/$/,
    ""
  );

  const res = await fetchWithTimeout(
    `${base}/v2/search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        limit: opts.numResults,
        sources: ["web"],
        ...(opts.includeText ? { highlights: true } : {}),
      }),
    },
    timeoutMs
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(
      `Firecrawl search failed (${res.status}): ${body.slice(0, 200)}`,
      QUOTA_STATUSES.has(res.status)
    );
  }

  type FirecrawlRow = {
    title?: string;
    description?: string;
    url?: string;
    highlight?: string;
  };
  const data = (await res.json()) as {
    success?: boolean;
    error?: string;
    data?: FirecrawlRow[] | { web?: FirecrawlRow[] };
  };

  if (data.success === false) {
    throw new ProviderError(
      `Firecrawl search error: ${data.error || "unknown error"}`,
      false
    );
  }

  const rows: FirecrawlRow[] = Array.isArray(data.data)
    ? data.data
    : (data.data?.web ?? []);
  return rows
    .filter((r): r is FirecrawlRow & { url: string } => Boolean(r.url))
    .map((r) => {
      const snippet = opts.includeText
        ? (r.highlight ?? r.description)
        : undefined;
      return {
        title: r.title ?? r.url,
        url: r.url,
        ...(snippet ? { snippet } : {}),
      };
    });
}

async function searchSearxng(
  query: string,
  opts: Required<Pick<WebSearchOptions, "numResults" | "includeText">>,
  config: WebSearchProviderConfig,
  timeoutMs: number,
  runtimeEnv: AppEnv
): Promise<WebSearchResult[]> {
  const baseUrl = config.baseUrl || runtimeEnv.SEARXNG_BASE_URL;
  if (!baseUrl) {
    throw new ProviderError("SearXNG instance URL not configured", false);
  }
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/search?${new URLSearchParams({
    q: query,
    format: "json",
    pageno: "1",
  }).toString()}`;

  const res = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        // Many public instances block the default Node fetch user agent.
        "User-Agent": "Yggdrasil/0.1 (self-hosted assistant; web_search tool)",
      },
    },
    timeoutMs
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(
      `SearXNG search failed (${res.status}): ${body.slice(0, 200)}`,
      QUOTA_STATUSES.has(res.status)
    );
  }

  let data: { results?: Array<{ title?: string; url?: string; content?: string }> };
  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    console.debug(`[web-search] Error: ${err instanceof Error ? err.message : String(err)}`);
    throw new ProviderError(
      "SearXNG returned a non-JSON response — enable the JSON format on the instance (search.formats: [html, json] in settings.yml)",
      false
    );
  }
  return (data.results ?? [])
    .filter((r) => typeof r.url === "string" && r.url)
    .slice(0, opts.numResults)
    .map((r) => ({
      title: r.title ?? r.url ?? "Untitled",
      url: r.url as string,
      ...(opts.includeText && r.content ? { snippet: r.content } : {}),
    }));
}

const PROVIDER_FNS: Record<
  WebSearchProviderKind,
  (
    query: string,
    opts: Required<Pick<WebSearchOptions, "numResults" | "includeText">>,
    config: WebSearchProviderConfig,
    timeoutMs: number,
    runtimeEnv: AppEnv
  ) => Promise<WebSearchResult[]>
> = {
  exa: searchExa,
  firecrawl: searchFirecrawl,
  searxng: searchSearxng,
};

// ---- Fallback chain ----

/**
 * Run a web search across the configured provider chain. Throws only
 * when every enabled provider fails; the error summarizes each attempt.
 */
export async function runWebSearch(
  query: string,
  options: WebSearchOptions = {}
): Promise<WebSearchOutcome> {
  const numResults = Math.min(Math.max(options.numResults ?? 5, 1), 10);
  const includeText = options.includeText ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Re-read env once per call (runtime keys can rotate via the admin UI); the
  // module-level `env` singleton is parsed once at load. Passing the snapshot
  // down avoids re-parsing the schema per provider.
  const runtimeEnv = refreshEnv();
  const chain = getWebSearchChain(runtimeEnv);
  const attempts: WebSearchAttempt[] = [];

  if (chain.length === 0) {
    throw new Error(
      "No web search providers configured. Add an API key (EXA_API_KEY / FIRECRAWL_API_KEY) or configure providers in Settings → Tools."
    );
  }

  for (const provider of chain) {
    if (!provider.enabled) continue;

    if (isProviderCoolingDown(provider.kind)) {
      attempts.push({
        provider: provider.kind,
        ok: false,
        error: "skipped (quota cooldown)",
      });
      continue;
    }

    try {
      const results = await PROVIDER_FNS[provider.kind](
        query,
        { numResults, includeText },
        provider,
        timeoutMs,
        runtimeEnv
      );
      if (results.length === 0) {
        // Empty page — give the next provider a chance.
        attempts.push({
          provider: provider.kind,
          ok: false,
          error: "no results",
        });
        continue;
      }
      attempts.push({ provider: provider.kind, ok: true });
      return { query, provider: provider.kind, results, attempts };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      if (error instanceof ProviderError && error.quota) {
        setCooldown(provider.kind);
      }
      attempts.push({ provider: provider.kind, ok: false, error: message });
    }
  }

  const summary = attempts
    .map((a) => `${a.provider}: ${a.ok ? "ok" : a.error}`)
    .join("; ");
  throw new Error(
    attempts.length === 0
      ? "No enabled web search providers — enable at least one provider in Settings → Tools."
      : `All web search providers failed — ${summary}`
  );
}
