import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addEpisodicMemory, getEpisodicMemories } from "../episodic-memory";
import { addSemanticMemory } from "../semantic-memory";
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

  it("prunes superseded semantic memories that were invalidated by newer facts", async () => {
    const oldId = await addSemanticMemory(
      {
        content: "User lives in Jakarta",
        importance: 0.1,
        metadata: { category: "user_preference", superseded: true },
      },
      testDb
    );
    testDb
      .insert(schema.memoryRelations)
      .values({
        id: "rel_prune_1",
        fromMemoryId: oldId,
        fromMemoryType: "semantic",
        toMemoryId: "sem_newer",
        toMemoryType: "semantic",
        relationType: "superseded_by",
        strength: 0.95,
      })
      .run();

    const freshId = await addSemanticMemory(
      {
        content: "User lives in Bandung",
        importance: 0.95,
        metadata: { category: "user_preference" },
      },
      testDb
    );

    const result = await runMemoryCompaction({
      minImportanceThreshold: 0.05,
      db: testDb,
    });

    expect(result.prunedSemanticCount).toBe(1);

    const remaining = testDb.select().from(schema.semanticMemories).all();
    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).not.toContain(oldId);
    expect(remainingIds).toContain(freshId);

    // The invalidation link dies with the pruned row — no dangling edges.
    const relations = testDb.select().from(schema.memoryRelations).all();
    expect(relations.length).toBe(0);
  });

  it("never prunes a semantic memory that still anchors live episodic children", async () => {
    const parentId = await addSemanticMemory(
      {
        content: "Parent semantic anchor",
        importance: 0.1,
        metadata: { superseded: true },
      },
      testDb
    );

    const childId = await addEpisodicMemory(
      { content: "Child episodic that consolidated into the parent", importance: 0.8 },
      testDb
    );
    testDb
      .insert(schema.memoryRelations)
      .values({
        id: "rel_guard_1",
        fromMemoryId: childId,
        fromMemoryType: "episodic",
        toMemoryId: parentId,
        toMemoryType: "semantic",
        relationType: "consolidated_into",
        strength: 0.9,
      })
      .run();

    await runMemoryCompaction({
      minImportanceThreshold: 0.05,
      db: testDb,
    });

    const remaining = testDb.select().from(schema.semanticMemories).all();
    expect(remaining.map((r) => r.id)).toContain(parentId);
  });

  it("decays stale semantic memories with the same Ebbinghaus curve as episodic ones", async () => {
    const id = await addSemanticMemory(
      { content: "Decaying semantic fact", importance: 0.8 },
      testDb
    );
    // Direct SQL: drizzle refuses raw epoch numbers for a timestamp column.
    const ninetyDaysAgo = Math.floor(Date.now() / 1000) - 90 * 86400;
    sqlite
      .prepare("UPDATE semantic_memories SET updated_at = ? WHERE id = ?")
      .run(ninetyDaysAgo, id);

    await runMemoryCompaction({
      minImportanceThreshold: 0.01,
      db: testDb,
    });

    const [row] = testDb
      .select()
      .from(schema.semanticMemories)
      .where(eq(schema.semanticMemories.id, id))
      .all();
    // Untouched for 90 days: 0.8 * exp(-90/14) ≈ 0.0013 → floored at 0.01,
    // strictly below its starting 0.8.
    expect(row.importance).toBeLessThan(0.8);
    expect(row.importance).toBeGreaterThanOrEqual(0.01);
  });
});
