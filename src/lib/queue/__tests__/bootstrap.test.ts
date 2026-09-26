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

vi.mock("@/lib/memory/ingestion", () => ({
  executeTurnIngestion: vi.fn().mockResolvedValue({
    episodicMemoryId: null,
    reflectionQueued: false,
  }),
}));

vi.mock("@/lib/memory/reflection", () => ({
  executeTurnReflection: vi.fn().mockResolvedValue({
    newFacts: [],
    correctionDetected: false,
    proceduralRule: null,
  }),
  reviewProceduralRules: vi.fn().mockResolvedValue({
    reviewed: 0,
    downgraded: 0,
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

vi.mock("@/lib/memory/embed-backfill", () => ({
  runEmbeddingBackfill: vi.fn().mockResolvedValue({
    embeddedCount: 0,
    remaining: 0,
  }),
}));

// Bootstrap fires a passive update check. Left unmocked it hits api.github.com
// for real and writes the cache under $HOME (Rule 06 / no-network-in-tests).
vi.mock("@/lib/system/version", () => ({
  checkLatestVersion: vi.fn(async () => ({
    current: "0.0.0",
    latest: null,
    available: false,
    channel: "release",
    releaseUrl: null,
    checkedAt: 0,
    errored: false,
  })),
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

  it("bootstraps handlers and processes jobs of all 6 job types", async () => {
    // Note: proactive_event_check is also registered but not tested here
    // as it requires embedding endpoints and a populated memory store.
    bootstrapAutonomousCognitiveSystem(testDb);
    expect(isSystemBootstrapped()).toBe(true);

    // Stop runner loop so it doesn't process jobs in background during our manual step-through test
    stopQueueRunner();

    const types: Array<"ingest_turn" | "reflect_turn" | "sleep_consolidation" | "dream_graph_discovery" | "decay_sweep" | "scheduled_reminder"> = [
      "ingest_turn",
      "reflect_turn",
      "sleep_consolidation",
      "dream_graph_discovery",
      "decay_sweep",
      "scheduled_reminder",
    ];

    for (const type of types) {
      await enqueueJob(
        {
          type,
          payload: { test: true, title: "test reminder" },
          runAt: new Date(Date.now() - 1000),
        },
        testDb
      );

      const processed = await processOneJob(testDb);
      expect(processed).toBe(true);
    }

    // The reminder handler must have produced a proactive event.
    const events = testDb.select().from(schema.proactiveEvents).all();
    expect(events.length).toBe(1);
    expect(events[0].title).toBe("test reminder");
  });
});
