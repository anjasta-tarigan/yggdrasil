import type Database from "better-sqlite3";

/**
 * Add a column to an existing table when it is missing. SQLite's
 * `CREATE TABLE IF NOT EXISTS` never alters tables that already exist,
 * so databases created before a column was introduced need a lightweight
 * idempotent migration. Table/column names are hard-coded constants.
 */
function ensureColumn(
  sqlite: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

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
      embedding_model TEXT,
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
      embedding_model TEXT,
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

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS plugin_marketplaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      owner_name TEXT,
      source TEXT,
      last_synced_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      marketplace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT,
      description TEXT,
      version TEXT,
      category TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT,
      components TEXT,
      installed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (marketplace_id) REFERENCES plugin_marketplaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      version TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT,
      plugin_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS plugin_commands (
      id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      argument_hint TEXT,
      content TEXT NOT NULL,
      FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS proactive_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'reminder',
      title TEXT NOT NULL,
      body TEXT,
      chat_id TEXT,
      read_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      directory_path TEXT NOT NULL UNIQUE,
      is_custom_directory INTEGER NOT NULL DEFAULT 0,
      trusted INTEGER NOT NULL DEFAULT 0,
      trusted_at INTEGER,
      custom_instructions TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS project_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      active_stream_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS project_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_job_queue_status_run_at ON job_queue(status, run_at);
    CREATE INDEX IF NOT EXISTS idx_proactive_events_read_at ON proactive_events(read_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_episodic_memories_session_id ON episodic_memories(session_id);
    CREATE INDEX IF NOT EXISTS idx_project_sessions_project_id ON project_sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_messages_session_id ON project_messages(session_id);
  `);

  // 1b. Idempotent column migrations for pre-existing databases.
  // Embedding model versioning — lets the backfill pass detect stale vectors.
  ensureColumn(sqlite, "episodic_memories", "embedding_model", "TEXT");
  ensureColumn(sqlite, "semantic_memories", "embedding_model", "TEXT");
  ensureColumn(sqlite, "chat_sessions", "pinned", "INTEGER NOT NULL DEFAULT 0");
  // Active resumable-stream pointer (see src/lib/ai/stream-registry.ts):
  // null when no generation is running for the chat; set while one is.
  // The GET /api/chat/[id]/stream resume endpoint reads it.
  ensureColumn(
    sqlite,
    "chat_sessions",
    "active_stream_id",
    "TEXT"
  );
  ensureColumn(
    sqlite,
    "projects",
    "is_custom_directory",
    "INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(
    sqlite,
    "project_sessions",
    "pinned",
    "INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(
    sqlite,
    "project_sessions",
    "active_stream_id",
    "TEXT"
  );

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

    CREATE TRIGGER IF NOT EXISTS trg_episodic_memories_update AFTER UPDATE OF content ON episodic_memories BEGIN
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

    CREATE TRIGGER IF NOT EXISTS trg_semantic_memories_update AFTER UPDATE OF content ON semantic_memories BEGIN
      INSERT INTO semantic_memories_fts(semantic_memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO semantic_memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);
}
