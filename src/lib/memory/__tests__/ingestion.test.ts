import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { executeTurnIngestion } from "../ingestion";
import { consolidateEpisodicMemories } from "../consolidation";

// Embedding configuration is read from the real settings store, so keep the
// test fully offline by replacing generateEmbedding with a deterministic
// non-zero vector. The embedding internals are covered in embeddings.test.ts.
vi.mock("../embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings")>();
  return {
    ...actual,
    generateEmbedding: vi.fn(async (text: string) => {
      const v = new Float32Array(8);
      for (let i = 0; i < v.length; i++) v[i] = Math.sin(text.length + i + 1);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    }),
  };
});

describe("Turn ingestion → memory loop", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("writes a chat turn into episodic memory with an embedding and FTS entry", async () => {
    const result = await executeTurnIngestion(
      {
        sessionId: "sess_1",
        userPrompt: "How do I index SQLite for full-text search?",
        assistantResponse: "Use the FTS5 virtual table module with triggers.",
        userMessagesCount: 1,
      },
      testDb
    );

    expect(result.episodicMemoryId).toBeTruthy();
    expect(result.reflectionQueued).toBe(false);

    const rows = await testDb.select().from(schema.episodicMemories);
    expect(rows.length).toBe(1);
    expect(rows[0].sessionId).toBe("sess_1");
    expect(rows[0].content).toContain("full-text search");
    expect(rows[0].content).toContain("FTS5");
    expect(rows[0].embedding).not.toBeNull();
    expect(rows[0].tags).toContain("chat_turn");

    // The FTS trigger must have indexed the turn so search can retrieve it.
    const ftsHits = sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM episodic_memories_fts WHERE episodic_memories_fts MATCH ?"
      )
      .get('"SQLite"') as { n: number };
    expect(ftsHits.n).toBe(1);

    // The FK race guard must have created a placeholder session row so the
    // episodic insert succeeds even before the client saves the chat.
    const sessions = await testDb.select().from(schema.chatSessions);
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("sess_1");
  });

  it("queues a reflect_turn job for preference-bearing turns only", async () => {
    await executeTurnIngestion(
      {
        sessionId: "s",
        userPrompt: "I prefer concise answers from now on",
        assistantResponse: "Understood.",
        userMessagesCount: 1,
      },
      testDb
    );

    let jobs = await testDb.select().from(schema.jobQueue);
    expect(jobs.length).toBe(1);
    expect(jobs[0].type).toBe("reflect_turn");
    expect(jobs[0].status).toBe("pending");
    expect(jobs[0].payload).toMatchObject({ sessionId: "s" });

    // Reflection-worthy turns also get the importance boost.
    const episodes = await testDb.select().from(schema.episodicMemories);
    expect(episodes[0].importance).toBeGreaterThan(0.5);

    await executeTurnIngestion(
      {
        sessionId: "s",
        userPrompt: "What time is it in Tokyo?",
        assistantResponse: "It is evening in Tokyo.",
        userMessagesCount: 2,
      },
      testDb
    );

    jobs = await testDb.select().from(schema.jobQueue);
    expect(jobs.length).toBe(1); // neutral turn adds no reflection job
  });

  it("skips ingestion for empty or malformed turns", async () => {
    const empty = await executeTurnIngestion(
      { sessionId: "s", userPrompt: "", assistantResponse: "   " },
      testDb
    );
    expect(empty.episodicMemoryId).toBeNull();

    const malformed = await executeTurnIngestion(
      { test: true } as never,
      testDb
    );
    expect(malformed.episodicMemoryId).toBeNull();

    const rows = await testDb.select().from(schema.episodicMemories);
    expect(rows.length).toBe(0);
    const jobs = await testDb.select().from(schema.jobQueue);
    expect(jobs.length).toBe(0);
  });

  it("deduplicates regenerated turns: same user prompt updates the existing memory", async () => {
    const first = await executeTurnIngestion(
      {
        sessionId: "regen",
        userPrompt: "Explain WAL mode",
        assistantResponse: "WAL stands for write-ahead logging.",
        userMessagesCount: 1,
      },
      testDb
    );
    expect(first.episodicMemoryId).toBeTruthy();
    expect(first.deduplicated).toBeFalsy();

    // Regeneration: identical user prompt, different assistant response.
    const second = await executeTurnIngestion(
      {
        sessionId: "regen",
        userPrompt: "Explain WAL mode",
        assistantResponse: "WAL lets readers proceed while a writer appends.",
        userMessagesCount: 1,
      },
      testDb
    );
    expect(second.deduplicated).toBe(true);
    expect(second.episodicMemoryId).toBe(first.episodicMemoryId);
    expect(second.reflectionQueued).toBe(false);

    // Still exactly one episodic row, now carrying the regenerated answer.
    const rows = await testDb.select().from(schema.episodicMemories);
    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain("readers proceed");
    expect(rows[0].content).not.toContain("write-ahead logging");
  });

  it("does not deduplicate different user prompts in the same session", async () => {
    await executeTurnIngestion(
      {
        sessionId: "regen",
        userPrompt: "First question",
        assistantResponse: "First answer.",
        userMessagesCount: 1,
      },
      testDb
    );
    const second = await executeTurnIngestion(
      {
        sessionId: "regen",
        userPrompt: "Second question",
        assistantResponse: "Second answer.",
        userMessagesCount: 2,
      },
      testDb
    );
    expect(second.deduplicated).toBeFalsy();

    const rows = await testDb.select().from(schema.episodicMemories);
    expect(rows.length).toBe(2);
  });

  it("full loop: ingested turns consolidate into semantic memory (light sleep)", async () => {
    // Two turns in the same session give consolidation a cluster to work on.
    await executeTurnIngestion(
      {
        sessionId: "loop",
        userPrompt: "Remember: my project is called Yggdrasil",
        assistantResponse: "Noted — Yggdrasil.",
        userMessagesCount: 1,
      },
      testDb
    );
    await executeTurnIngestion(
      {
        sessionId: "loop",
        userPrompt: "It uses SQLite for storage",
        assistantResponse: "Got it, SQLite storage.",
        userMessagesCount: 2,
      },
      testDb
    );

    const summary = "The user's project Yggdrasil uses SQLite for storage.";
    const consolidation = await consolidateEpisodicMemories({
      db: testDb,
      summarizer: async () => summary,
    });

    expect(consolidation.consolidatedCount).toBe(2);
    expect(consolidation.createdSemanticId).toBeTruthy();

    // The loop produced durable semantic memory with an embedding.
    const semantics = await testDb.select().from(schema.semanticMemories);
    expect(semantics.length).toBe(1);
    expect(semantics[0].content).toBe(summary);
    expect(semantics[0].embedding).not.toBeNull();

    // Episodic rows are marked consolidated and linked to the summary.
    const episodes = await testDb.select().from(schema.episodicMemories);
    expect(episodes.length).toBe(2);
    expect(
      episodes.every((e) => e.consolidatedInto === consolidation.createdSemanticId)
    ).toBe(true);

    const relations = await testDb.select().from(schema.memoryRelations);
    expect(relations.length).toBe(2);
    expect(relations.every((r) => r.relationType === "consolidated_into")).toBe(true);

    // A second sweep finds nothing left to consolidate (idempotent).
    const second = await consolidateEpisodicMemories({
      db: testDb,
      summarizer: async () => "should not run",
    });
    expect(second.consolidatedCount).toBe(0);
  });
});
