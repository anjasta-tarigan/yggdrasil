import fs from "node:fs";
import { sql, type Table } from "drizzle-orm";
import { databasePath, db as defaultDb, type AppDatabase } from "@/db";
import {
  chatMessages,
  chatSessions,
  episodicMemories,
  jobQueue,
  semanticMemories,
  workingMemories,
} from "@/db/schema";

/**
 * Live statistics about the SQLite database for the Settings → Database
 * panel. All counts come straight from the database file.
 */

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
};

function count(db: AppDatabase, table: Table): number {
  const rows = db.select({ n: sql<number>`count(*)` }).from(table).all() as Array<{
    n: number;
  }>;
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
    sizeBytes = fs.statSync(databasePath).size;
  } catch {
    // File missing or unreadable — report zero.
  }

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
  };
}
