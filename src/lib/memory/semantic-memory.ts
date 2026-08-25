import { nanoid } from "nanoid";
import { db as defaultDb, type AppDatabase } from "@/db";
import { semanticMemories, memoryRelations } from "@/db/schema";
import { vectorToBuffer } from "./embeddings";
import type { SemanticMemoryInput, MemoryRelationInput } from "./types";

export async function addSemanticMemory(
  input: SemanticMemoryInput,
  db: AppDatabase = defaultDb
): Promise<string> {
  const id = `sem_${nanoid(12)}`;

  await db.insert(semanticMemories).values({
    id,
    content: input.content,
    embedding: input.embedding ? vectorToBuffer(input.embedding) : null,
    importance: input.importance ?? 0.5,
    tags: input.tags ?? [],
    sources: input.sources ?? [],
    metadata: input.metadata ?? {},
  });

  return id;
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
