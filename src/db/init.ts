import type Database from "better-sqlite3";

export function setupFtsAndTriggers(sqlite: Database.Database): void {
  // 1. Create base tables if they do not exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      embedded_in_memory TEXT,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS working_memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      embedding BLOB,
      tags TEXT DEFAULT '[]',
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS episodic_memories (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      content TEXT NOT NULL,
      embedding BLOB,
      importance REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER,
      tags TEXT DEFAULT '[]',
      metadata TEXT,
      consolidated_into TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS semantic_memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      embedding BLOB,
      importance REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER,
      tags TEXT DEFAULT '[]',
      sources TEXT DEFAULT '[]',
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS memory_relations (
      id TEXT PRIMARY KEY,
      from_memory_id TEXT NOT NULL,
      from_memory_type TEXT NOT NULL,
      to_memory_id TEXT NOT NULL,
      to_memory_type TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      strength REAL NOT NULL DEFAULT 0.5,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS job_queue (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      locked_at INTEGER,
      run_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_job_queue_status_run_at ON job_queue(status, run_at);
  `);

  // 2. FTS5 External Content Virtual Tables & Triggers
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS episodic_memories_fts USING fts5(
      content,
      content='episodic_memories',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS trg_episodic_memories_insert AFTER INSERT ON episodic_memories BEGIN
      INSERT INTO episodic_memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_episodic_memories_delete AFTER DELETE ON episodic_memories BEGIN
      INSERT INTO episodic_memories_fts(episodic_memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_episodic_memories_update AFTER UPDATE ON episodic_memories BEGIN
      INSERT INTO episodic_memories_fts(episodic_memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO episodic_memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memories_fts USING fts5(
      content,
      content='semantic_memories',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS trg_semantic_memories_insert AFTER INSERT ON semantic_memories BEGIN
      INSERT INTO semantic_memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_semantic_memories_delete AFTER DELETE ON semantic_memories BEGIN
      INSERT INTO semantic_memories_fts(semantic_memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_semantic_memories_update AFTER UPDATE ON semantic_memories BEGIN
      INSERT INTO semantic_memories_fts(semantic_memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO semantic_memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);
}
