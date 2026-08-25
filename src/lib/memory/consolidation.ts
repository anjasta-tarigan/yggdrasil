import { inArray, isNull } from "drizzle-orm";
import { generateText } from "ai";
import { defaultModel } from "@/lib/ai/provider";
import { db as defaultDb, type AppDatabase } from "@/db";
import { episodicMemories, semanticMemories, memoryRelations } from "@/db/schema";
import { generateEmbedding } from "./embeddings";

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
    const { text } = await generateText({
      model: defaultModel,
      prompt,
      system:
        "You are a memory consolidation assistant. Extract key enduring facts and preferences. Be concise.",
    });
    return text.trim();
  } catch (err) {
    console.warn("[consolidation] defaultSummarizer failed with LLM, fallback to concatenation:", err);
    return `Consolidated knowledge:\n${contents.join("\n")}`;
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

  // Group unconsolidated memories by sessionId so distinct conversations are not mixed
  const bySession = new Map<string, typeof unconsolidated>();
  for (const memory of unconsolidated) {
    const key = memory.sessionId ?? "default";
    const list = bySession.get(key) || [];
    list.push(memory);
    bySession.set(key, list);
  }

  // Find the first cluster of at least 2 memories in the same session, or fallback to batch
  let cluster = Array.from(bySession.values()).find((list) => list.length >= 2);
  if (!cluster) {
    cluster = unconsolidated.slice(0, batchSize);
  } else {
    cluster = cluster.slice(0, batchSize);
  }

  if (cluster.length < 2) {
    return { consolidatedCount: 0, createdSemanticId: null };
  }

  const contents = cluster.map((m) => m.content);
  const ids = cluster.map((m) => m.id);

  const summary = await summarizer(contents);
  const embedding = await generateEmbedding(summary);

  let semanticId = "";

  db.transaction((tx) => {
    semanticId = `sem_${Math.random().toString(36).slice(2, 10)}`;

    tx.insert(semanticMemories).values({
      id: semanticId,
      content: summary,
      embedding: embedding ? Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength) : null,
      importance: 0.85,
      sources: ids,
      metadata: {},
    }).run();

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
