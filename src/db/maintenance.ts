import type Database from "better-sqlite3";
import { db as defaultDb, sqlite as defaultSqlite } from "./index";
import { syslog } from "@/lib/observability/log-store";

export interface VacuumResult {
  pagesBefore: number;
  pagesAfter: number;
  recoveredBytes: number;
}

export interface ResetCounts {
  jobQueue: number;
  proactiveEvents: number;
  projectMessages: number;
  projectSessions: number;
  chatMessages: number;
  chatSessions: number;
  memoryRelations: number;
  workingMemories: number;
  episodicMemories: number;
  semanticMemories: number;
  webProviderSessions: number;
  /** Project rows actually distrusted by the reset (were trusted before). */
  projectsDistrusted: number;
}

/**
 * Rows deleted by a reset, excluding the kept-but-distrusted project rows.
 * Single home for the formula so the syslog line and the API route cannot
 * drift apart.
 */
export function totalRecordsDeleted(counts: ResetCounts): number {
  return (
    Object.values(counts).reduce((a: number, b: number) => a + b, 0) -
    counts.projectsDistrusted
  );
}

/**
 * Tables wiped by a database reset, in delete order. Children before
 * parents so FK constraints hold even if a caller runs them outside a
 * transaction. `projects` is intentionally absent — project rows are kept
 * and distrusted instead of deleted (see resetDatabase).
 */
export const RESET_TABLES_IN_ORDER = [
  "job_queue",
  "proactive_events",
  "project_messages",
  "project_sessions",
  "chat_messages",
  "chat_sessions",
  "memory_relations",
  "working_memories",
  "episodic_memories",
  "semantic_memories",
  "web_provider_sessions",
] as const;

/** Read the current SQLite page count. */
function pageCount(sqlite: Database.Database): number {
  const row = sqlite.prepare("PRAGMA page_count;").get() as {
    page_count: number;
  };
  return row.page_count;
}

/**
 * Refresh the query-planner statistics so the optimizer picks good plans.
 * Fast and safe to run any time; also runs automatically inside the daily
 * decay_sweep pass (see bootstrap.ts).
 */
export async function runPragmaOptimize(
  sqlite: Database.Database = defaultSqlite
): Promise<void> {
  const startedAt = Date.now();
  try {
    sqlite.prepare("PRAGMA optimize;").run();
    syslog(
      "info",
      "db",
      `PRAGMA optimize completed in ${Date.now() - startedAt}ms`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    syslog("error", "db", `PRAGMA optimize failed: ${msg}`);
    throw err instanceof Error ? err : new Error(msg);
  }
}

/**
 * Rebuild the database file to reclaim free pages. Must run OUTSIDE any
 * transaction — SQLite rejects VACUUM inside one — so callers must not wrap
 * this in db.transaction().
 */
export async function runVacuum(
  sqlite: Database.Database = defaultSqlite
): Promise<VacuumResult> {
  const startedAt = Date.now();
  try {
    const pagesBefore = pageCount(sqlite);
    sqlite.prepare("VACUUM;").run();
    const pagesAfter = pageCount(sqlite);
    const pageSizeRow = sqlite.prepare("PRAGMA page_size;").get() as {
      page_size: number;
    };
    const recoveredBytes =
      Math.max(0, pagesBefore - pagesAfter) * pageSizeRow.page_size;
    syslog(
      "info",
      "db",
      `VACUUM completed in ${Date.now() - startedAt}ms: ${pagesBefore} → ${pagesAfter} pages (~${recoveredBytes} bytes reclaimed)`
    );
    return { pagesBefore, pagesAfter, recoveredBytes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    syslog("error", "db", `VACUUM failed: ${msg}`);
    throw err instanceof Error ? err : new Error(msg);
  }
}

/**
 * Permanently delete all conversation, memory, project-session and queue
 * data. Settings, API keys, plugins, skills and cron schedules are
 * preserved. Project rows are kept but distrusted (trusted=false,
 * trusted_at=NULL) so directories must be re-authorized.
 *
 * Deletes run inside a single transaction; VACUUM runs after commit
 * (SQLite forbids it inside a transaction). Callers with a busy database
 * rely on the shared busy_timeout=5000 pragma; SQLITE_BUSY surfaces as a
 * thrown error for the route to map to 409.
 */
/**
 * Minimal surface resetDatabase needs: a synchronous transaction runner.
 * Narrower than AppDatabase so tests can stub the busy-lock path without
 * fabricating a full drizzle instance.
 */
export interface TransactionalDatabase {
  transaction<T>(fn: () => T): T;
}

export async function resetDatabase(
  dbInstance: TransactionalDatabase = defaultDb,
  sqlite: Database.Database = defaultSqlite
): Promise<ResetCounts> {
  const startedAt = Date.now();
  syslog("warn", "db", "Database reset initiated");

  const deleted: ResetCounts = dbInstance.transaction(() => {
    const count = (table: (typeof RESET_TABLES_IN_ORDER)[number]): number => {
      // Table names are hard-coded constants above, never user input.
      const result = sqlite.prepare(`DELETE FROM ${table};`).run();
      return Number(result.changes ?? 0);
    };

    const counts: ResetCounts = {
      jobQueue: count("job_queue"),
      proactiveEvents: count("proactive_events"),
      projectMessages: count("project_messages"),
      projectSessions: count("project_sessions"),
      chatMessages: count("chat_messages"),
      chatSessions: count("chat_sessions"),
      memoryRelations: count("memory_relations"),
      workingMemories: count("working_memories"),
      episodicMemories: count("episodic_memories"),
      semanticMemories: count("semantic_memories"),
      webProviderSessions: count("web_provider_sessions"),
      projectsDistrusted: 0,
    };

    // Only rows that were actually trusted count as distrusted: SQLite
    // reports every matched row in `changes`, including rows already at 0.
    const distrust = sqlite
      .prepare(
        "UPDATE projects SET trusted = 0, trusted_at = NULL WHERE trusted != 0;"
      )
      .run();
    counts.projectsDistrusted = Number(distrust.changes ?? 0);

    return counts;
  });

  // Reclaim space after commit — never inside the transaction above.
  try {
    await runVacuum(sqlite);
  } catch (err) {
    // Non-fatal: the data is already gone; log and continue.
    syslog(
      "warn",
      "db",
      `VACUUM after reset failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const totalDeleted = totalRecordsDeleted(deleted);
  syslog(
    "info",
    "db",
    `Database reset completed in ${Date.now() - startedAt}ms: ${totalDeleted} rows deleted, ${deleted.projectsDistrusted} projects distrusted`
  );

  return deleted;
}

/** True when `err` is SQLite's database-locked/busy error. */
export function isBusyError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /SQLITE_BUSY|database (is )?locked/i.test(err.message)
  );
}
