import { inArray, isNull } from "drizzle-orm";
import { generateText } from "ai";
import { defaultModel } from "@/lib/ai/provider";
import { db as defaultDb, type AppDatabase } from "@/db";
import { episodicMemories } from "@/db/schema";
import { addSemanticMemory, linkMemories } from "./semantic-memory";
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
    .limit(batchSize);

  if (unconsolidated.length < 2) {
    return { consolidatedCount: 0, createdSemanticId: null };
  }

  const contents = unconsolidated.map((m) => m.content);
  const ids = unconsolidated.map((m) => m.id);

  const summary = await summarizer(contents);
  const embedding = await generateEmbedding(summary);

  const semanticId = await addSemanticMemory(
    {
      content: summary,
      importance: 0.85,
      sources: ids,
      embedding,
    },
    db
  );

  // Link each episodic memory to the consolidated semantic memory
  for (const epId of ids) {
    await linkMemories(
      {
        fromMemoryId: epId,
        fromMemoryType: "episodic",
        toMemoryId: semanticId,
        toMemoryType: "semantic",
        relationType: "consolidated_into",
        strength: 0.9,
      },
      db
    );
  }

  // Mark episodic memories as consolidated
  await db
    .update(episodicMemories)
    .set({ consolidatedInto: semanticId })
    .where(inArray(episodicMemories.id, ids));

  return {
    consolidatedCount: ids.length,
    createdSemanticId: semanticId,
  };
}
