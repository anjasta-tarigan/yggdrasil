import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addEpisodicMemory } from "../episodic-memory";
import { addSemanticMemory } from "../semantic-memory";
import { rebuildEmbeddingIndex } from "../embed-backfill";
import {
  listVectorIndexTables,
  purgeAllVectorIndexes,
  syncVectorIndex,
} from "../vector-index";
import * as sqliteVecModule from "sqlite-vec";

function tryLoad(sqlite: Database.Database): boolean {
  try {
    sqliteVecModule.load(sqlite);
    return true;
  } catch {
    return false;
  }
}

const vecLoadable = (() => {
  const probe = new Database(":memory:");
  const ok = tryLoad(probe);
  probe.close();
  return ok;
})();

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

  describe.skipIf(!vecLoadable)("vector index purge on rebuild", () => {
    it("purges every existing vec index before re-embedding", async () => {
      tryLoad(sqlite);

      await testDb.insert(schema.chatSessions).values({ id: "s1", title: "T" });
      await addSemanticMemory(
        { content: "semantic under model A", importance: 0.8 },
        testDb
      );
      await addEpisodicMemory(
        { sessionId: "s1", content: "episodic under model A", importance: 0.8 },
        testDb
      );

      // Simulate an old embedding model's indexes existing on disk.
      sqlite
        .prepare(
          "UPDATE semantic_memories SET embedding = ?, embedding_model = 'old-model'"
        )
        .run(Buffer.from(new Float32Array(8).fill(0.1).buffer));
      sqlite
        .prepare(
          "UPDATE episodic_memories SET embedding = ?, embedding_model = 'old-model'"
        )
        .run(Buffer.from(new Float32Array(8).fill(0.1).buffer));

      syncVectorIndex(sqlite, "semantic", 8, "old-model");
      syncVectorIndex(sqlite, "episodic", 8, "old-model");
      expect(listVectorIndexTables(sqlite).length).toBe(2);

      await rebuildEmbeddingIndex({ db: testDb });

      // The stale indexes were purged, and the rebuild recreated only what the
      // new model needs. No old-model index survives.
      const after = listVectorIndexTables(sqlite);
      expect(after.some((t) => t.includes("old_model"))).toBe(false);
    });

    it("leaves no vector shadow tables behind after a purge", () => {
      tryLoad(sqlite);
      sqlite
        .prepare(
          `INSERT INTO semantic_memories (id, content, embedding, embedding_model, importance)
           VALUES ('s-x', 'x', ?, 'm', 0.5)`
        )
        .run(Buffer.from(new Float32Array(8).fill(0.1).buffer));
      syncVectorIndex(sqlite, "semantic", 8, "m");

      const purged = purgeAllVectorIndexes(sqlite);
      expect(purged).toBe(1);

      // sqlite-vec's shadow tables must be gone too — otherwise the stale
      // vector blobs keep occupying the file.
      const leftovers = sqlite
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE name LIKE 'semantic_memories_vec%' AND name NOT LIKE 'sqlite_%'`
        )
        .all() as Array<{ name: string }>;
      expect(leftovers).toEqual([]);
    });
  });
});
