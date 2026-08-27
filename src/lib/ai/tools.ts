import { tool } from "ai";
import { z } from "zod";
import { runWebSearch } from "@/lib/web-search";
import { createSkillTools } from "@/lib/skills/catalog";

/**
 * Server-side tools available to the chat model.
 *
 * - web_search: multi-provider web search (Exa → Firecrawl → SearXNG)
 *   with automatic fallback and quota cooldowns; see lib/web-search.ts.
 * - fetch_page: Firecrawl scrape to read a specific URL as markdown.
 * - manage_tasks: visible plan/task checklist for multi-step work.
 * - create_artifact: pure passthrough for standalone deliverables (code files,
 *   demos, graphics, documents) the client renders in the artifact side panel.
 * - use_skill / read_skill_file / list_installed_skills / create_skill /
 *   update_skill / delete_skill: agent skills runtime (progressive
 *   disclosure + skill authoring); see lib/skills/catalog.ts.
 *
 * The search tools require at least one configured provider (API keys or
 * SearXNG instance URL in .env.local, or overrides in Settings → Tools).
 * When none is available the tool throws a clear error that surfaces in
 * the UI as an output-error state.
 */

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;

export const chatTools = {
  // Skill runtime + authoring tools (built-ins below take precedence
  // over any same-named skill tool if one is ever introduced).
  ...createSkillTools(),

  web_search: tool({
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
        .describe(
          "Whether to include short text snippets from each result page"
        ),
    }),
    execute: async ({ query, numResults, includeText }) => {
      // Provider selection, fallback order and quota cooldowns are handled
      // by the multi-provider search stack (lib/web-search.ts). The outcome
      // reports which provider answered plus every attempt made.
      return runWebSearch(query, { numResults, includeText });
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
      "Save and display a standalone deliverable in the dedicated side panel. You MUST call this tool whenever the user asks for a complete code file, script, HTML/CSS/JS demo, interactive app, game, SVG graphic, React component, full document/report, or multi-file project bundle, or mentions 'artifact'. NEVER output full standalone code files or interactive demos as markdown code blocks in your text reply; always call create_artifact instead.",
    inputSchema: z.object({
      title: z
        .string()
        .min(1)
        .max(80)
        .describe(
          "Short human-readable title, e.g. 'Fibonacci Generator in Rust' or 'Interactive Calculator'"
        ),
      kind: z
        .enum(["code", "document", "project"])
        .describe(
          "'code' for programs, scripts, HTML/SVG/JSX; 'document' for markdown/prose reports; 'project' for multi-file bundle"
        ),
      language: z
        .string()
        .optional()
        .describe(
          "Programming language id for syntax highlighting (e.g., 'python', 'html', 'tsx', 'javascript', 'rust', 'svg'). Required when kind='code'"
        ),
      content: z
        .string()
        .optional()
        .describe("The complete artifact content without omissions or placeholders for single deliverables"),
      files: z
        .array(
          z.object({
            path: z.string().describe("Relative file path, e.g. 'src/App.tsx', 'README.md'"),
            content: z.string().describe("Full file content"),
            language: z.string().optional().describe("Syntax language id for this file"),
          })
        )
        .optional()
        .describe("Array of files for multi-file project or skill bundles"),
    }),
    execute: async ({ title, kind, language, content, files }) => ({
      title,
      kind,
      language,
      content,
      files,
    }),
  }),
};
