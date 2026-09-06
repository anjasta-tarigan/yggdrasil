import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { semanticMemories, memoryRelations } from "@/db/schema";
import { bufferToVector, cosineSimilarity, vectorToBuffer } from "./embeddings";
import type { SemanticMemoryInput, MemoryRelationInput } from "./types";

/**
 * Cosine similarity at or above this value is treated as the same fact.
 * Re-extracted duplicates are merged into the existing row instead of
 * creating a new one, so repeated reflections/consolidations reinforce a
 * memory rather than polluting retrieval with near-identical copies.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.95;

function findNearDuplicate(
  embedding: Float32Array,
  db: AppDatabase
): { id: string; importance: number; tags: string[] | null; sources: string[] | null } | null {
  // Personal-assistant scale: a full scan is cheap and avoids coupling the
  // write path to the (possibly unavailable) sqlite-vec index.
  const rows = db
    .select({
      id: semanticMemories.id,
      importance: semanticMemories.importance,
      tags: semanticMemories.tags,
      sources: semanticMemories.sources,
      embedding: semanticMemories.embedding,
    })
    .from(semanticMemories)
    .all();

  let best: { id: string; importance: number; tags: string[] | null; sources: string[] | null } | null =
    null;
  let bestSimilarity = NEAR_DUPLICATE_THRESHOLD;

  for (const row of rows) {
    if (!row.embedding) continue;
    const similarity = cosineSimilarity(embedding, bufferToVector(row.embedding as Buffer));
    if (similarity >= bestSimilarity) {
      bestSimilarity = similarity;
      best = row;
    }
  }

  return best;
}

export async function addSemanticMemory(
  input: SemanticMemoryInput,
  db: AppDatabase = defaultDb
): Promise<string> {
  // Wrap near-duplicate check and insert/update in an atomic transaction
  // to prevent race conditions during concurrent background ingestion / reflections.
  return db.transaction((tx) => {
    // Near-duplicate merge: reinforce the existing memory instead of
    // inserting a copy. Skipped when no embedding is available.
    if (input.embedding) {
      const duplicate = findNearDuplicate(input.embedding, tx as unknown as AppDatabase);
      if (duplicate) {
        const mergedTags = Array.from(
          new Set([...(duplicate.tags ?? []), ...(input.tags ?? [])])
        );
        const mergedSources = Array.from(
          new Set([...(duplicate.sources ?? []), ...(input.sources ?? [])])
        );
        tx
          .update(semanticMemories)
          .set({
            importance: Math.max(duplicate.importance, input.importance ?? 0.5),
            tags: mergedTags,
            sources: mergedSources,
            updatedAt: new Date(),
          })
          .where(eq(semanticMemories.id, duplicate.id))
          .run();
        return duplicate.id;
      }
    }

    const id = `sem_${nanoid(12)}`;

    tx.insert(semanticMemories).values({
      id,
      content: input.content,
      embedding: input.embedding ? vectorToBuffer(input.embedding) : null,
      importance: input.importance ?? 0.5,
      tags: input.tags ?? [],
      sources: input.sources ?? [],
      metadata: input.metadata ?? {},
    }).run();

    return id;
  });
}

export async function linkMemories(
  input: MemoryRelationInput,
  db: AppDatabase = defaultDb
): Promise<string> {
  const id = `rel_${nanoid(12)}`;

  await db.insert(memoryRelations).values({
    id,
    fromMemoryId: input.fromMemoryId,
    fromMemoryType: input.fromMemoryType,
    toMemoryId: input.toMemoryId,
    toMemoryType: input.toMemoryType,
    relationType: input.relationType,
    strength: input.strength ?? 0.5,
  });

  return id;
}
