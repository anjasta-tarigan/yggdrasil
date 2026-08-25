import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addEpisodicMemory, getEpisodicMemories } from "../episodic-memory";
import { runMemoryCompaction } from "../compaction";
import { consolidateEpisodicMemories } from "../consolidation";

describe("Memory Compaction & Consolidation", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

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

  it("applies Ebbinghaus decay formula and boosts by access count", async () => {
    // 28 days old memory (2 half-lives of 14 days)
    const twentyEightDaysAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
    const id1 = await addEpisodicMemory(
      {
        content: "Older accessed memory",
        importance: 0.8,
      },
      testDb
    );

    // Update createdAt to 28 days ago and set accessCount to 5
    testDb
      .update(schema.episodicMemories)
      .set({
        createdAt: twentyEightDaysAgo,
        accessCount: 5,
      })
      .where(eq(schema.episodicMemories.id, id1))
      .run();

    await runMemoryCompaction({
      minImportanceThreshold: 0.01,
      db: testDb,
    });

    const [updated] = testDb
      .select()
      .from(schema.episodicMemories)
      .where(eq(schema.episodicMemories.id, id1))
      .all();

    // 0.8 * exp(-28/14) + 0.05 * ln(1+5) ≈ 0.8 * 0.1353 + 0.05 * 1.7917 ≈ 0.108 + 0.089 = 0.197
    expect(updated.importance).toBeCloseTo(0.198, 1);
  });

  it("consolidates multiple unconsolidated episodic memories into semantic knowledge", async () => {
    await addEpisodicMemory(
      {
        content: "User asked how to configure Next.js routes",
        importance: 0.7,
      },
      testDb
    );

    await addEpisodicMemory(
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
