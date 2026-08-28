import { registerJobHandler, startQueueRunner, stopQueueRunner } from "./queue/runner";
import { executeTurnReflection, type ReflectionPayload } from "./memory/reflection";
import { executeTurnIngestion, type IngestionPayload } from "./memory/ingestion";
import { consolidateEpisodicMemories, type ConsolidationOptions } from "./memory/consolidation";
import { runDreamGraphDiscovery, type DreamOptions } from "./memory/dream";
import { runMemoryCompaction, type CompactionOptions } from "./memory/compaction";
import { runEmbeddingBackfill } from "./memory/embed-backfill";
import { createProactiveEvent } from "./proactive/events";
import { initCognitiveDaemon, stopCognitiveDaemon } from "./daemon/scheduler";
import { syslog } from "./observability/log-store";
import { db as defaultDb, type AppDatabase } from "@/db";

/**
 * Bootstrap flags live on globalThis so dev-server HMR module reloads see
 * the same state: the loop/daemon started by a previous module generation
 * is still running, and shutdown hooks must not be registered twice.
 */
type BootstrapGlobalState = {
  bootstrapped: boolean;
  shutdownRegistered: boolean;
};

const BOOTSTRAP_GLOBAL_KEY = "__yggdrasilBootstrap";

function bootstrapGlobal(): BootstrapGlobalState {
  const g = globalThis as unknown as Record<string, BootstrapGlobalState | undefined>;
  if (!g[BOOTSTRAP_GLOBAL_KEY]) {
    g[BOOTSTRAP_GLOBAL_KEY] = { bootstrapped: false, shutdownRegistered: false };
  }
  return g[BOOTSTRAP_GLOBAL_KEY];
}

function registerGracefulShutdown(): void {
  const state = bootstrapGlobal();
  if (state.shutdownRegistered || typeof process === "undefined") return;
  state.shutdownRegistered = true;

  const handleShutdown = (signal: string) => {
    console.info(`[bootstrap] Received ${signal}, gracefully terminating cognitive daemon and queue runner...`);
    syslog("info", "bootstrap", `Received ${signal} — stopping cognitive daemon and queue runner`);
    stopCognitiveDaemon();
    stopQueueRunner();
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
}

function registerAllJobHandlers(dbInstance: AppDatabase): void {
  // Register all 6 background job handlers (5 cognitive + reminders)
  registerJobHandler("ingest_turn", (payload, db) =>
    executeTurnIngestion(payload as unknown as IngestionPayload, db ?? dbInstance)
  );

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

  registerJobHandler("decay_sweep", async (payload, db) => {
    const compaction = await runMemoryCompaction({
      ...(payload as unknown as CompactionOptions),
      db: db ?? dbInstance,
    });
    // Deep sleep also repairs memories written without vectors while the
    // embedding endpoint was down. Bounded per pass; resumes next sweep.
    const backfill = await runEmbeddingBackfill({ db: db ?? dbInstance });
    return { ...compaction, ...backfill };
  });

  registerJobHandler("scheduled_reminder", async (payload, db) => {
    const p = payload as { title?: unknown; body?: unknown; chatId?: unknown };
    const title =
      typeof p?.title === "string" && p.title.trim().length > 0
        ? p.title.trim()
        : "Reminder";
    const eventId = await createProactiveEvent(
      {
        kind: "reminder",
        title,
        body: typeof p?.body === "string" ? p.body : null,
        chatId: typeof p?.chatId === "string" ? p.chatId : null,
      },
      db ?? dbInstance
    );
    syslog("info", "reminder", `Reminder fired: "${title}" (event ${eventId})`);
    return { eventId };
  });
}

/**
 * Initializes and wires up all background job handlers, starts the queue runner,
 * and starts the autonomous cognitive daemon (node-cron schedules).
 *
 * Safe to call multiple times (idempotent). Handlers are re-registered on
 * every call so that after an HMR reload the still-running queue loop picks
 * up the new module's implementations from the shared handler map.
 */
export function bootstrapAutonomousCognitiveSystem(dbInstance: AppDatabase = defaultDb): void {
  registerAllJobHandlers(dbInstance);

  if (bootstrapGlobal().bootstrapped) {
    return;
  }

  // 1. Start the persistent queue runner
  startQueueRunner(dbInstance);

  // 2. Initialize autonomous node-cron cognitive maintenance scheduler
  initCognitiveDaemon(dbInstance);

  // 3. Register process teardown hooks
  registerGracefulShutdown();

  bootstrapGlobal().bootstrapped = true;
  console.info("[bootstrap] Autonomous cognitive loop initialized (queue runner + daemon scheduler active).");
  syslog(
    "info",
    "bootstrap",
    "Autonomous cognitive loop initialized (queue runner + daemon scheduler active)"
  );
}

export function isSystemBootstrapped(): boolean {
  return bootstrapGlobal().bootstrapped;
}
