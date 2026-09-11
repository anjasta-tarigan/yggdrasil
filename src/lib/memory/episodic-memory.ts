import { nanoid } from "nanoid";
import { desc, isNull } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { episodicMemories } from "@/db/schema";
import { vectorToBuffer } from "./embeddings";
import type { EpisodicMemoryInput } from "./types";

export async function addEpisodicMemory(
  input: EpisodicMemoryInput,
  db: AppDatabase = defaultDb
): Promise<string> {
  const id = `epi_${nanoid(12)}`;

  await db.insert(episodicMemories).values({
    id,
    sessionId: input.sessionId ?? null,
    content: input.content,
    embedding: input.embedding ? vectorToBuffer(input.embedding) : null,
    embeddingModel: input.embeddingModel ?? null,
    importance: input.importance ?? 0.5,
    tags: input.tags ?? [],
    metadata: input.metadata ?? {},
  });

  return id;
}

export async function getEpisodicMemories(
  opts: { limit?: number; unconsolidatedOnly?: boolean } = {},
  db: AppDatabase = defaultDb
) {
  const limit = opts.limit ?? 50;

  if (opts.unconsolidatedOnly) {
    return db
      .select()
      .from(episodicMemories)
      .where(isNull(episodicMemories.consolidatedInto))
      .orderBy(desc(episodicMemories.createdAt))
      .limit(limit);
  }

  return db
    .select()
    .from(episodicMemories)
    .orderBy(desc(episodicMemories.createdAt))
    .limit(limit);
}
