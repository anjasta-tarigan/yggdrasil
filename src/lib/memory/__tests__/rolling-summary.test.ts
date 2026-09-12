import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  getRollingSummary,
  updateRollingSummary,
} from "../rolling-summary";
import { addSemanticMemory } from "../semantic-memory";

// Keep the test fully offline: replace embedding generation with a
// deterministic non-zero vector (same pattern as ingestion.test.ts).
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
    // resolveEmbeddingModel is called by updateRollingSummary; keep it offline.
    resolveEmbeddingModel: vi.fn(async () => "test-model"),
  };
});

describe("Rolling summary", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("retrieves a rolling summary created for the chat", async () => {
    await updateRollingSummary(
      "chat_1",
      "First question about SQLite",
      "First answer about FTS5",
      testDb
    );

    const summary = await getRollingSummary("chat_1", testDb);
    expect(summary).not.toBeNull();
    expect(summary!.content).toContain("First question about SQLite");
    expect(summary!.content).toContain("First answer about FTS5");
  });

  it("updates the existing rolling summary in place instead of duplicating", async () => {
    const firstId = await updateRollingSummary(
      "chat_2",
      "First turn",
      "First response",
      testDb
    );
    const secondId = await updateRollingSummary(
      "chat_2",
      "Second turn",
      "Second response",
      testDb
    );

    // The second call must UPDATE the same memory row, not create a new one.
    expect(secondId).toBe(firstId);

    const rows = await testDb
      .select()
      .from(schema.semanticMemories);
    const rollingRows = rows.filter(
      (r) =>
        Array.isArray(r.tags) &&
        (r.tags as string[]).includes("rolling_summary")
    );
    expect(rollingRows.length).toBe(1);
    expect(rollingRows[0].content).toContain("Second turn");

    // The retrieved summary reflects the updated content.
    const summary = await getRollingSummary("chat_2", testDb);
    expect(summary!.id).toBe(firstId);
    expect(summary!.content).toContain("First turn");
    expect(summary!.content).toContain("Second turn");
  });

  it("does not return a same-session reflection fact as the rolling summary", async () => {
    // A reflection fact sourced from the same chat session shares the
    // sources entry but is NOT tagged rolling_summary — it must never be
    // returned by getRollingSummary, even when it has an embedding and a
    // higher access count than any summary row.
    const factId = await addSemanticMemory(
      {
        content: "User prefers concise answers",
        importance: 0.9,
        tags: ["user_preference"],
        sources: ["chat_3"],
        embedding: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
        embeddingModel: "test-model",
        metadata: { extractedFrom: "reflect_turn" },
      },
      testDb
    );
    expect(factId).toBeTruthy();

    // Give the fact the highest access count so a source-only lookup
    // ordered by accessCount DESC would pick it first if untagged rows
    // were eligible.
    sqlite
      .prepare(
        "UPDATE semantic_memories SET access_count = 42 WHERE id = ?"
      )
      .run(factId);

    const summary = await getRollingSummary("chat_3", testDb);
    expect(summary).toBeNull();
  });

  it("keeps rolling summaries of different chats separate", async () => {
    await updateRollingSummary(
      "chat_a",
      "Topic in chat A",
      "Answer A",
      testDb
    );
    await updateRollingSummary(
      "chat_b",
      "Topic in chat B",
      "Answer B",
      testDb
    );

    const a = await getRollingSummary("chat_a", testDb);
    const b = await getRollingSummary("chat_b", testDb);
    expect(a!.content).toContain("Topic in chat A");
    expect(b!.content).toContain("Topic in chat B");
  });
});
