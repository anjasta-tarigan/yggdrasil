import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { env } from "@/env";
import { syslog } from "@/lib/observability/log-store";
import * as schema from "./schema";
import { setupFtsAndTriggers } from "./init";

const DB_PATH =
  env.DATABASE_PATH || path.resolve(/* turbopackIgnore: true */ process.cwd(), "data/yggdrasil.db");

/** Absolute path of the SQLite file (for diagnostics/settings UI). */
export const databasePath = DB_PATH;

/**
 * The live SQLite client, created on first use.
 *
 * Opening the database (and running `setupFtsAndTriggers`) at module-evaluation
 * time meant every `next build` worker that imported any route reaching `@/db`
 * opened and mutated the *live* production database. Parallel page-data workers
 * then raced on the additive schema migrations and the loser aborted the build
 * with `SqliteError: duplicate column name: …`. Deferring creation to first use
 * keeps a build side-effect-free: page collection only imports route modules, it
 * never queries them, so the file is never opened. At runtime the first query
 * opens it and runs the migrations exactly once.
 */
let realSqlite: Database.Database | null = null;

function getSqlite(): Database.Database {
  if (realSqlite) return realSqlite;

  const dbDir = path.dirname(DB_PATH);
  if (!/* turbopackIgnore: true */ fs.existsSync(dbDir)) {
    fs.mkdirSync(/* turbopackIgnore: true */ dbDir, { recursive: true });
  }

  const client = new Database(DB_PATH);

  try {
    // Rule 15: Critical SQLite Production Pragmas
    client.pragma("journal_mode = WAL");
    client.pragma("synchronous = NORMAL");
    client.pragma("foreign_keys = ON");
    client.pragma("busy_timeout = 5000");

    // Load sqlite-vec extension if available
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = /* turbopackIgnore: true */ require("sqlite-vec");
      sqliteVec.load(client);
    } catch (err) {
      syslog("debug", "index", `Error: ${err instanceof Error ? err.message : String(err)}`);
      // sqlite-vec optional load fallback
      syslog("info", "db", "sqlite-vec not loaded natively; falling back to in-memory cosine ranking");
    }

    setupFtsAndTriggers(client);
  } catch (err) {
    // Fail loudly, but don't leak the handle: a later call retries from
    // scratch rather than piling up open connections on every failure.
    try {
      client.close();
    } catch (closeErr) {
      // The init error is the actionable one; surface the close failure too
      // rather than hiding it.
      console.error(
        `[db] Failed to close SQLite handle after init error: ${
          closeErr instanceof Error ? closeErr.message : String(closeErr)
        }`
      );
    }
    throw err;
  }

  realSqlite = client;
  return client;
}

/**
 * Shared SQLite client. A proxy that opens the underlying database on first
 * property access, so importing `@/db` has no side effects (see `getSqlite`).
 * Drizzle only ever touches `prepare` and `transaction` on this client, both of
 * which the proxy forwards to the real, bound implementation.
 */
export const sqlite: Database.Database = new Proxy({} as Database.Database, {
  get(target, prop) {
    // `drizzle()` reads `client.constructor`; report the real class.
    if (prop === "constructor") return Database;
    // Honour own properties defined on the target — e.g. a test that stubs
    // `prepare` via `vi.spyOn(sqlite, "prepare")` defines the replacement
    // there, and a transparent proxy must not bypass it.
    if (Object.prototype.hasOwnProperty.call(target, prop)) {
      return Reflect.get(target, prop);
    }
    const client = getSqlite();
    const value = Reflect.get(client, prop);
    return typeof value === "function" ? value.bind(client) : value;
  },
  getPrototypeOf() {
    return Database.prototype;
  },
});

export const db = drizzle(sqlite, { schema });
export type AppDatabase = typeof db;
