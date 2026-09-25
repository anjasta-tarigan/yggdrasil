import { tool } from "ai";
import { z } from "zod";
import { refreshEnv } from "@/env";
import { runWebSearch } from "@/lib/web-search";
import { assertSafeUrl, secureFetch } from "@/lib/security/ssrf";
import { wrapUntrustedContent } from "@/lib/ai/untrusted-content";
import TurndownService from "turndown";

/** Bounds for web_fetch's returned markdown length. */
const MIN_CHARACTERS = 200;
const MAX_CHARACTERS_CAP = 20_000;
/** Used when the model omits `maxCharacters` — a readable page, not a stub. */
const DEFAULT_MAX_CHARACTERS = 20_000;

/**
 * Web tools: search and page fetching.
 *
 * - web_search: multi-provider web search (Exa → Firecrawl → SearXNG)
 *   with automatic fallback and quota cooldowns; see lib/web-search.ts.
 * - web_fetch: primary provider Firecrawl; fallback to native HTTP fetch
 *   + HTML-to-Markdown conversion when Firecrawl fails (quota, network, etc.).
 *
 * Both tools require at least one configured provider (API keys or
 * SearXNG instance URL in .env.local, or overrides in Settings → Tools).
 * When none is available the tool throws a clear error that surfaces in
 * the UI as an output-error state.
 */

// Read at CALL time, not module load: a key that is set, rotated or
// removed after the server booted must be honored on the next call.
// This is a deliberate exception to the centralized env pattern: provider
// API keys can be injected/changed at runtime via Settings → Tools and
// must be re-read on each invocation rather than frozen at import time.
function getFirecrawlApiKey(): string | undefined {
  return refreshEnv().FIRECRAWL_API_KEY || undefined;
}

export const web_search = tool({
  description:
    "Search the web for current, factual, or external information. Configured providers (Exa, Firecrawl, SearXNG) are tried in priority order with automatic fallback when one fails or runs out of quota. Call this tool autonomously whenever answering questions about recent events, current versions/releases, documentation, library APIs, weather, news, or facts you need to verify. Do not wait for the user to ask for a web search.",
  inputSchema: z.object({
    query: z.string().describe("The search query keywords or semantic question"),
    numResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("Number of results to return (1-10)"),
    includeText: z
      .boolean()
      .default(false)
      .describe("Whether to include short text snippets from each result page"),
  }),
  execute: async ({ query, numResults, includeText }) => {
    // Provider selection, fallback order and quota cooldowns are handled
    // by the multi-provider search stack (lib/web-search.ts). The outcome
    // reports which provider answered plus every attempt made.
    const outcome = await runWebSearch(query, { numResults, includeText });
    return frameSearchOutcome(outcome);
  },
});

/**
 * Native fetch + HTML→Markdown conversion fallback.
 * Used when Firecrawl fails (e.g., quota exhausted).
 */
async function fetchWithNative(url: string, maxCharacters: number) {
  try {
    const response = await secureFetch(url, {
      headers: {
        "User-Agent": "Yggdrasil-Bot/1.0",
        Accept: "text/html,application/xhtml+xml",
      },
      timeoutMs: 10_000,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();

    // Convert HTML to Markdown using turndown
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    // Remove unwanted elements
    turndown.remove("script");
    turndown.remove("style");
    turndown.remove("noscript");
    turndown.remove("iframe");
    turndown.remove("header");
    turndown.remove("footer");
    turndown.remove("nav");

    let markdown = turndown.turndown(html);

    // Clean up excessive whitespace
    markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

    // Truncate
    const truncated = markdown.length > maxCharacters;
    if (truncated) {
      markdown = markdown.slice(0, maxCharacters);
    }

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : undefined;

    return { url, title, markdown, truncated };
  } catch (err) {
    // Re-throw with context
    throw new Error(`Native fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Firecrawl scraping (primary provider).
 */
async function fetchWithFirecrawl(url: string, maxCharacters: number) {
  const FIRECRAWL_API_KEY = getFirecrawlApiKey();
  if (!FIRECRAWL_API_KEY) {
    throw new Error("FIRECRAWL_API_KEY is not configured on the server.");
  }

  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      // Reuse cached scrapes up to 24h old to save credits and latency.
      maxAge: 86400,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Firecrawl scrape failed (${res.status}): ${body}`);
  }

  const data: {
    success?: boolean;
    error?: string;
    data?: { markdown?: string; metadata?: { title?: string } };
  } = await res.json();

  if (!data.success) {
    throw new Error(
      `Firecrawl scrape failed: ${data.error ?? "unknown error"}`
    );
  }

  const markdown = data.data?.markdown ?? "";
  return {
    url,
    title: data.data?.metadata?.title,
    markdown: markdown.slice(0, maxCharacters),
    truncated: markdown.length > maxCharacters,
  };
}

/**
 * Fetch a page as markdown: Firecrawl first (if a key is set), then a native
 * HTTP fetch + HTML→Markdown fallback. Exported so the durable harness can call
 * it from a `"use step"` function without depending on the tool object's
 * `execute` shape (the step module may import this module; the workflow function
 * may not, since this pulls `ssrf`/`node:dns`).
 */
export async function fetchWebPage(
  url: string,
  maxCharacters: number
): Promise<{ url: string; title?: string; markdown: string; truncated: boolean }> {
  // Validate the URL against SSRF rules before any fetch
  await assertSafeUrl(url);

  let lastError: Error | undefined;

  // 1. Try Firecrawl first (if API key is present)
  if (getFirecrawlApiKey()) {
    try {
      return await fetchWithFirecrawl(url, maxCharacters);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        "Firecrawl fetch failed, falling back to native fetch:",
        lastError.message
      );
    }
  } else {
    console.warn("FIRECRAWL_API_KEY not set; skipping Firecrawl.");
  }

  // 2. Fallback: native fetch (always available)
  try {
    return await fetchWithNative(url, maxCharacters);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(
      `All fetch providers failed. Firecrawl error: ${lastError?.message || "not attempted"}. Native error: ${error.message}`
    );
  }
}

/**
 * Wraps a fetched page for the model, labelling the body as untrusted data.
 *
 * Shared by the chat tool and the durable harness step so both paths frame the
 * page identically — the step calls `fetchWebPage` directly and would otherwise
 * hand the model a raw, unframed body.
 */
export function frameFetchedPage(page: {
  url: string;
  title?: string;
  markdown: string;
  truncated: boolean;
}) {
  return {
    url: page.url,
    title: page.title,
    truncated: page.truncated,
    content: wrapUntrustedContent({
      tag: "untrusted_web_content",
      provenance: `Source: ${page.url}`,
      content: page.markdown,
    }),
  };
}

/**
 * Wraps search-result titles and snippets as untrusted data.
 *
 * Shared by the chat tool and the durable harness step. URLs and provider
 * metadata stay unwrapped — the model needs them as plain values for citation.
 */
export function frameSearchOutcome<T extends {
  results: Array<{ url: string; title: string; snippet?: string }>;
}>(outcome: T): T {
  const results = outcome.results.map((r) => ({
    ...r,
    title: wrapUntrustedContent({
      tag: "untrusted_search_results",
      provenance: `Result title from ${r.url}`,
      content: r.title,
    }),
    ...(r.snippet !== undefined
      ? {
          snippet: wrapUntrustedContent({
            tag: "untrusted_search_results",
            provenance: `Snippet from ${r.url}`,
            content: r.snippet,
          }),
        }
      : {}),
  }));

  return { ...outcome, results };
}

export const web_fetch = tool({
  description:
    "Fetch a web page and return its content as markdown. Primary provider is Firecrawl (uses API key); if Firecrawl fails (e.g., quota exhausted, missing key), automatically falls back to a native HTTP fetch + HTML-to-Markdown conversion (no API cost). Use after web_search to read a specific URL in detail.",
  inputSchema: z.object({
    url: z.url().describe("The absolute URL of the page to fetch"),
    // Clamp instead of reject: a model asking for more than the cap used
    // to raise AI_InvalidToolInputError, which killed the whole stream
    // mid-generation. Models routinely request 30000; honoring the intent
    // (as much as allowed) keeps the turn alive.
    //
    // The omitted-argument default is DEFAULT_MAX_CHARACTERS, not the schema
    // minimum: `.catch(200)` fires both on a bad value AND on a missing one,
    // so defaulting to 200 silently returned ~200 characters of a page
    // whenever the model left the argument out — a truncation the caller
    // could not see.
    maxCharacters: z.coerce
      .number()
      .int()
      .catch(DEFAULT_MAX_CHARACTERS)
      .transform((v) => Math.min(MAX_CHARACTERS_CAP, Math.max(MIN_CHARACTERS, v)))
      .default(DEFAULT_MAX_CHARACTERS)
      .describe(
        `Maximum characters of markdown to return (default ${DEFAULT_MAX_CHARACTERS}, clamped to ${MAX_CHARACTERS_CAP})`
      ),
  }),
  // The page body is attacker-controlled (any site the model fetches), so it is
  // wrapped as labelled data before the model sees it. `fetchWebPage` itself
  // stays raw so programmatic callers (e.g. the durable harness step) keep a
  // clean value to process.
  execute: async ({ url, maxCharacters }) => {
    return frameFetchedPage(await fetchWebPage(url, maxCharacters));
  },
});