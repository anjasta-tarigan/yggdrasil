import { tool } from "ai";
import { z } from "zod";
import {
  addWorkingMemory,
  deleteWorkingMemory,
} from "@/lib/memory/working-memory";
import { addSemanticMemory } from "@/lib/memory/semantic-memory";
import { generateEmbedding } from "@/lib/memory/embeddings";
import { hybridMemorySearch } from "@/lib/memory/search";

/**
 * Memory tools: explicit memory control where the model decides what to
 * keep, recall and discard, complementing the automatic post-turn
 * ingestion pipeline.
 *
 * Two layers with distinct lifetimes:
 *  - working memory (memory_note_create / memory_note_delete): short-lived
 *    notes injected into context until they expire.
 *  - semantic memory (memory_fact_store / memory_search): durable facts
 *    and preferences remembered across conversations.
 */

export const memory_note_create = tool({
  description:
    "Save a short-lived note to working memory. Active notes are injected into your context on every subsequent turn until they expire. Use for temporary task state, intermediate conclusions, or anything to keep in mind for this session only. For facts that must survive across conversations, use memory_fact_store instead.",
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
});

export const memory_fact_store = tool({
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
});

export const memory_search = tool({
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
});

export const memory_note_delete = tool({
  description:
    "Delete a working-memory note by its id, e.g. when the temporary task it tracked is finished. Only working-memory notes (from memory_note_create) can be deleted; long-term facts are not removable through this tool.",
  inputSchema: z.object({
    id: z.string().describe("The working-memory note id returned by memory_note_create"),
  }),
  execute: async ({ id }) => {
    const deleted = await deleteWorkingMemory(id);
    return { id, deleted };
  },
});
