import { sql } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";

export type CompactionOptions = {
  decayRate?: number;
  minImportanceThreshold?: number;
  db?: AppDatabase;
};

export async function runMemoryCompaction(options: CompactionOptions = {}) {
  const decayRate = options.decayRate ?? 0.05; // 5% decay per sweep
  const minThreshold = options.minImportanceThreshold ?? 0.08;
  const db = options.db ?? defaultDb;

  // 1. Decay importance on episodic memories
  await db.run(sql`
    UPDATE episodic_memories
    SET importance = MAX(0.01, importance * (1.0 - ${decayRate}))
  `);

  // 2. Delete decayed low-importance episodic memories that have been consolidated
  const deleteResult = await db.run(sql`
    DELETE FROM episodic_memories
    WHERE importance < ${minThreshold} AND consolidated_into IS NOT NULL
  `);

  return {
    decayedCount: 1,
    prunedCount: deleteResult?.changes ?? 0,
  };
}
