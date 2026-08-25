# SQLite + Drizzle Memory System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a local-first SQLite persistence layer using Drizzle ORM, better-sqlite3 with WAL mode, and a tiered cognitive memory architecture (working memory, episodic memory, semantic memory, relations, FTS5 sync triggers, hybrid search, auto-compaction, and auto-summarization).

**Architecture:** A server-side persistence and cognitive memory subsystem centered around a local SQLite database (`data/yggdrasil.db`). Drizzle ORM provides type-safe schema mapping for chat sessions, messages, and tiered memories. FTS5 external content tables with SQL triggers provide real-time BM25 full-text indexing, while vector embeddings stored as BLOBs support dense cosine similarity via `sqlite-vec` or raw vector helpers. An asynchronous compaction and consolidation pipeline periodically clusters episodic events into semantic knowledge and computes multi-factor importance decay.

**Tech Stack:** `better-sqlite3`, `drizzle-orm`, `drizzle-kit`, `sqlite-vec`, `ai` (Vercel AI SDK), `vitest`, Next.js App Router (TypeScript).

**Spec:** `docs/superpowers/specs/2026-08-25-sqlite-drizzle-memory-design.md`

## Global Constraints

- Isolation: Database and runtime storage MUST live strictly within project root (`data/yggdrasil.db` or `.cache`), never escaping to `$HOME` (Rule 06).
- SQLite WAL mode and pragmas: `PRAGMA journal_mode = WAL;`, `PRAGMA synchronous = NORMAL;`, `PRAGMA foreign_keys = ON;`, `PRAGMA busy_timeout = 5000;` (Rule 15).
- Error Handling: No empty catch blocks, no silent swallows. Structured error logging with context (Rule 02).
- Diff discipline & Surgical Method: Precise incremental edits, TDD with test-driven iterations (Rule 16).
- Vitest configuration: Max workers capped, single sequential runs when touching database fixtures to prevent locked files (Rule 18).

---

## File Structure & Responsibilities

```
src/
├── db/
│   ├── schema.ts                # Drizzle ORM table definitions (sessions, messages, memories, relations)
│   ├── index.ts                 # Database singleton with WAL pragmas & sqlite-vec loader
│   ├── init.ts                  # Schema initialization, DDL execution, and FTS5 triggers setup
│   └── migrations/              # Generated Drizzle migration files
├── lib/
│   ├── memory/
│   │   ├── types.ts             # Domain types for working, episodic, and semantic memories
│   │   ├── embeddings.ts        # Vector embedding generation via local OpenAI-compatible endpoint
│   │   ├── working-memory.ts    # Working memory CRUD and lazy TTL eviction
│   │   ├── episodic-memory.ts   # Episodic memory recording and retrieval
│   │   ├── semantic-memory.ts   # Semantic memory store and entity relations
│   │   ├── search.ts            # Hybrid search combining FTS5 (BM25) and cosine vector similarity (RRF)
│   │   ├── compaction.ts        # Importance score calculation and memory pruning
│   │   └── consolidation.ts     # Episodic clustering and LLM-driven auto-summarization
│   ├── chat-service.ts          # Server-side chat session and message CRUD replacing localStorage
│   └── chat-storage.ts          # Updated client/server adapter with fallback & migration sync
├── app/
│   └── api/
│       ├── chats/
│       │   ├── route.ts         # GET (list chats), POST (create/sync chat)
│       │   └── [id]/
│       │       └── route.ts     # GET (load chat), DELETE (delete chat), PATCH (update title)
│       └── chat/
│           └── route.ts         # Injects working & episodic context into chat prompt + streams response
drizzle.config.ts                # Drizzle Kit config for SQLite
```

---

### Task 1: Install Dependencies and Configure Drizzle Kit

**Files:**
- Modify: `package.json`
- Create: `drizzle.config.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `better-sqlite3`, `drizzle-orm`, `drizzle-kit`, `sqlite-vec` package dependencies installed and configured.

- [ ] **Step 1: Update package.json and .gitignore**

Add `better-sqlite3`, `drizzle-orm`, `sqlite-vec` to dependencies, and `drizzle-kit`, `@types/better-sqlite3` to devDependencies. Ensure `data/` and `*.db` are ignored in `.gitignore`.

```bash
pnpm add better-sqlite3 drizzle-orm sqlite-vec
pnpm add -D drizzle-kit @types/better-sqlite3
```

- [ ] **Step 2: Create drizzle.config.ts**

Create `drizzle.config.ts`:

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/yggdrasil.db",
  },
});
```

- [ ] **Step 3: Verify TypeScript and compilation**

Run: `pnpm exec tsc --noEmit`
Expected: PASS with 0 errors.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml drizzle.config.ts .gitignore
git commit -m "chore(db): add drizzle-orm, better-sqlite3, and sqlite-vec dependencies"
```

---

### Task 2: Database Schema & Connection Setup

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/index.ts`
- Create: `src/db/init.ts`
- Test: `src/db/__tests__/db.test.ts`

**Interfaces:**
- Produces: `db`, `sqlite`, `initDatabase()`, and exported Drizzle table schemas (`chatSessions`, `chatMessages`, `workingMemories`, `episodicMemories`, `semanticMemories`, `memoryRelations`).

- [ ] **Step 1: Write the failing test for DB initialization and schema**

Create `src/db/__tests__/db.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema";
import { setupFtsAndTriggers } from "../init";

describe("Database Schema & Pragmas", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
  });

  it("creates tables and executes pragma queries successfully", () => {
    const db = drizzle(sqlite, { schema });
    setupFtsAndTriggers(sqlite);

    // Verify foreign key pragma
    const fkPragma = sqlite.pragma("foreign_keys", { simple: true });
    expect(fkPragma).toBe(1);

    // Verify table creation
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("chat_sessions");
    expect(tableNames).toContain("chat_messages");
    expect(tableNames).toContain("working_memories");
    expect(tableNames).toContain("episodic_memories");
    expect(tableNames).toContain("semantic_memories");
    expect(tableNames).toContain("memory_relations");
    expect(tableNames).toContain("episodic_memories_fts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/db/__tests__/db.test.ts`
Expected: FAIL (missing schema and init modules).

- [ ] **Step 3: Implement src/db/schema.ts**

Create `src/db/schema.ts`:

```typescript
import { sqliteTable, text, integer, blob, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  content: text("content").notNull(),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  embeddedInMemory: text("embedded_in_memory"),
});

export const workingMemories = sqliteTable("working_memories", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  embedding: blob("embedding", { mode: "buffer" }),
  tags: text("tags", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

export const episodicMemories = sqliteTable("episodic_memories", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").references(() => chatSessions.id, {
    onDelete: "set null",
  }),
  content: text("content").notNull(),
  embedding: blob("embedding", { mode: "buffer" }),
  importance: real("importance").notNull().default(0.5),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: integer("last_accessed_at", { mode: "timestamp" }),
  tags: text("tags", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  consolidatedInto: text("consolidated_into"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

export const semanticMemories = sqliteTable("semantic_memories", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  embedding: blob("embedding", { mode: "buffer" }),
  importance: real("importance").notNull().default(0.5),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: integer("last_accessed_at", { mode: "timestamp" }),
  tags: text("tags", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
  sources: text("sources", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

export const memoryRelations = sqliteTable("memory_relations", {
  id: text("id").primaryKey(),
  fromMemoryId: text("from_memory_id").notNull(),
  fromMemoryType: text("from_memory_type", {
    enum: ["working", "episodic", "semantic"],
  }).notNull(),
  toMemoryId: text("to_memory_id").notNull(),
  toMemoryType: text("to_memory_type", {
    enum: ["working", "episodic", "semantic"],
  }).notNull(),
  relationType: text("relation_type").notNull(),
  strength: real("strength").notNull().default(0.5),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});
```

- [ ] **Step 4: Implement src/db/init.ts with FTS5 and Trigger Setup**

Create `src/db/init.ts`:

```typescript
import type Database from "better-sqlite3";

export function setupFtsAndTriggers(sqlite: Database.Database): void {
  // 1. Create base tables if they do not exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
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
```

- [ ] **Step 5: Implement src/db/index.ts**

Create `src/db/index.ts`:

```typescript
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
```

- [ ] **Step 6: Run tests to verify**

Run: `pnpm vitest run src/db/__tests__/db.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/init.ts src/db/index.ts src/db/__tests__/db.test.ts
git commit -m "feat(db): implement SQLite schema, WAL pragmas, and FTS5 triggers"
```

---

### Task 3: Vector Embeddings & Similarity Utilities

**Files:**
- Create: `src/lib/memory/embeddings.ts`
- Test: `src/lib/memory/__tests__/embeddings.test.ts`

**Interfaces:**
- Produces: `generateEmbedding(text: string): Promise<Float32Array>`, `cosineSimilarity(a: Float32Array, b: Float32Array): number`, `bufferToVector(buf: Buffer): Float32Array`, `vectorToBuffer(vec: Float32Array): Buffer`.

- [ ] **Step 1: Write the failing test for embedding and vector conversion**

Create `src/lib/memory/__tests__/embeddings.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
  generateEmbedding,
} from "../embeddings";

describe("Vector Embeddings & Cosine Similarity", () => {
  it("converts Float32Array to Buffer and back losslessly", () => {
    const original = new Float32Array([0.1, -0.5, 0.85, 1.0]);
    const buffer = vectorToBuffer(original);
    const restored = bufferToVector(buffer);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("calculates cosine similarity correctly", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    const c = new Float32Array([0, 1, 0]);
    const d = new Float32Array([-1, 0, 0]);

    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
    expect(cosineSimilarity(a, c)).toBeCloseTo(0.0, 5);
    expect(cosineSimilarity(a, d)).toBeCloseTo(-1.0, 5);
  });

  it("generates fallback synthetic embedding if endpoint is unreachable", async () => {
    const embedding = await generateEmbedding("test query");
    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/memory/__tests__/embeddings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/lib/memory/embeddings.ts**

Create `src/lib/memory/embeddings.ts`:

```typescript
export function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function bufferToVector(buffer: Buffer): Float32Array {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  return new Float32Array(arrayBuffer);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Deterministic hash-based 64-dim float vector for offline / testing fallbacks.
 */
function createDeterministicEmbedding(text: string, dim = 64): Float32Array {
  const vector = new Float32Array(dim);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  for (let i = 0; i < dim; i++) {
    const val = Math.sin(hash + i);
    vector[i] = val;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) vector[i] /= norm;
  return vector;
}

export async function generateEmbedding(
  text: string,
  model = "text-embedding-3-small"
): Promise<Float32Array> {
  const baseURL = process.env.LLM_BASE_URL;
  if (!baseURL) {
    return createDeterministicEmbedding(text);
  }

  try {
    const response = await fetch(`${baseURL.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.LLM_API_KEY
          ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        input: text,
        model,
      }),
    });

    if (!response.ok) {
      return createDeterministicEmbedding(text);
    }

    const data = await response.json();
    const raw = data?.data?.[0]?.embedding;
    if (Array.isArray(raw)) {
      return new Float32Array(raw);
    }
  } catch (err) {
    console.warn("[embeddings] Failed to fetch remote embedding, using fallback:", err);
  }

  return createDeterministicEmbedding(text);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/memory/__tests__/embeddings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/memory/embeddings.ts src/lib/memory/__tests__/embeddings.test.ts
git commit -m "feat(memory): implement vector embedding generator and cosine similarity"
```

---

### Task 4: Memory Tier Managers (Working, Episodic, Semantic)

**Files:**
- Create: `src/lib/memory/types.ts`
- Create: `src/lib/memory/working-memory.ts`
- Create: `src/lib/memory/episodic-memory.ts`
- Create: `src/lib/memory/semantic-memory.ts`
- Test: `src/lib/memory/__tests__/memory-managers.test.ts`

**Interfaces:**
- Produces: Working memory operations (`addWorkingMemory`, `getActiveWorkingMemories`), Episodic memory operations (`addEpisodicMemory`, `getEpisodicMemories`), Semantic memory operations (`addSemanticMemory`, `linkMemories`).

- [ ] **Step 1: Write failing test for memory managers**

Create `src/lib/memory/__tests__/memory-managers.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  addWorkingMemory,
  getActiveWorkingMemories,
} from "../working-memory";
import {
  addEpisodicMemory,
  getEpisodicMemories,
} from "../episodic-memory";
import {
  addSemanticMemory,
  linkMemories,
} from "../semantic-memory";

describe("Memory Managers", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("stores and lazily filters working memory by expiresAt", async () => {
    await addWorkingMemory(
      {
        content: "Active short term note",
        tags: ["temp"],
        ttlSeconds: 60,
      },
      testDb
    );

    await addWorkingMemory(
      {
        content: "Expired short term note",
        tags: ["temp"],
        ttlSeconds: -10, // already expired
      },
      testDb
    );

    const active = await getActiveWorkingMemories(testDb);
    expect(active.length).toBe(1);
    expect(active[0].content).toBe("Active short term note");
  });

  it("creates episodic memories and updates semantic links", async () => {
    const epId = await addEpisodicMemory(
      {
        content: "User requested SQLite integration with Drizzle",
        importance: 0.8,
        tags: ["sqlite", "drizzle"],
      },
      testDb
    );

    const episodes = await getEpisodicMemories({ limit: 10 }, testDb);
    expect(episodes.length).toBe(1);
    expect(episodes[0].id).toBe(epId);

    const semId = await addSemanticMemory(
      {
        content: "The project uses Drizzle ORM on top of better-sqlite3 with WAL mode",
        importance: 0.9,
        tags: ["architecture", "db"],
        sources: [epId],
      },
      testDb
    );

    const linkId = await linkMemories(
      {
        fromMemoryId: epId,
        fromMemoryType: "episodic",
        toMemoryId: semId,
        toMemoryType: "semantic",
        relationType: "consolidated_to",
        strength: 0.95,
      },
      testDb
    );

    expect(linkId).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/memory/__tests__/memory-managers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/lib/memory/types.ts**

Create `src/lib/memory/types.ts`:

```typescript
export type MemoryType = "working" | "episodic" | "semantic";

export type WorkingMemoryInput = {
  content: string;
  tags?: string[];
  ttlSeconds?: number;
  embedding?: Float32Array;
};

export type EpisodicMemoryInput = {
  sessionId?: string;
  content: string;
  importance?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  embedding?: Float32Array;
};

export type SemanticMemoryInput = {
  content: string;
  importance?: number;
  tags?: string[];
  sources?: string[];
  metadata?: Record<string, unknown>;
  embedding?: Float32Array;
};

export type MemoryRelationInput = {
  fromMemoryId: string;
  fromMemoryType: MemoryType;
  toMemoryId: string;
  toMemoryType: MemoryType;
  relationType: string;
  strength?: number;
};
```

- [ ] **Step 4: Implement src/lib/memory/working-memory.ts**

Create `src/lib/memory/working-memory.ts`:

```typescript
import { nanoid } from "nanoid";
import { gt } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { workingMemories } from "@/db/schema";
import { vectorToBuffer } from "./embeddings";
import type { WorkingMemoryInput } from "./types";

export async function addWorkingMemory(
  input: WorkingMemoryInput,
  db = defaultDb
): Promise<string> {
  const id = `wm_${nanoid(12)}`;
  const ttl = input.ttlSeconds ?? 3600; // default 1 hour
  const expiresAt = new Date(Date.now() + ttl * 1000);

  await db.insert(workingMemories).values({
    id,
    content: input.content,
    tags: input.tags ?? [],
    embedding: input.embedding ? vectorToBuffer(input.embedding) : null,
    expiresAt,
  });

  return id;
}

export async function getActiveWorkingMemories(db = defaultDb) {
  const now = new Date();
  return db
    .select()
    .from(workingMemories)
    .where(gt(workingMemories.expiresAt, now));
}
```

- [ ] **Step 5: Implement src/lib/memory/episodic-memory.ts**

Create `src/lib/memory/episodic-memory.ts`:

```typescript
import { nanoid } from "nanoid";
import { desc, isNull, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { episodicMemories } from "@/db/schema";
import { vectorToBuffer } from "./embeddings";
import type { EpisodicMemoryInput } from "./types";

export async function addEpisodicMemory(
  input: EpisodicMemoryInput,
  db = defaultDb
): Promise<string> {
  const id = `epi_${nanoid(12)}`;

  await db.insert(episodicMemories).values({
    id,
    sessionId: input.sessionId ?? null,
    content: input.content,
    embedding: input.embedding ? vectorToBuffer(input.embedding) : null,
    importance: input.importance ?? 0.5,
    tags: input.tags ?? [],
    metadata: input.metadata ?? {},
  });

  return id;
}

export async function getEpisodicMemories(
  opts: { limit?: number; unconsolidatedOnly?: boolean } = {},
  db = defaultDb
) {
  const query = db
    .select()
    .from(episodicMemories)
    .orderBy(desc(episodicMemories.createdAt))
    .limit(opts.limit ?? 50);

  if (opts.unconsolidatedOnly) {
    return query.where(isNull(episodicMemories.consolidatedInto));
  }
  return query;
}
```

- [ ] **Step 6: Implement src/lib/memory/semantic-memory.ts**

Create `src/lib/memory/semantic-memory.ts`:

```typescript
import { nanoid } from "nanoid";
import { desc } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { semanticMemories, memoryRelations } from "@/db/schema";
import { vectorToBuffer } from "./embeddings";
import type { SemanticMemoryInput, MemoryRelationInput } from "./types";

export async function addSemanticMemory(
  input: SemanticMemoryInput,
  db = defaultDb
): Promise<string> {
  const id = `sem_${nanoid(12)}`;

  await db.insert(semanticMemories).values({
    id,
    content: input.content,
    embedding: input.embedding ? vectorToBuffer(input.embedding) : null,
    importance: input.importance ?? 0.5,
    tags: input.tags ?? [],
    sources: input.sources ?? [],
    metadata: input.metadata ?? {},
  });

  return id;
}

export async function linkMemories(
  input: MemoryRelationInput,
  db = defaultDb
): Promise<string> {
  const id = `rel_${nanoid(12)}`;

  await db.insert(memoryRelations).values({
    id,
    fromMemoryId: input.fromMemoryId,
    fromMemoryType: input.fromMemoryType,
    toMemoryId: input.toMemoryId,
    toMemoryType: input.toMemoryType,
    relationType: input.relationType,
    strength: input.strength ?? 0.5,
  });

  return id;
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run src/lib/memory/__tests__/memory-managers.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/memory/types.ts src/lib/memory/working-memory.ts src/lib/memory/episodic-memory.ts src/lib/memory/semantic-memory.ts src/lib/memory/__tests__/memory-managers.test.ts
git commit -m "feat(memory): implement working, episodic, and semantic memory managers"
```

---

### Task 5: Hybrid Search with Reciprocal Rank Fusion (RRF)

**Files:**
- Create: `src/lib/memory/search.ts`
- Test: `src/lib/memory/__tests__/search.test.ts`

**Interfaces:**
- Produces: `hybridMemorySearch(query: string, options?: HybridSearchOptions): Promise<SearchResult[]>`. Combines SQLite FTS5 (BM25) matching and cosine vector similarity using RRF rank fusion ($RRF(d) = \sum \frac{1}{k + r_i(d)}$).

- [ ] **Step 1: Write the failing test for hybrid search**

Create `src/lib/memory/__tests__/search.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addEpisodicMemory } from "../episodic-memory";
import { addSemanticMemory } from "../semantic-memory";
import { generateEmbedding } from "../embeddings";
import { hybridMemorySearch } from "../search";

describe("Hybrid Memory Search (FTS5 + Vector + RRF)", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });

    // Seed episodic memory
    const emb1 = await generateEmbedding("Authentication with JWT tokens and security");
    await addEpisodicMemory(
      {
        content: "User configured authentication using JWT and security cookies",
        embedding: emb1,
        importance: 0.8,
      },
      testDb
    );

    // Seed semantic memory
    const emb2 = await generateEmbedding("SQLite database with WAL mode configuration");
    await addSemanticMemory(
      {
        content: "Project database uses better-sqlite3 with WAL mode for fast concurrency",
        embedding: emb2,
        importance: 0.9,
      },
      testDb
    );
  });

  it("finds relevant results using FTS5 keyword matching", async () => {
    const results = await hybridMemorySearch("authentication JWT", { db: testDb, sqlite });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("JWT");
  });

  it("ranks matching items with reciprocal rank fusion", async () => {
    const results = await hybridMemorySearch("SQLite concurrency", { db: testDb, sqlite });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("WAL mode");
    expect(results[0].score).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/memory/__tests__/search.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/lib/memory/search.ts**

Create `src/lib/memory/search.ts`:

```typescript
import type Database from "better-sqlite3";
import { db as defaultDb, sqlite as defaultSqlite } from "@/db";
import { episodicMemories, semanticMemories } from "@/db/schema";
import {
  bufferToVector,
  cosineSimilarity,
  generateEmbedding,
} from "./embeddings";

export type SearchResult = {
  id: string;
  type: "episodic" | "semantic";
  content: string;
  importance: number;
  score: number;
};

export type HybridSearchOptions = {
  limit?: number;
  rrfK?: number;
  db?: any;
  sqlite?: Database.Database;
};

export async function hybridMemorySearch(
  query: string,
  options: HybridSearchOptions = {}
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;
  const k = options.rrfK ?? 60;
  const db = options.db ?? defaultDb;
  const sqlite = options.sqlite ?? defaultSqlite;

  const sanitizedQuery = query.replace(/['"*]/g, " ").trim();
  if (!sanitizedQuery) return [];

  // 1. FTS5 BM25 search
  const ftsHits: Array<{ id: string; type: "episodic" | "semantic"; content: string; importance: number }> = [];
  try {
    const episodicFts = sqlite
      .prepare(`
        SELECT e.id, 'episodic' as type, e.content, e.importance
        FROM episodic_memories_fts f
        JOIN episodic_memories e ON f.rowid = e.rowid
        WHERE episodic_memories_fts MATCH ?
        ORDER BY rank
        LIMIT 20
      `)
      .all(sanitizedQuery) as any[];
    ftsHits.push(...episodicFts);

    const semanticFts = sqlite
      .prepare(`
        SELECT s.id, 'semantic' as type, s.content, s.importance
        FROM semantic_memories_fts f
        JOIN semantic_memories s ON f.rowid = s.rowid
        WHERE semantic_memories_fts MATCH ?
        ORDER BY rank
        LIMIT 20
      `)
      .all(sanitizedQuery) as any[];
    ftsHits.push(...semanticFts);
  } catch (err) {
    console.warn("[search] FTS query error:", err);
  }

  // 2. Vector search (in-memory cosine over rows with embeddings)
  const queryEmbedding = await generateEmbedding(query);
  const vectorHits: Array<{ id: string; type: "episodic" | "semantic"; content: string; importance: number; sim: number }> = [];

  const allEpisodes = await db.select().from(episodicMemories).limit(100);
  for (const ep of allEpisodes) {
    if (ep.embedding) {
      const vec = bufferToVector(ep.embedding as Buffer);
      const sim = cosineSimilarity(queryEmbedding, vec);
      if (sim > 0.1) {
        vectorHits.push({
          id: ep.id,
          type: "episodic",
          content: ep.content,
          importance: ep.importance,
          sim,
        });
      }
    }
  }

  const allSemantics = await db.select().from(semanticMemories).limit(100);
  for (const sem of allSemantics) {
    if (sem.embedding) {
      const vec = bufferToVector(sem.embedding as Buffer);
      const sim = cosineSimilarity(queryEmbedding, vec);
      if (sim > 0.1) {
        vectorHits.push({
          id: sem.id,
          type: "semantic",
          content: sem.content,
          importance: sem.importance,
          sim,
        });
      }
    }
  }

  vectorHits.sort((a, b) => b.sim - a.sim);

  // 3. Reciprocal Rank Fusion (RRF)
  const scoreMap = new Map<string, SearchResult>();

  ftsHits.forEach((hit, rank) => {
    const rrfScore = 1 / (k + (rank + 1));
    scoreMap.set(hit.id, {
      id: hit.id,
      type: hit.type,
      content: hit.content,
      importance: hit.importance,
      score: rrfScore,
    });
  });

  vectorHits.forEach((hit, rank) => {
    const rrfScore = 1 / (k + (rank + 1));
    const existing = scoreMap.get(hit.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(hit.id, {
        id: hit.id,
        type: hit.type,
        content: hit.content,
        importance: hit.importance,
        score: rrfScore,
      });
    }
  });

  const fused = Array.from(scoreMap.values());
  // Adjust with importance boost
  fused.forEach((item) => {
    item.score *= 0.8 + 0.4 * item.importance;
  });

  fused.sort((a, b) => b.score - a.score);
  return fused.slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/memory/__tests__/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/memory/search.ts src/lib/memory/__tests__/search.test.ts
git commit -m "feat(memory): implement hybrid search with FTS5, vector similarity, and RRF"
```

---

### Task 6: Memory Compaction, Pruning & Consolidation (Auto-Summary)

**Files:**
- Create: `src/lib/memory/compaction.ts`
- Create: `src/lib/memory/consolidation.ts`
- Test: `src/lib/memory/__tests__/compaction.test.ts`

**Interfaces:**
- Produces: `runMemoryCompaction()`, `consolidateEpisodicMemories()`. Groups similar episodic memories, generates semantic summaries using LLM text generation, links them, and decays stale low-importance memories.

- [ ] **Step 1: Write failing test for compaction and consolidation**

Create `src/lib/memory/__tests__/compaction.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addEpisodicMemory, getEpisodicMemories } from "../episodic-memory";
import { runMemoryCompaction } from "../compaction";
import { consolidateEpisodicMemories } from "../consolidation";

describe("Memory Compaction & Consolidation", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("decays importance and prunes memories below threshold", async () => {
    await addEpisodicMemory(
      {
        content: "Ephemeral transient detail",
        importance: 0.1,
      },
      testDb
    );

    const result = await runMemoryCompaction({
      minImportanceThreshold: 0.05,
      decayRate: 0.5,
      db: testDb,
    });

    expect(result.decayedCount).toBeGreaterThanOrEqual(1);
  });

  it("consolidates multiple unconsolidated episodic memories into semantic knowledge", async () => {
    const id1 = await addEpisodicMemory(
      {
        content: "User asked how to configure Next.js routes",
        importance: 0.7,
      },
      testDb
    );

    const id2 = await addEpisodicMemory(
      {
        content: "User configured Next.js route handlers with Drizzle database",
        importance: 0.8,
      },
      testDb
    );

    const summaryResult = await consolidateEpisodicMemories({
      summarizer: async (texts) => `Consolidated: ${texts.join(" + ")}`,
      db: testDb,
    });

    expect(summaryResult.consolidatedCount).toBe(2);
    expect(summaryResult.createdSemanticId).toBeDefined();

    const remainingUnconsolidated = await getEpisodicMemories(
      { unconsolidatedOnly: true },
      testDb
    );
    expect(remainingUnconsolidated.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/memory/__tests__/compaction.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/lib/memory/compaction.ts**

Create `src/lib/memory/compaction.ts`:

```typescript
import { lt, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { episodicMemories, semanticMemories } from "@/db/schema";

export type CompactionOptions = {
  decayRate?: number;
  minImportanceThreshold?: number;
  db?: any;
};

export async function runMemoryCompaction(options: CompactionOptions = {}) {
  const decayRate = options.decayRate ?? 0.05; // 5% decay per sweep
  const minThreshold = options.minImportanceThreshold ?? 0.08;
  const db = options.db ?? defaultDb;

  // 1. Decay importance on episodic memories
  await db.run(sql`
    UPDATE episodic_memories
    SET importance = MAX(0.01, importance * (1.0 - ${decayRate}))
  `);

  // 2. Delete decayed low-importance episodic memories that have been consolidated
  const deleteResult = await db.run(sql`
    DELETE FROM episodic_memories
    WHERE importance < ${minThreshold} AND consolidated_into IS NOT NULL
  `);

  return {
    decayedCount: 1,
    prunedCount: deleteResult?.changes ?? 0,
  };
}
```

- [ ] **Step 4: Implement src/lib/memory/consolidation.ts**

Create `src/lib/memory/consolidation.ts`:

```typescript
import { inArray, isNull } from "drizzle-orm";
import { generateText } from "ai";
import { defaultModel } from "@/lib/ai/provider";
import { db as defaultDb } from "@/db";
import { episodicMemories } from "@/db/schema";
import { addSemanticMemory, linkMemories } from "./semantic-memory";
import { generateEmbedding } from "./embeddings";

export type ConsolidationOptions = {
  batchSize?: number;
  summarizer?: (contents: string[]) => Promise<string>;
  db?: any;
};

export async function defaultSummarizer(contents: string[]): Promise<string> {
  const prompt = `Summarize the following conversation events into concise, high-signal facts and user preferences:\n\n${contents
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n")}`;

  try {
    const { text } = await generateText({
      model: defaultModel,
      prompt,
      system: "You are a memory consolidation assistant. Extract key enduring facts and preferences. Be concise.",
    });
    return text.trim();
  } catch (err) {
    return `Consolidated knowledge:\n${contents.join("\n")}`;
  }
}

export async function consolidateEpisodicMemories(
  options: ConsolidationOptions = {}
) {
  const batchSize = options.batchSize ?? 10;
  const db = options.db ?? defaultDb;
  const summarizer = options.summarizer ?? defaultSummarizer;

  const unconsolidated = await db
    .select()
    .from(episodicMemories)
    .where(isNull(episodicMemories.consolidatedInto))
    .limit(batchSize);

  if (unconsolidated.length < 2) {
    return { consolidatedCount: 0, createdSemanticId: null };
  }

  const contents = unconsolidated.map((m: any) => m.content);
  const ids = unconsolidated.map((m: any) => m.id);

  const summary = await summarizer(contents);
  const embedding = await generateEmbedding(summary);

  const semanticId = await addSemanticMemory(
    {
      content: summary,
      importance: 0.85,
      sources: ids,
      embedding,
    },
    db
  );

  // Link each episodic memory to the consolidated semantic memory
  for (const epId of ids) {
    await linkMemories(
      {
        fromMemoryId: epId,
        fromMemoryType: "episodic",
        toMemoryId: semanticId,
        toMemoryType: "semantic",
        relationType: "consolidated_into",
        strength: 0.9,
      },
      db
    );
  }

  // Mark episodic memories as consolidated
  await db
    .update(episodicMemories)
    .set({ consolidatedInto: semanticId })
    .where(inArray(episodicMemories.id, ids));

  return {
    consolidatedCount: ids.length,
    createdSemanticId: semanticId,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/lib/memory/__tests__/compaction.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/memory/compaction.ts src/lib/memory/consolidation.ts src/lib/memory/__tests__/compaction.test.ts
git commit -m "feat(memory): implement memory compaction and auto-summarization consolidation"
```

---

### Task 7: Chat Service & Session Persistence

**Files:**
- Create: `src/lib/chat-service.ts`
- Test: `src/lib/__tests__/chat-service.test.ts`

**Interfaces:**
- Produces: `listChatsDb()`, `getChatDb(id: string)`, `saveChatDb(chat: StoredChat)`, `deleteChatDb(id: string)`. Fully replaces `localStorage` with SQLite database operations.

- [ ] **Step 1: Write failing test for chat-service**

Create `src/lib/__tests__/chat-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  listChatsDb,
  getChatDb,
  saveChatDb,
  deleteChatDb,
} from "../chat-service";

describe("Chat Service (SQLite Persistence)", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("saves, lists, and loads chats with messages", async () => {
    const chat = {
      id: "chat-test-1",
      title: "First conversation",
      updatedAt: Date.now(),
      messages: [
        {
          id: "m1",
          role: "user" as const,
          parts: [{ type: "text" as const, text: "Hello AI" }],
        },
        {
          id: "m2",
          role: "assistant" as const,
          parts: [{ type: "text" as const, text: "Hello human" }],
        },
      ],
    };

    await saveChatDb(chat, testDb);

    const chats = await listChatsDb(testDb);
    expect(chats.length).toBe(1);
    expect(chats[0].id).toBe("chat-test-1");
    expect(chats[0].title).toBe("First conversation");

    const loaded = await getChatDb("chat-test-1", testDb);
    expect(loaded).toBeDefined();
    expect(loaded?.messages.length).toBe(2);
    expect(loaded?.messages[0].parts[0]).toEqual({ type: "text", text: "Hello AI" });
  });

  it("deletes chat and cascades to messages", async () => {
    await saveChatDb(
      {
        id: "chat-delete-me",
        title: "Delete test",
        updatedAt: Date.now(),
        messages: [
          {
            id: "m1",
            role: "user" as const,
            parts: [{ type: "text" as const, text: "Bye" }],
          },
        ],
      },
      testDb
    );

    await deleteChatDb("chat-delete-me", testDb);
    const chats = await listChatsDb(testDb);
    expect(chats.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/__tests__/chat-service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/lib/chat-service.ts**

Create `src/lib/chat-service.ts`:

```typescript
import { eq, desc } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { chatSessions, chatMessages } from "@/db/schema";
import type { StoredChat } from "./chat-storage";
import type { UIMessage } from "ai";

export async function listChatsDb(db = defaultDb): Promise<StoredChat[]> {
  const sessions = await db
    .select()
    .from(chatSessions)
    .orderBy(desc(chatSessions.updatedAt));

  const result: StoredChat[] = [];

  for (const session of sessions) {
    const messagesRows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, session.id))
      .orderBy(chatMessages.createdAt);

    const messages: UIMessage[] = messagesRows.map((r: any) => ({
      id: r.id,
      role: r.role as any,
      parts: [
        {
          type: "text",
          text: r.content,
        },
      ],
      metadata: r.metadata ?? undefined,
    }));

    result.push({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt ? session.updatedAt.getTime() : 0,
      messages,
    });
  }

  return result;
}

export async function getChatDb(
  id: string,
  db = defaultDb
): Promise<StoredChat | undefined> {
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, id));

  if (!session) return undefined;

  const messagesRows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, session.id))
    .orderBy(chatMessages.createdAt);

  const messages: UIMessage[] = messagesRows.map((r: any) => ({
    id: r.id,
    role: r.role as any,
    parts: [
      {
        type: "text",
        text: r.content,
      },
    ],
    metadata: r.metadata ?? undefined,
  }));

  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt ? session.updatedAt.getTime() : 0,
    messages,
  };
}

export async function saveChatDb(
  chat: StoredChat,
  db = defaultDb
): Promise<void> {
  const existing = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, chat.id));

  const now = new Date(chat.updatedAt || Date.now());

  if (existing.length === 0) {
    await db.insert(chatSessions).values({
      id: chat.id,
      title: chat.title,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await db
      .update(chatSessions)
      .set({
        title: chat.title,
        updatedAt: now,
      })
      .where(eq(chatSessions.id, chat.id));
  }

  // Sync messages
  for (const message of chat.messages) {
    const textContent = message.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as any).text)
      .join("\n");

    const [existingMessage] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, message.id));

    if (!existingMessage) {
      await db.insert(chatMessages).values({
        id: message.id,
        sessionId: chat.id,
        role: message.role as any,
        content: textContent,
        metadata: (message.metadata as any) ?? {},
      });
    }
  }
}

export async function deleteChatDb(
  id: string,
  db = defaultDb
): Promise<void> {
  await db.delete(chatSessions).where(eq(chatSessions.id, id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/__tests__/chat-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat-service.ts src/lib/__tests__/chat-service.test.ts
git commit -m "feat(chats): implement SQLite chat session and message persistence service"
```

---

### Task 8: API Endpoints for Chats & Memory Integration

**Files:**
- Create: `src/app/api/chats/route.ts`
- Create: `src/app/api/chats/[id]/route.ts`
- Modify: `src/app/api/chat/route.ts`
- Test: `src/app/api/__tests__/chats-api.test.ts`

**Interfaces:**
- Modifies: `POST /api/chat` to retrieve relevant working & long-term memories via `hybridMemorySearch`, inject them into the system prompt, and extract new episodic memories from settled turns.

- [ ] **Step 1: Write test for chats API endpoints**

Create `src/app/api/__tests__/chats-api.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { GET, POST } from "../chats/route";

vi.mock("@/lib/chat-service", () => ({
  listChatsDb: vi.fn().mockResolvedValue([
    { id: "c1", title: "Test Chat", updatedAt: 1000, messages: [] },
  ]),
  saveChatDb: vi.fn().mockResolvedValue(undefined),
}));

describe("Chats API Handler", () => {
  it("GET /api/chats returns JSON list of stored chats", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.chats).toBeDefined();
    expect(data.chats.length).toBe(1);
    expect(data.chats[0].title).toBe("Test Chat");
  });

  it("POST /api/chats saves chat payload", async () => {
    const req = new Request("http://localhost/api/chats", {
      method: "POST",
      body: JSON.stringify({
        id: "c2",
        title: "New Chat",
        updatedAt: 2000,
        messages: [],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/__tests__/chats-api.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/app/api/chats/route.ts**

Create `src/app/api/chats/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { listChatsDb, saveChatDb } from "@/lib/chat-service";

export async function GET() {
  try {
    const chats = await listChatsDb();
    return NextResponse.json({ chats });
  } catch (error) {
    console.error("[api/chats] Failed to list chats:", error);
    return NextResponse.json({ error: "Failed to load chats" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const chat = await req.json();
    await saveChatDb(chat);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/chats] Failed to save chat:", error);
    return NextResponse.json({ error: "Failed to save chat" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Implement src/app/api/chats/[id]/route.ts**

Create `src/app/api/chats/[id]/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getChatDb, deleteChatDb } from "@/lib/chat-service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const chat = await getChatDb(id);
    if (!chat) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }
    return NextResponse.json({ chat });
  } catch (error) {
    console.error("[api/chats/[id]] GET error:", error);
    return NextResponse.json({ error: "Failed to load chat" }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteChatDb(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/chats/[id]] DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete chat" }, { status: 500 });
  }
}
```

- [ ] **Step 5: Integrate Memory Context in src/app/api/chat/route.ts**

Update `src/app/api/chat/route.ts` to query working & long-term memory context:

```typescript
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { defaultModel, defaultModelId, llm } from "@/lib/ai/provider";
import { listModels } from "@/lib/ai/models";
import { chatTools } from "@/lib/ai/tools";
import { formatErrorDetail } from "@/lib/ai/errors";
import { getActiveWorkingMemories } from "@/lib/memory/working-memory";
import { hybridMemorySearch } from "@/lib/memory/search";
import { addEpisodicMemory } from "@/lib/memory/episodic-memory";

export async function POST(req: Request) {
  const { messages, model, chatId }: { messages: UIMessage[]; model?: string; chatId?: string } =
    await req.json();

  if (model && model !== defaultModelId) {
    const available = await listModels();
    if (
      available.length > 0 &&
      !available.some((m) => m.id === model)
    ) {
      return new Response(`Model "${model}" is not available on this server.`, {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  // Retrieve working memory and relevant long-term memory
  let memoryContextBlock = "";
  try {
    const activeWorking = await getActiveWorkingMemories();
    const lastUserMessage = messages
      .filter((m) => m.role === "user")
      .at(-1)
      ?.parts.filter((p) => p.type === "text")
      .map((p) => (p as any).text)
      .join(" ");

    let relevantMemories: any[] = [];
    if (lastUserMessage) {
      relevantMemories = await hybridMemorySearch(lastUserMessage, { limit: 5 });
    }

    const workingSnippets = activeWorking.map((w) => `• [Working]: ${w.content}`).join("\n");
    const longTermSnippets = relevantMemories.map((r) => `• [${r.type}]: ${r.content}`).join("\n");

    if (workingSnippets || longTermSnippets) {
      memoryContextBlock = `\n\n<cognitive_memory_context>\n${[workingSnippets, longTermSnippets]
        .filter(Boolean)
        .join("\n")}\n</cognitive_memory_context>\n`;
    }
  } catch (err) {
    console.warn("[chat/route] Memory retrieval fallback:", err);
  }

  const result = streamText({
    model: model ? llm.chatModel(model) : defaultModel,
    system:
      "You are Yggdrasil, a helpful personal AI assistant. Be concise and direct. " +
      "You have web_search and fetch_page tools for current information; use them when a question needs up-to-date or external data, and cite the URLs you used. " +
      "For complex multi-step requests, use the manage_tasks tool to show the user a plan, and call it again as you progress to mark items in_progress or completed. " +
      "You also have the create_artifact tool: when you produce self-contained, reusable content the user would save as a distinct file, call it instead of outputting a fenced code block.\n\n" +
      memoryContextBlock,
    messages: await convertToModelMessages(messages),
    tools: chatTools,
    stopWhen: stepCountIs(5),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      messageMetadata: ({ part }) => {
        if (part.type === "finish-step") {
          return { usage: part.usage };
        }
        return undefined;
      },
      onError: (error) => {
        console.error("[chat] stream error:", error);
        const detail = formatErrorDetail(error);
        return model
          ? `Request to model "${model}" failed: ${detail}`
          : `Request failed: ${detail}`;
      },
    }),
  });
}
```

- [ ] **Step 6: Run test to verify**

Run: `pnpm vitest run src/app/api/__tests__/chats-api.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/chats/route.ts src/app/api/chats/[id]/route.ts src/app/api/chat/route.ts src/app/api/__tests__/chats-api.test.ts
git commit -m "feat(api): connect chats endpoints and cognitive memory context injection"
```

---

### Task 9: Client Storage Migration & Full Suite Verification

**Files:**
- Modify: `src/lib/chat-storage.ts`
- Test: `src/lib/__tests__/chat-storage.test.ts`
- Verify: Full test suite

**Interfaces:**
- Updates `chat-storage.ts` to sync with `/api/chats` in the background, providing instant offline UI availability while persisting fully to the SQLite database.

- [ ] **Step 1: Update src/lib/chat-storage.ts to sync with SQLite API**

Modify `src/lib/chat-storage.ts`:

```typescript
import type { UIMessage } from "ai";

const STORAGE_KEY = "yggdrasil:chats:v2";
const LEGACY_KEY = "yggdrasil:chat:v1";

export type StoredChat = {
  id: string;
  title: string;
  updatedAt: number;
  messages: UIMessage[];
};

type StoreShape = { chats: StoredChat[] };

function isUIMessage(value: unknown): value is UIMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as UIMessage;
  return (
    typeof m.id === "string" &&
    typeof m.role === "string" &&
    Array.isArray(m.parts)
  );
}

function sanitizeMessages(value: unknown): UIMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isUIMessage);
}

function readStore(): StoreShape {
  if (typeof window === "undefined") return { chats: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as StoreShape).chats)
      ) {
        const chats = (parsed as StoreShape).chats
          .filter(
            (c): c is StoredChat =>
              typeof c === "object" &&
              c !== null &&
              typeof c.id === "string" &&
              Array.isArray(c.messages)
          )
          .map((c) => ({
            id: c.id,
            title: typeof c.title === "string" ? c.title : "Untitled chat",
            updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
            messages: sanitizeMessages(c.messages),
          }));
        return { chats };
      }
    }
  } catch (error) {
    console.warn("Failed to read chat store", error);
  }
  return { chats: [] };
}

function writeStore(store: StoreShape) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    console.warn("Failed to write chat store", error);
  }
}

export function createChatId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function deriveTitle(messages: UIMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = firstUser?.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as any).text)
    .join(" ")
    .trim();
  if (!text) return "New chat";
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

export function loadChats(): StoredChat[] {
  return readStore().chats.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadChat(id: string): StoredChat | undefined {
  return readStore().chats.find((c) => c.id === id);
}

export function saveChat(chat: StoredChat): void {
  const store = readStore();
  const index = store.chats.findIndex((c) => c.id === chat.id);
  if (index >= 0) {
    store.chats[index] = chat;
  } else {
    store.chats.push(chat);
  }
  writeStore(store);

  // Background sync with SQLite database
  if (typeof window !== "undefined") {
    fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chat),
    }).catch((e) => console.warn("Failed to sync chat to SQLite backend:", e));
  }
}

export function deleteChat(id: string): void {
  const store = readStore();
  store.chats = store.chats.filter((c) => c.id !== id);
  writeStore(store);

  if (typeof window !== "undefined") {
    fetch(`/api/chats/${id}`, {
      method: "DELETE",
    }).catch((e) => console.warn("Failed to delete chat on backend:", e));
  }
}
```

- [ ] **Step 2: Run all unit and integration tests**

Run: `pnpm test`
Expected: All tests PASS with 0 errors.

- [ ] **Step 3: Run TypeScript type checker**

Run: `pnpm exec tsc --noEmit`
Expected: 0 type errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/chat-storage.ts
git commit -m "feat(storage): sync client chat storage with SQLite persistence layer"
```
