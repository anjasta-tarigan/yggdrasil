import fs from "node:fs";
import { desc, eq, isNull, sql, type Table } from "drizzle-orm";
import { databasePath, db as defaultDb, type AppDatabase } from "@/db";
import {
  chatMessages,
  chatSessions,
  episodicMemories,
  jobQueue,
  memoryRelations,
  semanticMemories,
  workingMemories,
} from "@/db/schema";
import { isCognitiveDaemonRunning } from "@/lib/daemon/scheduler";
import { isQueueRunnerRunning } from "@/lib/queue/runner";
import type { JobType } from "@/lib/queue/types";

/**
 * Live statistics about the SQLite database for the Settings → Database
 * panel. All counts come straight from the database file.
 */

const COGNITIVE_JOB_TYPES: JobType[] = [
  "ingest_turn",
  "reflect_turn",
  "sleep_consolidation",
  "dream_graph_discovery",
  "decay_sweep",
  "scheduled_reminder",
];

export type DatabaseStats = {
  engine: string;
  driver: string;
  features: string[];
  /** Absolute path of the SQLite file on the server. */
  path: string;
  /** Size of the database file in bytes (0 when unavailable). */
  sizeBytes: number;
  chatCount: number;
  messageCount: number;
  memories: {
    episodic: number;
    semantic: number;
    working: number;
  };
  queue: {
    pending: number;
    completed: number;
    failed: number;
  };
  /** Health and activity of the autonomous cognitive loop. */
  cognitive: {
    daemonRunning: boolean;
    queueRunnerRunning: boolean;
    relations: number;
    /** Memories still waiting for an embedding (backfill backlog). */
    unembedded: { episodic: number; semantic: number };
    /** Last successful completion per cognitive job type. */
    lastRuns: Array<{ type: JobType; at: string | null }>;
    /** Most recent failed job, if any. */
    lastFailure: { type: string; error: string | null; at: string | null } | null;
  };
};

function count(db: AppDatabase, table: Table): number {
  const rows = db.select({ n: sql<number>`count(*)` }).from(table).all() as Array<{
    n: number;
  }>;
  return Number(rows[0]?.n ?? 0);
}

function countWhere(
  db: AppDatabase,
  table: Table,
  where: ReturnType<typeof isNull>
): number {
  const rows = db
    .select({ n: sql<number>`count(*)` })
    .from(table)
    .where(where)
    .all() as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

export function getDatabaseStats(db: AppDatabase = defaultDb): DatabaseStats {
  const queueRows = db
    .select({ status: jobQueue.status, n: sql<number>`count(*)` })
    .from(jobQueue)
    .groupBy(jobQueue.status)
    .all() as Array<{ status: string; n: number }>;

  const queue = { pending: 0, completed: 0, failed: 0 };
  for (const row of queueRows) {
    if (row.status === "pending" || row.status === "processing") {
      queue.pending += Number(row.n);
    } else if (row.status === "completed") {
      queue.completed += Number(row.n);
    } else if (row.status === "failed") {
      queue.failed += Number(row.n);
    }
  }

  let sizeBytes = 0;
  try {
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (fs.existsSync(file)) {
        sizeBytes += fs.statSync(file).size;
      }
    }
  } catch {
    // File missing or unreadable — report zero.
  }

  // Cognitive loop observability: last completion per job type, the most
  // recent failure, and the embedding backfill backlog.
  const lastRunRows = db
    .select({ type: jobQueue.type, at: sql<number>`max(updated_at)` })
    .from(jobQueue)
    .where(eq(jobQueue.status, "completed"))
    .groupBy(jobQueue.type)
    .all() as Array<{ type: JobType; at: number | null }>;
  const lastRunByType = new Map<JobType, number | null>(
    lastRunRows.map((row) => [row.type, row.at])
  );
  const lastRuns = COGNITIVE_JOB_TYPES.map((type) => {
    const at = lastRunByType.get(type);
    if (at === null || at === undefined) return { type, at: null };
    try {
      const d = new Date(at * 1000);
      return { type, at: Number.isNaN(d.getTime()) ? null : d.toISOString() };
    } catch {
      return { type, at: null };
    }
  });

  const failedRow = db
    .select({
      type: jobQueue.type,
      lastError: jobQueue.lastError,
      updatedAt: jobQueue.updatedAt,
    })
    .from(jobQueue)
    .where(eq(jobQueue.status, "failed"))
    .orderBy(desc(jobQueue.updatedAt))
    .limit(1)
    .get() as
    | { type: string; lastError: string | null; updatedAt: Date | number | null }
    | undefined;
  let failureAt: string | null = null;
  if (failedRow?.updatedAt) {
    try {
      const d =
        typeof failedRow.updatedAt === "number"
          ? new Date(failedRow.updatedAt * 1000)
          : new Date(failedRow.updatedAt);
      if (!Number.isNaN(d.getTime())) {
        failureAt = d.toISOString();
      }
    } catch {
      failureAt = null;
    }
  }
  const lastFailure = failedRow
    ? {
        type: failedRow.type,
        error: failedRow.lastError,
        at: failureAt,
      }
    : null;

  return {
    engine: "SQLite",
    driver: "better-sqlite3 + drizzle-orm",
    features: ["WAL", "FTS5", "sqlite-vec"],
    path: databasePath,
    sizeBytes,
    chatCount: count(db, chatSessions),
    messageCount: count(db, chatMessages),
    memories: {
      episodic: count(db, episodicMemories),
      semantic: count(db, semanticMemories),
      working: count(db, workingMemories),
    },
    queue,
    cognitive: {
      daemonRunning: isCognitiveDaemonRunning(),
      queueRunnerRunning: isQueueRunnerRunning(),
      relations: count(db, memoryRelations),
      unembedded: {
        episodic: countWhere(
          db,
          episodicMemories,
          isNull(episodicMemories.embedding)
        ),
        semantic: countWhere(
          db,
          semanticMemories,
          isNull(semanticMemories.embedding)
        ),
      },
      lastRuns,
      lastFailure,
    },
  };
}
