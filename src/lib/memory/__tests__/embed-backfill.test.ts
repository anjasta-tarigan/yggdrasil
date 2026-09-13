import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addEpisodicMemory } from "../episodic-memory";
import { addSemanticMemory } from "../semantic-memory";
import { rebuildEmbeddingIndex, runEmbeddingBackfill } from "../embed-backfill";

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
    resolveEmbeddingModel: vi.fn(async () => "test-embedding-model"),
  };
});

vi.mock("../vector-index", () => ({
  syncVectorIndex: vi.fn().mockResolvedValue(undefined),
}));

describe("rebuildEmbeddingIndex", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("nulls all embeddings then re-embeds every row", async () => {
    // Seed existing memories with stale embeddings
    await testDb.insert(schema.chatSessions).values({ id: "s1", title: "Test" });

    await addEpisodicMemory(
      { sessionId: "s1", content: "episodic memory one", importance: 0.8 },
      testDb
    );
    await addEpisodicMemory(
      { sessionId: "s1", content: "episodic memory two", importance: 0.7 },
      testDb
    );
    await addSemanticMemory(
      { content: "semantic memory one", importance: 0.9, tags: [] },
      testDb
    );
    await addSemanticMemory(
      { content: "semantic memory two", importance: 0.8, tags: [] },
      testDb
    );

    // Give them stale embeddings and a stale model tag
    await testDb
      .update(schema.episodicMemories)
      .set({
        embedding: Buffer.from(new Float32Array(8).buffer),
        embeddingModel: "old-model",
      })
      .run();
    await testDb
      .update(schema.semanticMemories)
      .set({
        embedding: Buffer.from(new Float32Array(8).buffer),
        embeddingModel: "old-model",
      })
      .run();

    const result = await rebuildEmbeddingIndex({ db: testDb });

    expect(result.nulledCount).toBe(4);
    expect(result.embeddedCount).toBe(4);
    expect(result.remaining).toBe(0);

    // All rows should now have embeddings under the new model
    const episodic = await testDb.select().from(schema.episodicMemories);
    const semantic = await testDb.select().from(schema.semanticMemories);

    for (const mem of [...episodic, ...semantic]) {
      expect(mem.embedding).not.toBeNull();
      expect(mem.embeddingModel).toBe("test-embedding-model");
    }
  });

  it("returns nulledCount even when endpoint is down (all remain NULL)", async () => {
    await testDb.insert(schema.chatSessions).values({ id: "s1", title: "Test" });

    await addEpisodicMemory(
      { sessionId: "s1", content: "episodic with embedding", importance: 0.8 },
      testDb
    );
    await addSemanticMemory(
      { content: "semantic with embedding", importance: 0.9, tags: [] },
      testDb
    );

    await testDb
      .update(schema.episodicMemories)
      .set({
        embedding: Buffer.from(new Float32Array(8).buffer),
        embeddingModel: "old-model",
      })
      .run();
    await testDb
      .update(schema.semanticMemories)
      .set({
        embedding: Buffer.from(new Float32Array(8).buffer),
        embeddingModel: "old-model",
      })
      .run();

    // Simulate endpoint down: generateEmbedding returns null
    const { generateEmbedding } = await import("../embeddings");
    vi.mocked(generateEmbedding).mockResolvedValue(null);

    const result = await rebuildEmbeddingIndex({ db: testDb });

    expect(result.nulledCount).toBe(2);
    expect(result.embeddedCount).toBe(0);
    expect(result.remaining).toBe(2);
  });

  it("handles empty tables gracefully", async () => {
    const result = await rebuildEmbeddingIndex({ db: testDb });

    expect(result.nulledCount).toBe(0);
    expect(result.embeddedCount).toBe(0);
    expect(result.remaining).toBe(0);
  });
});
