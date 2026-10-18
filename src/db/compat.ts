import { DatabaseSync } from "node:sqlite";

/**
 * `node:sqlite`'s `DatabaseSync` doesn't provide the `.pragma()` method that
 * `better-sqlite3` does. This adds it to a `DatabaseSync` instance, matching
 * `better-sqlite3`'s behavior:
 *
 * - `.pragma("key = value")` → runs `PRAGMA key = value`, returns void
 * - `.pragma("table_info(t)")` → runs the pragma, returns rows as objects (`.all()`)
 * - `.pragma("name", { simple: true })` → returns the first column of the first row
 */
export function withPragma<T extends DatabaseSync>(db: T): T & PragmaCompat {
  const compat = db as T & PragmaCompat;
  compat.pragma = function pragma(sql: string, options?: { simple?: boolean }): unknown {
    const trimmed = sql.trim();
    if (trimmed.includes("=")) {
      compat.exec(`PRAGMA ${trimmed}`);
      return undefined;
    }
    const stmt = compat.prepare(`PRAGMA ${trimmed}`);
    const rows = stmt.all();
    if (options?.simple && rows.length > 0) {
      const row = rows[0] as Record<string, unknown>;
      return Object.values(row)[0];
    }
    return rows;
  };
  return compat;
}

/**
 * Tracks transaction depth per `DatabaseSync` instance.
 * Shared between the compat layer's `.transaction()` and the Drizzle adapter's
 * `NodeSqliteSession.transaction()` so that savepoints are used for nesting
 * regardless of which layer started the outer transaction.
 */
export const txDepthMap = new WeakMap<DatabaseSync, number>();

/**
 * `node:sqlite`'s `DatabaseSync` doesn't have `.transaction()`. Add one that
 * mirrors `better-sqlite3`'s `db.transaction(fn)` — returns a function with
 * `.immediate()`, `.deferred()`, `.exclusive()` accessors.
 *
 * Uses savepoints for nested transactions to avoid
 * "cannot start a transaction within a transaction" errors.
 */
export function withTransaction<T extends DatabaseSync>(db: T): T & TransactionCompat {
  const compat = db as T & TransactionCompat;
  compat.transaction = function transaction<T2>(fn: () => T2): TransactionFn<T2> {
    const run = (behavior: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE"): T2 => {
      const depth = txDepthMap.get(db) ?? 0;
      const isNested = depth > 0;
      const savepointName = `sp${depth}`;

      if (isNested) {
        db.exec(`SAVEPOINT ${savepointName}`);
      } else {
        db.exec(`BEGIN ${behavior}`);
      }
      txDepthMap.set(db, depth + 1);

      try {
        const result = fn();
        txDepthMap.set(db, depth);
        if (isNested) {
          db.exec(`RELEASE SAVEPOINT ${savepointName}`);
        } else {
          db.exec("COMMIT");
        }
        return result;
      } catch (err) {
        txDepthMap.set(db, depth);
        if (isNested) {
          db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          db.exec(`RELEASE SAVEPOINT ${savepointName}`);
        } else {
          db.exec("ROLLBACK");
        }
        throw err;
      }
    };
    const tx = ((fn2?: () => T2): T2 => {
      if (fn2) return run("DEFERRED");
      return run("DEFERRED");
    }) as unknown as TransactionFn<T2>;
    tx.immediate = () => run("IMMEDIATE");
    tx.deferred = () => run("DEFERRED");
    tx.exclusive = () => run("EXCLUSIVE");
    return tx;
  };
  return compat;
}

export interface PragmaCompat {
  pragma(sql: string, options?: { simple?: boolean }): unknown;
}

export interface TransactionCompat {
  transaction<T>(fn: () => T): TransactionFn<T>;
}

export interface TransactionFn<T> {
  (): T;
  immediate(): T;
  deferred(): T;
  exclusive(): T;
}

/**
 * Create a `DatabaseSync` instance with both `.pragma()` and `.transaction()`
 * compatibility methods. Use this in tests to replace `new Database(":memory:")`.
 */
export function createTestDb(filepath: string): DatabaseSync & PragmaCompat & TransactionCompat {
  const db = new DatabaseSync(filepath, { allowExtension: true });
  return withTransaction(withPragma(db));
}

/** Type combining all compat methods. */
export type CompatDatabaseSync = DatabaseSync & PragmaCompat & TransactionCompat;
