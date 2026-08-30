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
  let expiredWorkingCount = 0;

  db.transaction((tx) => {
    // 0. Drop expired working-memory notes (TTL-based, written by the
    // memory_note_create tool). They are filtered out of prompt synthesis once
    // expired; this keeps the table from accumulating dead rows.
    // Handles both epoch-second and epoch-millisecond SQLite storage representations.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const nowMillis = Date.now();
    const expiredResult = tx.run(sql`
      DELETE FROM working_memories
      WHERE (expires_at < ${nowSeconds} AND expires_at < 10000000000)
         OR (expires_at < ${nowMillis} AND expires_at >= 10000000000)
    `);
    expiredWorkingCount = expiredResult?.changes ?? 0;

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
    // Prunes memories that fell below threshold (consolidated memories, or severely decayed unconsolidated ones)
    const toPrune = tx.all(sql`
      SELECT id FROM episodic_memories
      WHERE (importance < ${minThreshold} AND consolidated_into IS NOT NULL)
         OR (importance < ${minThreshold / 2.0} AND strftime('%s', 'now') - created_at > 86400 * 30)
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
        WHERE (importance < ${minThreshold} AND consolidated_into IS NOT NULL)
           OR (importance < ${minThreshold / 2.0} AND strftime('%s', 'now') - created_at > 86400 * 30)
      `);
      prunedCount = deleteResult?.changes ?? 0;
    }
  });

  return {
    decayedCount,
    prunedCount,
    expiredWorkingCount,
  };
}

