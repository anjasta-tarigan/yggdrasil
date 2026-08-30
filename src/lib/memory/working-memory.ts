import { nanoid } from "nanoid";
import { eq, gt } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { workingMemories } from "@/db/schema";
import { vectorToBuffer } from "./embeddings";
import type { WorkingMemoryInput } from "./types";

export async function addWorkingMemory(
  input: WorkingMemoryInput,
  db: AppDatabase = defaultDb
): Promise<string> {
  const id = `wm_${nanoid(12)}`;
  const ttl = input.ttlSeconds ?? 3600; // default 1 hour
  const expiresAt = new Date(Date.now() + ttl * 1000);

  await db.insert(workingMemories).values({
    id,
    content: input.content,
    tags: input.tags ?? [],
    embedding: input.embedding ? vectorToBuffer(input.embedding) : null,
    expiresAt,
  });

  return id;
}

export async function getActiveWorkingMemories(db: AppDatabase = defaultDb) {
  const now = new Date();
  return db
    .select()
    .from(workingMemories)
    .where(gt(workingMemories.expiresAt, now));
}

/**
 * Deletes a working-memory note by id (used by the `memory_note_delete` tool).
 * Returns true when a row was removed.
 */
export async function deleteWorkingMemory(
  id: string,
  db: AppDatabase = defaultDb
): Promise<boolean> {
  const result = await db
    .delete(workingMemories)
    .where(eq(workingMemories.id, id))
    .run();
  return (result.changes ?? 0) > 0;
}
