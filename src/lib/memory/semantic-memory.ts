import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db as defaultDb, sqlite as defaultSqlite, type AppDatabase } from "@/db";
import { semanticMemories, memoryRelations } from "@/db/schema";
import { bufferToVector, cosineSimilarity, vectorToBuffer } from "./embeddings";
import type { SemanticMemoryInput, MemoryRelationInput } from "./types";
import {
  isVectorIndexAvailable,
  syncVectorIndex,
  vectorKnn,
} from "./vector-index";
import type Database from "better-sqlite3";

/**
 * Cosine similarity at or above this value is treated as the same fact.
 * Re-extracted duplicates are merged into the existing row instead of
 * creating a new one, so repeated reflections/consolidations reinforce a
 * memory rather than polluting retrieval with near-identical copies.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.95;

/**
 * Cosine-distance ceiling for the vec0 KNN duplicate probe.
 * distance = 1 - similarity → 0.05 ≈ similarity 0.95.
 */
const NEAR_DUPLICATE_DISTANCE = 1 - NEAR_DUPLICATE_THRESHOLD;

/**
 * Fast dedup via the sqlite-vec index: one KNN query instead of a full
 * table scan. Falls back to the JS scan path when the index is unavailable.
 *
 * Returns the best duplicate (similarity ≥ NEAR_DUPLICATE_THRESHOLD) or null.
 */
function findNearDuplicateVec(
  embedding: Float32Array,
  dim: number,
  db: AppDatabase,
  sqlite: Database.Database
): { id: string; importance: number; tags: string[] | null; sources: string[] | null } | null {
  if (!isVectorIndexAvailable(sqlite)) return null;
  if (!syncVectorIndex(sqlite, "semantic", dim)) return null;

  // Use prepared statement with bound parameters — MATCH accepts a blob
  // so we pass the raw float32 buffer. Distance ≤ NEAR_DUPLICATE_DISTANCE
  // means similarity ≥ 0.95.
  const queryBuffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  const hit = sqlite
    .prepare(
      `SELECT s.id, s.importance, s.tags, s.sources
         FROM semantic_memories_vec v
         JOIN semantic_memories s ON s.rowid = v.rowid
        WHERE v.embedding MATCH ? AND k = 1 AND v.distance <= ?
        ORDER BY v.distance`
    )
    .get(queryBuffer, NEAR_DUPLICATE_DISTANCE) as
    | { id: string; importance: number; tags: string; sources: string }
    | undefined;

  if (!hit) return null;

  return {
    id: hit.id,
    importance: hit.importance,
    tags: hit.tags ? (JSON.parse(hit.tags) as string[]) : null,
    sources: hit.sources ? (JSON.parse(hit.sources) as string[]) : null,
  };
}

function findNearDuplicate(
  embedding: Float32Array,
  db: AppDatabase,
  sqlite: Database.Database
): { id: string; importance: number; tags: string[] | null; sources: string[] | null } | null {
  const dim = embedding.length;

  // Fast path: sqlite-vec index (O(log N)).
  const vecHit = findNearDuplicateVec(embedding, dim, db, sqlite);
  if (vecHit !== null) return vecHit;

  // Slow path: JS full-table cosine scan (O(N)).
  // Used when sqlite-vec is not loaded on this connection or the index is
  // being rebuilt (e.g. immediately after rebuildEmbeddingIndex nulls all
  // vectors). At personal-assistant scale this is still sub-millisecond.
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

  let best: { id: string; importance: number; tags: string[] | null; sources: string[] | null } | null = null;
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
  db: AppDatabase = defaultDb,
  sqlite: Database.Database = defaultSqlite
): Promise<string> {
  // Wrap near-duplicate check and insert/update in an atomic transaction
  // to prevent race conditions during concurrent background ingestion / reflections.
  return db.transaction((tx) => {
    // Near-duplicate merge: reinforce the existing memory instead of
    // inserting a copy. Skipped when no embedding is available.
    if (input.embedding) {
      // Access the underlying better-sqlite3 connection from the Drizzle
      // transaction — tx.session.client is the raw Database instance.
      const rawSqlite: Database.Database =
        (tx as unknown as { session: { client: Database.Database } }).session.client ?? sqlite;
      const duplicate = findNearDuplicate(input.embedding, tx as unknown as AppDatabase, rawSqlite);
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
            embeddingModel: input.embeddingModel ?? null,
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
      embeddingModel: input.embeddingModel ?? null,
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
