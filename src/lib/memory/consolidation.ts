import { inArray, isNull } from "drizzle-orm";
import { generateText, Output } from "ai";
import { z } from "zod";
import { getDefaultModel } from "@/lib/ai/provider";
import { db as defaultDb, type AppDatabase } from "@/db";
import { episodicMemories, memoryRelations } from "@/db/schema";
import { addSemanticMemory } from "./semantic-memory";
import { generateEmbedding } from "./embeddings";

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

export type ConsolidationOptions = {
  batchSize?: number;
  summarizer?: (contents: string[]) => Promise<string>;
  db?: AppDatabase;
};

export async function defaultSummarizer(contents: string[]): Promise<string> {
  const prompt = `Summarize the following conversation events into concise, high-signal facts and user preferences:\n\n${contents
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n")}`;

  try {
    const { output, text } = await generateText({
      model: await getDefaultModel(),
      prompt,
      system:
        "You are a memory consolidation assistant. Extract key enduring facts and preferences. Be concise.",
      output: Output.object({
        schema: consolidationSchema,
      }),
    });

    if (output && typeof output === "object" && "summary" in output && typeof output.summary === "string") {
      return output.summary.trim();
    }

    if (text) {
      return text.trim();
    }

    return "";
  } catch {
    // Fallback to unstructured text generation if model doesn't support Output.object
    const { text } = await generateText({
      model: await getDefaultModel(),
      prompt,
      system:
        "You are a memory consolidation assistant. Extract key enduring facts and preferences. Be concise.",
    });
    return text.trim();
  }
}

export async function consolidateEpisodicMemories(
  options: ConsolidationOptions = {}
) {
  const batchSize = options.batchSize ?? 10;
  const db = options.db ?? defaultDb;
  const summarizer = options.summarizer ?? defaultSummarizer;

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

  const summary = await summarizer(contents);
  const embedding = await generateEmbedding(summary);

  // Use addSemanticMemory for deduplication and canonical ID generation
  const semanticId = await addSemanticMemory(
    {
      content: summary,
      embedding: embedding ?? undefined,
      importance: 0.85,
      sources: ids,
      metadata: { extractedFrom: "episodic_consolidation" },
      tags: ["consolidated_memory"],
    },
    db
  );

  db.transaction((tx) => {
    // Link each episodic memory to the consolidated semantic memory
    for (const epId of ids) {
      tx.insert(memoryRelations).values({
        id: `rel_${Math.random().toString(36).slice(2, 10)}`,
        fromMemoryId: epId,
        fromMemoryType: "episodic",
        toMemoryId: semanticId,
        toMemoryType: "semantic",
        relationType: "consolidated_into",
        strength: 0.9,
      }).run();
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
