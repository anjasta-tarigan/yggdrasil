import { tool } from "ai";
import { z } from "zod";

/**
 * Server-side tools available to the chat model.
 *
 * - web_search: Exa neural search for current information.
 * - fetch_page: Firecrawl scrape to read a specific URL as markdown.
 *
 * Both require their respective API keys in .env.local. When a key is
 * missing the tool throws a clear error that surfaces in the UI as an
 * output-error state.
 */

const EXA_API_KEY = process.env.EXA_API_KEY;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;

type ExaResult = {
  id?: string;
  title?: string;
  url?: string;
  text?: string;
};

export const chatTools = {
  web_search: tool({
    description:
      "Search the web for current information using Exa. Returns titles, URLs, and optional text snippets. Use for recent events, facts you are unsure about, or anything that may be after your training cutoff.",
    inputSchema: z.object({
      query: z.string().describe("The search query"),
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
        .describe(
          "Whether to include short text snippets from each result page"
        ),
    }),
    execute: async ({ query, numResults, includeText }) => {
      if (!EXA_API_KEY) {
        throw new Error("EXA_API_KEY is not configured on the server.");
      }

      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "x-api-key": EXA_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          numResults,
          ...(includeText
            ? { contents: { text: { maxCharacters: 1000 } } }
            : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Exa search failed (${res.status}): ${body}`);
      }

      const data: { results?: ExaResult[] } = await res.json();

      return {
        query,
        results: (data.results ?? []).map((r) => ({
          title: r.title ?? r.url ?? r.id ?? "Untitled",
          url: r.url ?? r.id ?? "",
          ...(r.text ? { snippet: r.text } : {}),
        })),
      };
    },
  }),

  fetch_page: tool({
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
  }),
};
