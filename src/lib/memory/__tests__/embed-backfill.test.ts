import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addEpisodicMemory } from "../episodic-memory";
import { addSemanticMemory } from "../semantic-memory";
import { runEmbeddingBackfill } from "../embed-backfill";

// Controllable embedding endpoint simulation.
const generateEmbeddingMock = vi.fn();
vi.mock("../embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings")>();
  return {
    ...actual,
    generateEmbedding: (...args: unknown[]) => generateEmbeddingMock(...args),
    resolveEmbeddingModel: () => Promise.resolve("test-model"),
  };
});

describe("Embedding backfill (deep sleep repair pass)", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
    generateEmbeddingMock.mockReset();

    // Memories written while the embedding endpoint was down (no vector).
    await addEpisodicMemory(
      { content: "Turn stored without a vector", sessionId: undefined },
      testDb
    );
    await addSemanticMemory({ content: "Fact stored without a vector" }, testDb);
    // One memory that already has a vector AND model tag must be left alone.
    await addSemanticMemory(
      {
        content: "Fact already embedded",
        embedding: new Float32Array([1, 0]),
        embeddingModel: "test-model",
      },
      testDb
    );
  });

  it("re-embeds rows missing vectors across both tiers", async () => {
    generateEmbeddingMock.mockResolvedValue(new Float32Array([0.5, 0.5]));

    const result = await runEmbeddingBackfill({ db: testDb });

    expect(result.embeddedCount).toBe(2);
    expect(result.remaining).toBe(0);
    expect(generateEmbeddingMock).toHaveBeenCalledTimes(2);

    const episodes = await testDb.select().from(schema.episodicMemories);
    expect(episodes[0].embedding).not.toBeNull();
    const semantics = await testDb.select().from(schema.semanticMemories);
    const repaired = semantics.find((s) => s.content === "Fact stored without a vector");
    expect(repaired?.embedding).not.toBeNull();
  });

  it("respects the per-pass limit and reports the backlog", async () => {
    generateEmbeddingMock.mockResolvedValue(new Float32Array([0.5, 0.5]));

    const result = await runEmbeddingBackfill({ db: testDb, limit: 1 });

    expect(result.embeddedCount).toBe(1);
    expect(result.remaining).toBe(1);
  });

  it("stops at the first failure when the endpoint is still down", async () => {
    generateEmbeddingMock.mockResolvedValue(null);

    const result = await runEmbeddingBackfill({ db: testDb });

    expect(result.embeddedCount).toBe(0);
    expect(result.remaining).toBe(2);
    // Initial row attempt + 1 probe to confirm endpoint outage.
    expect(generateEmbeddingMock).toHaveBeenCalledTimes(2);
  });

  it("skips but leaves un-embeddable row retryable when endpoint is healthy", async () => {
    generateEmbeddingMock.mockImplementation(async (text: string) => {
      if (text === "Turn stored without a vector") return null; // this specific row fails
      return new Float32Array([0.5, 0.5]); // probe and other rows succeed
    });

    const result = await runEmbeddingBackfill({ db: testDb });

    expect(result.embeddedCount).toBe(1);
    // The skipped row stays NULL (NOT a zero-length blob): it must remain
    // selected by later passes and counted as backlog until it embeds —
    // a zero-blob would permanently vanish from selection, vec sync, and
    // this count (the bug this behavior replaced).
    expect(result.remaining).toBe(1);
    const episodes = await testDb.select().from(schema.episodicMemories);
    const skipped = episodes.find((e) => e.content === "Turn stored without a vector");
    expect(skipped?.embedding).toBeNull();

    // Once the endpoint can embed it, the next pass repairs the row.
    generateEmbeddingMock.mockResolvedValue(new Float32Array([0.5, 0.5]));
    const second = await runEmbeddingBackfill({ db: testDb });
    expect(second.embeddedCount).toBe(1);
    expect(second.remaining).toBe(0);
    const repaired = (await testDb.select().from(schema.episodicMemories))
      .find((e) => e.content === "Turn stored without a vector");
    expect(repaired?.embedding).not.toBeNull();
  });

  it("re-embeds rows whose stored model is stale (model versioning)", async () => {
    generateEmbeddingMock.mockResolvedValue(new Float32Array([0.5, 0.5]));

    // Write a memory with an OLD model tag and an existing vector.
    await addSemanticMemory(
      {
        content: "Fact with stale model tag",
        embedding: new Float32Array([1, 0, 0]),
        embeddingModel: "old-model-v1",
      },
      testDb
    );

    const result = await runEmbeddingBackfill({ db: testDb });

    // Two NULL-vector rows + one stale-model row = 3
    expect(result.embeddedCount).toBe(3);
    const stale = (await testDb.select().from(schema.semanticMemories))
      .find((s) => s.content === "Fact with stale model tag");
    expect(stale?.embedding).not.toBeNull();
    expect(stale?.embeddingModel).toBe("test-model");
  });
});
