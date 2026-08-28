import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { getDatabaseStats } from "../database-service";

describe("Database Service (live stats)", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("reports zeros for an empty database", () => {
    const stats = getDatabaseStats(testDb);
    expect(stats.engine).toBe("SQLite");
    expect(stats.chatCount).toBe(0);
    expect(stats.messageCount).toBe(0);
    expect(stats.memories).toEqual({ episodic: 0, semantic: 0, working: 0 });
    expect(stats.queue).toEqual({ pending: 0, completed: 0, failed: 0 });
    expect(stats.sizeBytes).toBeGreaterThanOrEqual(0);
  });

  it("counts chats, messages, memories and queue jobs", () => {
    sqlite
      .prepare(
        "INSERT INTO chat_sessions (id, title) VALUES (?, ?), (?, ?)"
      )
      .run("s1", "One", "s2", "Two");
    const insertMessage = sqlite.prepare(
      "INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)"
    );
    insertMessage.run("m1", "s1", "user", "hello");
    insertMessage.run("m2", "s1", "assistant", "hi");
    insertMessage.run("m3", "s2", "user", "hey");
    sqlite
      .prepare("INSERT INTO episodic_memories (id, content) VALUES (?, ?)")
      .run("e1", "event one");
    sqlite
      .prepare("INSERT INTO episodic_memories (id, content) VALUES (?, ?)")
      .run("e2", "event two");
    sqlite
      .prepare("INSERT INTO semantic_memories (id, content) VALUES (?, ?)")
      .run("sem1", "fact");
    sqlite
      .prepare(
        "INSERT INTO working_memories (id, content, expires_at) VALUES (?, ?, ?)"
      )
      .run("w1", "scratch", Date.now() / 1000 + 3600);
    const insertJob = sqlite.prepare(
      "INSERT INTO job_queue (id, type, payload, status, run_at) VALUES (?, ?, ?, ?, ?)"
    );
    insertJob.run("j1", "reflect_turn", "{}", "completed", 0);
    insertJob.run("j2", "reflect_turn", "{}", "completed", 0);
    insertJob.run("j3", "sleep_consolidation", "{}", "pending", 0);
    insertJob.run("j4", "dream_graph_discovery", "{}", "failed", 0);

    const stats = getDatabaseStats(testDb);
    expect(stats.chatCount).toBe(2);
    expect(stats.messageCount).toBe(3);
    expect(stats.memories).toEqual({ episodic: 2, semantic: 1, working: 1 });
    expect(stats.queue).toEqual({ pending: 1, completed: 2, failed: 1 });

    // Cognitive loop observability block
    expect(stats.cognitive.relations).toBe(0);
    // All seeded memories lack embeddings → they count as backfill backlog.
    expect(stats.cognitive.unembedded).toEqual({ episodic: 2, semantic: 1 });
    // Last completion per type: reflect_turn ran, pending/failed types didn't.
    const reflectRun = stats.cognitive.lastRuns.find(
      (r) => r.type === "reflect_turn"
    );
    const sleepRun = stats.cognitive.lastRuns.find(
      (r) => r.type === "sleep_consolidation"
    );
    expect(reflectRun?.at).toBeTruthy();
    expect(sleepRun?.at).toBeNull();
    // All six cognitive job types are always reported.
    expect(stats.cognitive.lastRuns.length).toBe(6);
    // Most recent failure surfaced with its error message.
    expect(stats.cognitive.lastFailure?.type).toBe("dream_graph_discovery");
  });

  it("counts processing jobs as pending", () => {
    sqlite
      .prepare(
        "INSERT INTO job_queue (id, type, payload, status, run_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run("j1", "reflect_turn", "{}", "processing", 0);

    const stats = getDatabaseStats(testDb);
    expect(stats.queue.pending).toBe(1);
  });
});
