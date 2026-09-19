import { sql } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";

export type CompactionOptions = {
  decayRate?: number;
  minImportanceThreshold?: number;
  db?: AppDatabase;
};

export interface CompactionResult {
  decayedCount: number;
  prunedCount: number;
  expiredWorkingCount: number;
  /** Semantic rows pruned (superseded/invalidated memories). */
  prunedSemanticCount: number;
}

export async function runMemoryCompaction(options: CompactionOptions = {}): Promise<CompactionResult> {
  const minThreshold = options.minImportanceThreshold ?? 0.05;
  const db = options.db ?? defaultDb;

  let decayedCount = 0;
  let prunedCount = 0;
  let expiredWorkingCount = 0;
  let prunedSemanticCount = 0;

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

    // 3. Decay semantic memories with the same Ebbinghaus curve, keyed on
    // updated_at (last touch) rather than created_at: a fact reinforced by
    // near-duplicate merges must not keep decaying from its birth date.
    // Semantic rows are never pruned by decay alone here — only by the
    // explicit invalidation pass below — so decay only lowers importance.
    let semanticDecayResult;
    if (options.decayRate !== undefined) {
      semanticDecayResult = tx.run(sql`
        UPDATE semantic_memories
        SET importance = MIN(1.0, MAX(0.01, importance * (1.0 - ${options.decayRate})))
      `);
    } else {
      semanticDecayResult = tx.run(sql`
        UPDATE semantic_memories
        SET importance = MIN(
          1.0,
          MAX(
            0.01,
            importance * EXP(-((strftime('%s', 'now') - updated_at) / (86400.0 * 14.0))) + 0.05 * LN(1 + access_count)
          )
        )
      `);
    }
    decayedCount += semanticDecayResult?.changes ?? 0;

    // 4. Prune invalidated semantic memories: rows the reflection loop marked
    // superseded. Supersession is an explicit invalidation signal — not a
    // low-importance heuristic — so eligibility keys on the `superseded` flag
    // plus the `superseded_by` relation. It deliberately does NOT gate on
    // `importance <= 0.1`: the decay pass above adds `0.05 * LN(1 +
    // access_count)`, so any superseded row accessed a handful of times floats
    // back above 0.1 and would never be pruned. The anchor guard keeps any
    // semantic row that still has incoming consolidated_into edges from live
    // episodic children — pruning a row that younger memories consolidated
    // into would orphan their provenance.
    const toPruneSemantic = tx.all(sql`
      SELECT s.id FROM semantic_memories s
      WHERE s.metadata LIKE '%"superseded":true%'
        AND EXISTS (
          SELECT 1 FROM memory_relations r
          WHERE r.from_memory_id = s.id AND r.relation_type = 'superseded_by'
        )
        AND NOT EXISTS (
          SELECT 1 FROM memory_relations r
          WHERE r.to_memory_id = s.id AND r.relation_type = 'consolidated_into'
        )
    `) as Array<{ id: string }>;

    if (toPruneSemantic.length > 0) {
      for (const { id } of toPruneSemantic) {
        tx.run(sql`
          DELETE FROM memory_relations
          WHERE from_memory_id = ${id} OR to_memory_id = ${id}
        `);
        tx.run(sql`DELETE FROM semantic_memories WHERE id = ${id}`);
      }
      prunedSemanticCount = toPruneSemantic.length;
    }
  });

  return {
    decayedCount,
    prunedCount,
    expiredWorkingCount,
    prunedSemanticCount,
  };
}

