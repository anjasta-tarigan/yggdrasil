import { registerJobHandler, startQueueRunner, stopQueueRunner } from "./queue/runner";
import { executeTurnReflection, type ReflectionPayload } from "./memory/reflection";
import { consolidateEpisodicMemories, type ConsolidationOptions } from "./memory/consolidation";
import { runDreamGraphDiscovery, type DreamOptions } from "./memory/dream";
import { runMemoryCompaction, type CompactionOptions } from "./memory/compaction";
import { initCognitiveDaemon, stopCognitiveDaemon } from "./daemon/scheduler";
import { db as defaultDb, type AppDatabase } from "@/db";

let isBootstrapped = false;
let isShutdownRegistered = false;

function registerGracefulShutdown(): void {
  if (isShutdownRegistered || typeof process === "undefined") return;
  isShutdownRegistered = true;

  const handleShutdown = (signal: string) => {
    console.info(`[bootstrap] Received ${signal}, gracefully terminating cognitive daemon and queue runner...`);
    stopCognitiveDaemon();
    stopQueueRunner();
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
}

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

  // 4. Register process teardown hooks
  registerGracefulShutdown();

  isBootstrapped = true;
  console.info("[bootstrap] Autonomous cognitive loop initialized (queue runner + daemon scheduler active).");
}

export function isSystemBootstrapped(): boolean {
  return isBootstrapped;
}
