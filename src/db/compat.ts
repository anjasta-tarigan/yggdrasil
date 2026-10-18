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
 * `node:sqlite`'s `DatabaseSync` doesn't have `.transaction()`. Add one that
 * mirrors `better-sqlite3`'s `db.transaction(fn)` — returns a function with
 * `.immediate()`, `.deferred()`, `.exclusive()` accessors.
 */
export function withTransaction<T extends DatabaseSync>(db: T): T & TransactionCompat {
  const compat = db as T & TransactionCompat;
  compat.transaction = function transaction<T2>(fn: () => T2): TransactionFn<T2> {
    const run = (behavior: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE"): T2 => {
      db.exec(`BEGIN ${behavior}`);
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
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
