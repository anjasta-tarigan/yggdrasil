import { tool } from "ai";
import { z } from "zod";
import { runWebSearch } from "@/lib/web-search";
import { assertSafeUrl } from "@/lib/security/ssrf";
import TurndownService from "turndown";

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

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;

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
    return runWebSearch(query, { numResults, includeText });
  },
});

/**
 * Native fetch + HTML→Markdown conversion fallback.
 * Used when Firecrawl fails (e.g., quota exhausted).
 */
async function fetchWithNative(url: string, maxCharacters: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Yggdrasil-Bot/1.0",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

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
    clearTimeout(timeout);
    // Re-throw with context
    throw new Error(`Native fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Firecrawl scraping (primary provider).
 */
async function fetchWithFirecrawl(url: string, maxCharacters: number) {
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

export const web_fetch = tool({
  description:
    "Fetch a web page and return its content as markdown. Primary provider is Firecrawl (uses API key); if Firecrawl fails (e.g., quota exhausted, missing key), automatically falls back to a native HTTP fetch + HTML-to-Markdown conversion (no API cost). Use after web_search to read a specific URL in detail.",
  inputSchema: z.object({
    url: z.url().describe("The absolute URL of the page to fetch"),
    // Clamp instead of reject: a model asking for more than the cap used
    // to raise AI_InvalidToolInputError, which killed the whole stream
    // mid-generation. Models routinely request 30000; honoring the intent
    // (as much as allowed) keeps the turn alive.
    maxCharacters: z.coerce
      .number()
      .int()
      .min(200)
      .catch(200)
      .transform((v) => Math.min(20000, Math.max(200, v)))
      .describe("Maximum characters of markdown to return (clamped to 20000)"),
  }),
  execute: async ({ url, maxCharacters }) => {
    // Validate the URL against SSRF rules before any fetch
    await assertSafeUrl(url);

    let lastError: Error | undefined;

    // 1. Try Firecrawl first (if API key is present)
    if (FIRECRAWL_API_KEY) {
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
  },
});