import { tool } from "ai";
import { z } from "zod";

/**
 * Server-side tools available to the chat model.
 *
 * - web_search: Exa neural search for current information.
 * - fetch_page: Firecrawl scrape to read a specific URL as markdown.
 * - manage_tasks: visible plan/task checklist for multi-step work.
 * - create_artifact: save a standalone deliverable (code file, document)
 *   that opens in the slide-in artifact panel.
 *
 * The search tools require their respective API keys in .env.local. When a
 * key is missing the tool throws a clear error that surfaces in the UI as
 * an output-error state.
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

  manage_tasks: tool({
    description:
      "Create or update a visible task checklist shown to the user. Use it for complex, multi-step requests: first call it with the full plan (all items pending), then call it again as work progresses, marking items in_progress or completed. The latest call replaces the displayed list.",
    inputSchema: z.object({
      title: z.string().describe("Short title for the task list"),
      items: z
        .array(
          z.object({
            text: z.string().describe("Short description of the task item"),
            status: z
              .enum(["pending", "in_progress", "completed"])
              .describe("Current status of the item"),
          })
        )
        .min(1)
        .max(20)
        .describe("The complete task list (replaces any previous list)"),
    }),
    execute: async ({ title, items }) => {
      const completed = items.filter((i) => i.status === "completed").length;
      return {
        title,
        items,
        completed,
        total: items.length,
        done: completed === items.length,
      };
    },
  }),

  create_artifact: tool({
    description:
      "Save a standalone deliverable that opens in a side-by-side artifact panel. Use it when you produce substantial, self-contained content: a complete code file or script, an HTML page, a long report/document (roughly 150+ words), or anything the user will want to keep, copy, or download as a unit. Do NOT use it for short snippets or brief explanations — inline those in your reply instead. The full content must be passed here; do not also print the whole thing in your reply (a one-line summary plus the artifact is enough).",
    inputSchema: z.object({
      title: z
        .string()
        .min(1)
        .max(80)
        .describe("Short human-readable title of the artifact"),
      kind: z
        .enum(["code", "document"])
        .describe("'code' for programs/files, 'document' for prose/markdown"),
      language: z
        .string()
        .optional()
        .describe(
          "Programming language id for syntax highlighting (required for kind='code', e.g. python, typescript)"
        ),
      content: z
        .string()
        .min(1)
        .describe("The complete artifact content (raw code or markdown)"),
      filename: z
        .string()
        .optional()
        .describe("Optional download filename; derived from title otherwise"),
    }),
    execute: async ({ title, kind, language, content }) => {
      // The payload itself is the deliverable: returning it makes it part
      // of the tool output, which the client turns into the panel.
      return { title, kind, language, content };
    },
  }),
};
