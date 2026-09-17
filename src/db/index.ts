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

// Ensure data directory exists
const dbDir = path.dirname(DB_PATH);
if (!/* turbopackIgnore: true */ fs.existsSync(dbDir)) {
  fs.mkdirSync(/* turbopackIgnore: true */ dbDir, { recursive: true });
}

export const sqlite = new Database(DB_PATH);

// Rule 15: Critical SQLite Production Pragmas
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

// Load sqlite-vec extension if available
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqliteVec = /* turbopackIgnore: true */ require("sqlite-vec");
  sqliteVec.load(sqlite);
} catch {
  // sqlite-vec optional load fallback
  syslog("info", "db", "sqlite-vec not loaded natively; falling back to in-memory cosine ranking");
}

setupFtsAndTriggers(sqlite);

export const db = drizzle(sqlite, { schema });
export type AppDatabase = typeof db;
