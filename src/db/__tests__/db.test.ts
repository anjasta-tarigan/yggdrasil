import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
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
    expect(tableNames).toContain("semantic_memories_fts");
  });

  it("synchronizes episodic and semantic memories with FTS5 via triggers", () => {
    setupFtsAndTriggers(sqlite);

    // 1. Insert episodic memory and verify FTS sync
    sqlite
      .prepare(
        "INSERT INTO episodic_memories (id, content, importance) VALUES (?, ?, ?)"
      )
      .run("epi-1", "Authentication using JWT tokens and cookies", 0.8);

    const match = sqlite
      .prepare(
        "SELECT rowid, content FROM episodic_memories_fts WHERE episodic_memories_fts MATCH ?"
      )
      .all("JWT");
    expect(match.length).toBe(1);
    expect((match[0] as { content: string }).content).toContain("Authentication using JWT");

    // 2. Update episodic memory and verify FTS update
    sqlite
      .prepare("UPDATE episodic_memories SET content = ? WHERE id = ?")
      .run("OAuth2 authentication using PKCE flow", "epi-1");

    const matchOld = sqlite
      .prepare(
        "SELECT rowid, content FROM episodic_memories_fts WHERE episodic_memories_fts MATCH ?"
      )
      .all("JWT");
    expect(matchOld.length).toBe(0);

    const matchNew = sqlite
      .prepare(
        "SELECT rowid, content FROM episodic_memories_fts WHERE episodic_memories_fts MATCH ?"
      )
      .all("OAuth2");
    expect(matchNew.length).toBe(1);

    // 3. Delete episodic memory and verify FTS delete
    sqlite
      .prepare("DELETE FROM episodic_memories WHERE id = ?")
      .run("epi-1");

    const matchDeleted = sqlite
      .prepare(
        "SELECT rowid, content FROM episodic_memories_fts WHERE episodic_memories_fts MATCH ?"
      )
      .all("OAuth2");
    expect(matchDeleted.length).toBe(0);

    // 4. Semantic memories FTS trigger verification
    sqlite
      .prepare(
        "INSERT INTO semantic_memories (id, content, importance) VALUES (?, ?, ?)"
      )
      .run("sem-1", "Drizzle ORM is used with better-sqlite3", 0.9);

    const semMatch = sqlite
      .prepare(
        "SELECT rowid, content FROM semantic_memories_fts WHERE semantic_memories_fts MATCH ?"
      )
      .all("Drizzle");
    expect(semMatch.length).toBe(1);
  });

  it("enforces foreign key cascading deletion on chat sessions and messages", () => {
    setupFtsAndTriggers(sqlite);

    // Insert session
    sqlite
      .prepare("INSERT INTO chat_sessions (id, title) VALUES (?, ?)")
      .run("sess-1", "Test Session");

    // Insert message
    sqlite
      .prepare(
        "INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)"
      )
      .run("msg-1", "sess-1", "user", "Hello world");

    const msgsBefore = sqlite
      .prepare("SELECT * FROM chat_messages WHERE session_id = ?")
      .all("sess-1");
    expect(msgsBefore.length).toBe(1);

    // Delete session
    sqlite.prepare("DELETE FROM chat_sessions WHERE id = ?").run("sess-1");

    const msgsAfter = sqlite
      .prepare("SELECT * FROM chat_messages WHERE session_id = ?")
      .all("sess-1");
    expect(msgsAfter.length).toBe(0);
  });

  it("supports Drizzle ORM operations on all tables", async () => {
    setupFtsAndTriggers(sqlite);
    const db = drizzle(sqlite, { schema });

    const expiresAt = new Date(Date.now() + 3600 * 1000);

    // Working memory
    await db.insert(schema.workingMemories).values({
      id: "wm-1",
      content: "Short term context",
      expiresAt,
      tags: ["active"],
    });

    const [wm] = await db
      .select()
      .from(schema.workingMemories)
      .where(eq(schema.workingMemories.id, "wm-1"));
    expect(wm).toBeDefined();
    expect(wm.content).toBe("Short term context");
    expect(wm.tags).toEqual(["active"]);

    // Memory relations
    await db.insert(schema.memoryRelations).values({
      id: "rel-1",
      fromMemoryId: "wm-1",
      fromMemoryType: "working",
      toMemoryId: "sem-1",
      toMemoryType: "semantic",
      relationType: "derived_from",
      strength: 0.85,
    });

    const [rel] = await db
      .select()
      .from(schema.memoryRelations)
      .where(eq(schema.memoryRelations.id, "rel-1"));
    expect(rel).toBeDefined();
    expect(rel.relationType).toBe("derived_from");
    expect(rel.strength).toBeCloseTo(0.85);
  });
});
