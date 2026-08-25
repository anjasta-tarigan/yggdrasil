import { sql } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";

export type CompactionOptions = {
  decayRate?: number;
  minImportanceThreshold?: number;
  db?: AppDatabase;
};

export async function runMemoryCompaction(options: CompactionOptions = {}) {
  const minThreshold = options.minImportanceThreshold ?? 0.05;
  const db = options.db ?? defaultDb;

  let decayedCount = 0;
  let prunedCount = 0;

  db.transaction((tx) => {
    // 1. Decay importance on episodic memories using Ebbinghaus exponential curve with access count boost:
    // new_importance = MIN(1.0, MAX(0.01, importance * EXP(-(strftime('%s', 'now') - created_at) / (86400.0 * 14)) + 0.05 * LN(1 + access_count)))
    let updateResult;
    if (options.decayRate !== undefined) {
      updateResult = tx.run(sql`
        UPDATE episodic_memories
        SET importance = MIN(1.0, MAX(0.01, importance * (1.0 - ${options.decayRate})))
      `);
    } else {
      updateResult = tx.run(sql`
        UPDATE episodic_memories
        SET importance = MIN(
          1.0,
          MAX(
            0.01,
            importance * EXP(-((strftime('%s', 'now') - created_at) / (86400.0 * 14.0))) + 0.05 * LN(1 + access_count)
          )
        )
      `);
    }
    decayedCount = updateResult?.changes ?? 0;

    // 2. Identify and delete pruned episodic memories & clean up dangling relations
    const toPrune = tx.all(sql`
      SELECT id FROM episodic_memories
      WHERE importance < ${minThreshold} AND consolidated_into IS NOT NULL
    `) as Array<{ id: string }>;

    if (toPrune.length > 0) {
      const prunedIds = toPrune.map((p) => p.id);
      for (const id of prunedIds) {
        tx.run(sql`
          DELETE FROM memory_relations
          WHERE from_memory_id = ${id} OR to_memory_id = ${id}
        `);
      }

      const deleteResult = tx.run(sql`
        DELETE FROM episodic_memories
        WHERE importance < ${minThreshold} AND consolidated_into IS NOT NULL
      `);
      prunedCount = deleteResult?.changes ?? 0;
    }
  });

  return {
    decayedCount,
    prunedCount,
  };
}

