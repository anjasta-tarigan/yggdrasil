import { tool } from "ai";
import { z } from "zod";
import { runWebSearch } from "@/lib/web-search";
import { assertSafeUrl } from "@/lib/security/ssrf";

/**
 * Web tools: search and page fetching.
 *
 * - web_search: multi-provider web search (Exa → Firecrawl → SearXNG)
 *   with automatic fallback and quota cooldowns; see lib/web-search.ts.
 * - web_fetch: Firecrawl scrape to read a specific URL as markdown.
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

export const web_fetch = tool({
  description:
    "Fetch a web page and return its content as markdown using Firecrawl. Use after web_search to read a specific URL in detail.",
  inputSchema: z.object({
    url: z.url().describe("The absolute URL of the page to fetch"),
    maxCharacters: z
      .number()
      .int()
      .min(200)
      .max(20000)
      .default(4000)
      .describe("Maximum characters of markdown to return"),
  }),
  execute: async ({ url, maxCharacters }) => {
    // Validate the URL against SSRF rules before initiating scraping
    await assertSafeUrl(url);

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
  },
});
