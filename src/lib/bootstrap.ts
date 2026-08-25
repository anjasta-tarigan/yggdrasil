import { registerJobHandler, startQueueRunner } from "./queue/runner";
import { executeTurnReflection, type ReflectionPayload } from "./memory/reflection";
import { consolidateEpisodicMemories, type ConsolidationOptions } from "./memory/consolidation";
import { runDreamGraphDiscovery, type DreamOptions } from "./memory/dream";
import { runMemoryCompaction, type CompactionOptions } from "./memory/compaction";
import { initCognitiveDaemon } from "./daemon/scheduler";
import { db as defaultDb, type AppDatabase } from "@/db";

let isBootstrapped = false;

/**
 * Initializes and wires up all background job handlers, starts the queue runner,
 * and starts the autonomous cognitive daemon (node-cron schedules).
 *
 * Safe to call multiple times (idempotent).
 */
export function bootstrapAutonomousCognitiveSystem(dbInstance: AppDatabase = defaultDb): void {
  if (isBootstrapped) {
    return;
  }

  // 1. Register all 4 background cognitive job handlers
  registerJobHandler("reflect_turn", (payload, db) =>
    executeTurnReflection(payload as unknown as ReflectionPayload, db ?? dbInstance)
  );

  registerJobHandler("sleep_consolidation", (payload, db) =>
    consolidateEpisodicMemories({
      ...(payload as unknown as ConsolidationOptions),
      db: db ?? dbInstance,
    })
  );

  registerJobHandler("dream_graph_discovery", (payload, db) =>
    runDreamGraphDiscovery({
      ...(payload as unknown as DreamOptions),
      db: db ?? dbInstance,
    })
  );

  registerJobHandler("decay_sweep", (payload, db) =>
    runMemoryCompaction({
      ...(payload as unknown as CompactionOptions),
      db: db ?? dbInstance,
    })
  );

  // 2. Start the persistent queue runner
  startQueueRunner(dbInstance);

  // 3. Initialize autonomous node-cron cognitive maintenance scheduler
  initCognitiveDaemon(dbInstance);

  isBootstrapped = true;
  console.info("[bootstrap] Autonomous cognitive loop initialized (queue runner + daemon scheduler active).");
}

export function isSystemBootstrapped(): boolean {
  return isBootstrapped;
}
