import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import * as schema from "./schema";
import { setupFtsAndTriggers } from "./init";

const DB_PATH = process.env.DATABASE_PATH || path.resolve(process.cwd(), "data/yggdrasil.db");

// Ensure data directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const sqlite = new Database(DB_PATH);

// Rule 15: Critical SQLite Production Pragmas
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

// Load sqlite-vec extension if available
try {
  const sqliteVec = require("sqlite-vec");
  sqliteVec.load(sqlite);
} catch (e) {
  // sqlite-vec optional load fallback
  console.info("[db] sqlite-vec not loaded natively; falling back to in-memory cosine ranking");
}

setupFtsAndTriggers(sqlite);

export const db = drizzle(sqlite, { schema });
export type AppDatabase = typeof db;
