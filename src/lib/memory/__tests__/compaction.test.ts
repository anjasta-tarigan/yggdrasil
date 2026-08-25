import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
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
