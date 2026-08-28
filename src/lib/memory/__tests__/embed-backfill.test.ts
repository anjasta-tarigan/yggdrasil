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
    // One memory that already has a vector must be left alone.
    await addSemanticMemory(
      {
        content: "Fact already embedded",
        embedding: new Float32Array([1, 0]),
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

  it("skips and marks un-embeddable row when endpoint is healthy", async () => {
    generateEmbeddingMock.mockImplementation(async (text: string) => {
      if (text === "Turn stored without a vector") return null; // this specific row fails
      return new Float32Array([0.5, 0.5]); // probe and other rows succeed
    });

    const result = await runEmbeddingBackfill({ db: testDb });

    expect(result.embeddedCount).toBe(1);
    expect(result.remaining).toBe(0);
  });
});
