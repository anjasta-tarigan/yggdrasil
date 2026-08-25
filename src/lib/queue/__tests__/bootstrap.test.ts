import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { bootstrapAutonomousCognitiveSystem, isSystemBootstrapped } from "@/lib/bootstrap";
import { processOneJob, stopQueueRunner } from "@/lib/queue/runner";
import { stopCognitiveDaemon } from "@/lib/daemon/scheduler";
import { enqueueJob } from "@/lib/queue/queue";

vi.mock("@/lib/memory/reflection", () => ({
  executeTurnReflection: vi.fn().mockResolvedValue({
    newFacts: [],
    correctionDetected: false,
    proceduralRule: null,
  }),
}));

vi.mock("@/lib/memory/consolidation", () => ({
  consolidateEpisodicMemories: vi.fn().mockResolvedValue({
    consolidatedCount: 0,
    createdSemanticId: null,
  }),
}));

vi.mock("@/lib/memory/dream", () => ({
  runDreamGraphDiscovery: vi.fn().mockResolvedValue({
    edgesCreated: 0,
  }),
}));

vi.mock("@/lib/memory/compaction", () => ({
  runMemoryCompaction: vi.fn().mockResolvedValue({
    prunedCount: 0,
  }),
}));

describe("Autonomous Cognitive System Bootstrap", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  afterEach(() => {
    stopQueueRunner();
    stopCognitiveDaemon();
  });

  it("bootstraps handlers and processes jobs of all 4 cognitive types", async () => {
    bootstrapAutonomousCognitiveSystem(testDb);
    expect(isSystemBootstrapped()).toBe(true);

    // Stop runner loop so it doesn't process jobs in background during our manual step-through test
    stopQueueRunner();

    const types: Array<"reflect_turn" | "sleep_consolidation" | "dream_graph_discovery" | "decay_sweep"> = [
      "reflect_turn",
      "sleep_consolidation",
      "dream_graph_discovery",
      "decay_sweep",
    ];

    for (const type of types) {
      await enqueueJob(
        {
          type,
          payload: { test: true },
          runAt: new Date(Date.now() - 1000),
        },
        testDb
      );

      const processed = await processOneJob(testDb);
      expect(processed).toBe(true);
    }
  });
});
