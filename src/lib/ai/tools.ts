import { tool } from "ai";
import { z } from "zod";
import { runWebSearch } from "@/lib/web-search";
import { createSkillTools } from "@/lib/skills/catalog";
import {
  addWorkingMemory,
  deleteWorkingMemory,
} from "@/lib/memory/working-memory";
import { addSemanticMemory } from "@/lib/memory/semantic-memory";
import { generateEmbedding } from "@/lib/memory/embeddings";
import { hybridMemorySearch } from "@/lib/memory/search";
import { enqueueJob } from "@/lib/queue/queue";
import { assertSafeUrl } from "@/lib/security/ssrf";

/**
 * Server-side tools available to the chat model.
 *
 * - web_search: multi-provider web search (Exa → Firecrawl → SearXNG)
 *   with automatic fallback and quota cooldowns; see lib/web-search.ts.
 * - fetch_page: Firecrawl scrape to read a specific URL as markdown.
 * - ask_user_question: structured interactive questionnaire with options/previews.
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

  ask_user_question: tool({
    description:
      "Ask the user structured interactive multiple-choice questions when requirements are ambiguous, have multiple valid architectural approaches, or require explicit user choices. Supports category tags, detailed trade-offs, code/mockup previews, and multi-selection. Note: This tool pauses execution on the client so the user can interactively select or type their answers; do NOT guess or answer this tool yourself.",
    inputSchema: z.object({
      questions: z
        .array(
          z.object({
            question: z
              .string()
              .describe("The specific question to ask the user"),
            header: z
              .string()
              .max(20)
              .describe(
                "Short tag/category chip (e.g., 'Framework', 'Database', 'Approach')"
              ),
            multiSelect: z
              .boolean()
              .default(false)
              .describe("Whether multiple options can be selected"),
            options: z
              .array(
                z.object({
                  label: z
                    .string()
                    .describe("Concise option title (1-5 words)"),
                  description: z
                    .string()
                    .describe(
                      "Explanation of trade-offs, consequences, or implementation details"
                    ),
                  preview: z
                    .string()
                    .optional()
                    .describe(
                      "Optional multi-line code, diagram, or ASCII mockup preview"
                    ),
                })
              )
              .min(2)
              .max(4)
              .describe("2-4 distinct mutually exclusive choices"),
          })
        )
        .min(1)
        .max(4)
        .describe("1-4 questions to present to the user"),
    }),
    // Omit execute so AI SDK v7 treats ask_user_question as an interactive client-side tool.
    // The server loop halts step execution on this tool, emitting state="input-available"
    // and waiting for the user to answer via addToolResult on the client.
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

  // ── Memory tools ────────────────────────────────────────────────────────
  // Explicit memory control: the model decides what to keep, recall and
  // discard, complementing the automatic post-turn ingestion pipeline.

  remember_note: tool({
    description:
      "Save a short-lived note to working memory. Active notes are injected into your context on every subsequent turn until they expire. Use for temporary task state, intermediate conclusions, or anything to keep in mind for this session only. For facts that must survive across conversations, use remember_fact instead.",
    inputSchema: z.object({
      content: z
        .string()
        .min(1)
        .max(500)
        .describe("The note to remember, written as a clear standalone statement"),
      ttlMinutes: z
        .number()
        .int()
        .min(1)
        .max(1440)
        .default(60)
        .describe("How long the note stays active, in minutes (max 24h)"),
      tags: z
        .array(z.string())
        .max(5)
        .optional()
        .describe("Optional short tags for categorization"),
    }),
    execute: async ({ content, ttlMinutes, tags }) => {
      const id = await addWorkingMemory({
        content,
        ttlSeconds: ttlMinutes * 60,
        tags: tags ?? [],
      });
      return { id, activeForMinutes: ttlMinutes };
    },
  }),

  remember_fact: tool({
    description:
      "Save a durable fact, preference, or rule to long-term semantic memory so it is remembered across all future conversations. Use when the user states something lasting ('my project uses X', 'I prefer Y', 'never do Z'). Near-duplicate facts are merged automatically, so it is safe to call on restatements.",
    inputSchema: z.object({
      content: z
        .string()
        .min(1)
        .max(1000)
        .describe("The fact or preference, written as a clear standalone statement"),
      importance: z
        .number()
        .min(0)
        .max(1)
        .default(0.7)
        .describe("How important this is (0.5 routine, 0.8+ strong preference or rule)"),
      tags: z
        .array(z.string())
        .max(8)
        .optional()
        .describe("Optional tags, e.g. ['preference'], ['project'], ['procedural_rule']"),
    }),
    execute: async ({ content, importance, tags }) => {
      const embedding = await generateEmbedding(content);
      const id = await addSemanticMemory({
        content,
        importance,
        tags: tags ?? [],
        embedding,
        metadata: { extractedFrom: "model_tool" },
      });
      return { id, embedded: embedding !== null };
    },
  }),

  recall_memories: tool({
    description:
      "Search long-term memory (past conversations and learned facts) by keyword and meaning. Use whenever you need to recall something from earlier sessions that is not already present in your context — prior decisions, project details, user preferences, or learned rules.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(300)
        .describe("What to recall, as keywords or a short question"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("Maximum number of memories to return"),
    }),
    execute: async ({ query, limit }) => {
      const results = await hybridMemorySearch(query, { limit });
      return {
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          type: r.type,
          content: r.content,
          score: Number(r.score.toFixed(4)),
        })),
      };
    },
  }),

  forget_note: tool({
    description:
      "Delete a working-memory note by its id, e.g. when the temporary task it tracked is finished. Only working-memory notes (from remember_note) can be deleted; long-term facts are not removable through this tool.",
    inputSchema: z.object({
      id: z.string().describe("The working-memory note id returned by remember_note"),
    }),
    execute: async ({ id }) => {
      const deleted = await deleteWorkingMemory(id);
      return { id, deleted };
    },
  }),

  // ── Proactive tools ─────────────────────────────────────────────────────

  set_reminder: tool({
    description:
      "Schedule a reminder for the user. When due, it appears in their notification inbox in the app header. Use whenever the user says 'remind me', 'in N minutes/hours', 'tomorrow at...', or asks you to follow up later. Confirm the scheduled time in your reply.",
    inputSchema: z.object({
      title: z
        .string()
        .min(1)
        .max(120)
        .describe("Short reminder title shown to the user, e.g. 'Stand up and stretch'"),
      body: z
        .string()
        .max(500)
        .optional()
        .describe("Optional extra detail or context for the reminder"),
      delayMinutes: z
        .number()
        .int()
        .min(1)
        .max(43200)
        .describe("Minutes from now until the reminder fires (max 30 days)"),
    }),
    execute: async ({ title, body, delayMinutes }) => {
      const runAt = new Date(Date.now() + delayMinutes * 60_000);
      const jobId = await enqueueJob({
        type: "scheduled_reminder",
        payload: { title, body: body ?? null },
        runAt,
      });
      return { jobId, dueAt: runAt.toISOString() };
    },
  }),
};
