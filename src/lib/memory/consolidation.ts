import { inArray, isNull } from "drizzle-orm";
import { generateText, Output } from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getDefaultModel } from "@/lib/ai/provider";
import { db as defaultDb, type AppDatabase } from "@/db";
import { episodicMemories, memoryRelations } from "@/db/schema";
import { addSemanticMemory } from "./semantic-memory";
import { generateEmbedding, resolveEmbeddingModel } from "./embeddings";

export const consolidationSchema = z.object({
  summary: z
    .string()
    .describe("Concise summary of enduring facts and user preferences"),
  extractedFacts: z.array(
    z.object({
      content: z.string().describe("Enduring factual statement or user preference"),
      category: z.string().describe("Category such as preference, fact, goal, or technical_detail"),
      importance: z.number().min(0).max(1).describe("Importance score between 0 and 1"),
    })
  ),
});

export type ConsolidationOutput = z.infer<typeof consolidationSchema>;

/**
 * Strips LLM summary boilerplate from a fact before it is stored.
 *
 * Consolidated summaries routinely open with a markdown template header
 * ("## Key Facts & Preferences", "**User Profile:**", "### Summary") followed
 * by a bulleted body. Left in place, every session's summary shares that prefix
 * — 21 of 288 rows in a live store began with the identical heading, inflating
 * cross-row similarity and defeating deduplication. Only a leading template
 * line is removed; body text is preserved verbatim.
 */
export function stripFactBoilerplate(content: string): string {
  const BOILERPLATE_LINE =
    /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:key facts(?:\s*(?:&|and)\s*(?:user\s*)?preferences)?|user profile|summary of conversation(?:\s*(?:&|and)\s*user preferences)?|key facts & preferences)(?:\*\*)?\s*:?\s*$/i;

  const lines = content.split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start].trim();
    // Skip blank lines and leading template headings.
    if (line === "" || BOILERPLATE_LINE.test(line)) {
      start++;
      continue;
    }
    break;
  }

  const stripped = lines
    .slice(start)
    .join("\n")
    .trim()
    // A single-fact row should not retain the list marker it was written with.
    .replace(/^(?:[-*•]|\d+\.)\s+/, "")
    .trim();

  // A pure-boilerplate input would strip to empty; keep the original rather
  // than storing a blank fact.
  return stripped.length > 0 ? stripped : content.trim();
}

/**
 * Consolidates one cluster of episodic memories into atomic semantic facts.
 *
 * Each `extractedFacts` entry becomes its own row via `addSemanticMemory`, so
 * deduplication, decay, and retrieval all operate per fact. Storing the bulk
 * `summary` instead produced ~941-char rows that shared boilerplate across
 * sessions and accumulated rather than merging. The summary is retained only
 * as a fallback when the model returns no facts, and as the embedding source
 * for those rows.
 */

export type ConsolidationOptions = {
  batchSize?: number;
  /**
   * Legacy single-string summarizer. When supplied, its return value is stored
   * as one semantic row (pre-atomic-extraction behaviour) and the fact
   * extractor is bypassed. Retained for callers that inject a fixed summary.
   */
  summarizer?: (contents: string[]) => Promise<string>;
  /**
   * Structured fact extractor. Returns the cluster summary plus the atomic
   * facts to persist individually. Defaults to `defaultFactExtractor`.
   */
  factExtractor?: (contents: string[]) => Promise<ConsolidationOutput>;
  db?: AppDatabase;
};

export async function defaultSummarizer(contents: string[]): Promise<string> {
  const output = await defaultFactExtractor(contents);
  return output.summary.trim();
}

/**
 * Splits a model preamble into candidate fact lines. Handles numbered lists
 * ("1. ..."), bullets ("- ...", "* ...", "• ...") and plain prose sentences.
 */
function splitFactLines(text: string): string[] {
  const lines = text
    .split(/\r?\n+/)
    .map((line) => line.replace(/^(?:\d+[.)]\s*|[-*•]\s+)/, "").trim())
    .filter((line) => line.length > 0);
  if (lines.length > 1) return lines;
  // Single paragraph: split on sentence boundaries.
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/^(?:\d+[.)]\s*|[-*•]\s+)/, "").trim())
    .filter((s) => s.length > 0);
}

const FACT_NOISE_PATTERN =
  /^(remember\s+(that|to)|note\s*:|here\s+(is|are)\b|in\s+summary\b|overall\b)/i;

const PREFERENCE_HINT =
  /(prefer|like|love|hate|dislike|always|never|uses?\s+\w+\s+(?:for|as|over)|runs?\s+\w+)/i;

/**
 * Salvages atomic facts from unstructured model text. Local gateways
 * frequently answer a structured-output call with plain prose (the "Invalid
 * JSON response" path behind 29 dead sleep_consolidation jobs): without this
 * step the whole sweep writes nothing and the episodic backlog grows
 * unboundedly.
 */
function salvageFactsFromText(text: string): ConsolidationOutput["extractedFacts"] {
  const cleaned = stripFactBoilerplate(text);
  return splitFactLines(cleaned)
    .filter((line) => line.length >= 12 && !FACT_NOISE_PATTERN.test(line))
    .slice(0, 8)
    .map((content) => ({
      content,
      category: PREFERENCE_HINT.test(content) ? "preference" : "fact",
      importance: 0.7,
    }));
}

/**
 * Structured extraction: one model call returning both the cluster summary
 * and the atomic facts. When the model answers with free text instead of a
 * structured object, facts are salvaged line-by-line so the sweep still
 * produces durable memories.
 */
export async function defaultFactExtractor(
  contents: string[]
): Promise<ConsolidationOutput> {
  const prompt = `Summarize the following conversation events into concise, high-signal facts and user preferences:\n\n${contents
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n")}`;

  try {
    const { output, text, reasoningText } = await generateText({
      model: await getDefaultModel(),
      prompt,
      system:
        "You are a memory consolidation assistant. Extract key enduring facts and preferences. Be concise.",
      output: Output.object({
        schema: consolidationSchema,
      }),
    });

    if (output && typeof output === "object" && "summary" in output && typeof output.summary === "string") {
      return output;
    }

    const fallbackText = (text || reasoningText || "").trim();
    return { summary: fallbackText, extractedFacts: salvageFactsFromText(fallbackText) };
  } catch {
    // Fallback to unstructured text generation if model doesn't support Output.object
    const { text, reasoningText } = await generateText({
      model: await getDefaultModel(),
      prompt,
      system:
        "You are a memory consolidation assistant. Extract key enduring facts and preferences. Be concise.",
    });
    const fallbackText = (text && text.trim().length > 0 ? text : (reasoningText ?? "")).trim();
    return { summary: fallbackText, extractedFacts: salvageFactsFromText(fallbackText) };
  }
}

export async function consolidateEpisodicMemories(
  options: ConsolidationOptions = {}
) {
  const batchSize = options.batchSize ?? 10;
  const db = options.db ?? defaultDb;

  const unconsolidated = await db
    .select()
    .from(episodicMemories)
    .where(isNull(episodicMemories.consolidatedInto))
    .limit(batchSize * 3);

  if (unconsolidated.length < 2) {
    return { consolidatedCount: 0, createdSemanticId: null };
  }

  // Group unconsolidated memories strictly by sessionId to never mix distinct conversations
  const bySession = new Map<string, typeof unconsolidated>();
  for (const memory of unconsolidated) {
    const key = memory.sessionId ?? "standalone";
    const list = bySession.get(key) || [];
    list.push(memory);
    bySession.set(key, list);
  }

  // Find the first cluster of at least 2 memories in the same session
  const clusterEntry = Array.from(bySession.values()).find((list) => list.length >= 2);
  if (!clusterEntry) {
    return { consolidatedCount: 0, createdSemanticId: null };
  }
  const cluster = clusterEntry.slice(0, batchSize);

  const contents = cluster.map((m) => m.content);
  const ids = cluster.map((m) => m.id);

  const embeddingModel = await resolveEmbeddingModel();

  // Atomic extraction: one semantic row per fact, so dedup/decay/retrieval all
  // operate per fact instead of on a boilerplate-heavy bulk summary. The
  // legacy `summarizer` option bypasses this and stores its single string.
  let facts: Array<{ content: string; importance: number; tags: string[] }>;
  if (options.summarizer) {
    const summary = await options.summarizer(contents);
    facts = [
      {
        content: stripFactBoilerplate(summary),
        importance: 0.85,
        tags: ["consolidated_memory"],
      },
    ];
  } else {
    const extractor = options.factExtractor ?? defaultFactExtractor;
    const extracted = await extractor(contents);
    const cleaned = extracted.extractedFacts
      .map((fact) => ({
        content: stripFactBoilerplate(fact.content),
        importance: fact.importance,
        tags: Array.from(
          new Set(["consolidated_memory", fact.category].filter(Boolean) as string[])
        ),
      }))
      .filter((fact) => fact.content.length > 0);

    facts =
      cleaned.length > 0
        ? cleaned
        : [
            {
              content: stripFactBoilerplate(extracted.summary),
              importance: 0.85,
              tags: ["consolidated_memory"],
            },
          ];
  }

  // Persist every fact; the first created id anchors the consolidation links.
  const semanticIds: string[] = [];
  for (const fact of facts) {
    const embedding = await generateEmbedding(fact.content);
    const id = await addSemanticMemory(
      {
        content: fact.content,
        embedding: embedding ?? undefined,
        embeddingModel,
        importance: fact.importance,
        sources: ids,
        metadata: { extractedFrom: "episodic_consolidation" },
        tags: fact.tags,
      },
      db
    );
    if (!semanticIds.includes(id)) semanticIds.push(id);
  }

  const semanticId = semanticIds[0];

  db.transaction((tx) => {
    // Link each episodic memory to every semantic memory it produced
    for (const epId of ids) {
      for (const targetId of semanticIds) {
        tx.insert(memoryRelations).values({
          id: `rel_${nanoid(12)}`,
          fromMemoryId: epId,
          fromMemoryType: "episodic",
          toMemoryId: targetId,
          toMemoryType: "semantic",
          relationType: "consolidated_into",
          strength: 0.9,
        }).run();
      }
    }

    // Mark episodic memories as consolidated
    tx
      .update(episodicMemories)
      .set({ consolidatedInto: semanticId })
      .where(inArray(episodicMemories.id, ids))
      .run();
  });

  return {
    consolidatedCount: ids.length,
    createdSemanticId: semanticId,
  };
}
