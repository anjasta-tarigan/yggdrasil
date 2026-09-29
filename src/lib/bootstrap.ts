import { registerJobHandler, startQueueRunner, stopQueueRunner } from "./queue/runner";
import {
  executeTurnReflection,
  type ReflectionPayload,
  reviewProceduralRules,
} from "./memory/reflection";
import { executeTurnIngestion, type IngestionPayload } from "./memory/ingestion";
import { consolidateEpisodicMemories, type ConsolidationOptions } from "./memory/consolidation";
import { runDreamGraphDiscovery, type DreamOptions } from "./memory/dream";
import { runMemoryCompaction, type CompactionOptions } from "./memory/compaction";
import { runEmbeddingBackfill } from "./memory/embed-backfill";
import {
  createProactiveEvent,
  createProactiveEventIfNotRecent,
  generateProactiveEvents,
} from "./proactive/events";
import { initCognitiveDaemon, stopCognitiveDaemon } from "./daemon/scheduler";
import { runPragmaOptimize, runVacuum } from "@/db/maintenance";
import { syslog } from "./observability/log-store";
import { db as defaultDb, type AppDatabase } from "@/db";
import { registerTelemetry } from "ai";
import { getDevToolsInstance } from "@/lib/ai/ai-sdk-devtools";
import { checkLatestVersion } from "@/lib/system/version";

/** Cooldown so a freshly-available update surfaces once, not every startup. */
const UPDATE_EVENT_COOLDOWN_SECONDS = 24 * 3600;

/**
 * Surfaces an available update as a proactive event so it lands in the header
 * notification center (the EventsInbox popover) rather than only the About-tab
 * banner. Wrapped in its own guard so a network/parse failure can never block
 * bootstrap. Only the *current* latest release is announced, and the event
 * creation is cooldown-gated so each new version is announced once per day.
 */
async function announceUpdateIfAvailable(): Promise<void> {
  const check = await checkLatestVersion();
  if (!check.available || !check.latest) return;
  const latest = check.latest.replace(/^[vV]/, "");
  createProactiveEventIfNotRecent(
    {
      kind: "system",
      title: `Update v${latest} available`,
      body: check.releaseUrl
        ? `A new Yggdrasil release (v${latest}) is ready. Open ${check.releaseUrl} to view the changelog and update.`
        : `A new Yggdrasil release (v${latest}) is ready.`,
      cooldownSeconds: UPDATE_EVENT_COOLDOWN_SECONDS,
      titleContains: "Update v",
    },
    defaultDb
  );
}

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
    // Rule quality control: periodically downgrade stale procedural rules.
    const ruleReview = await reviewProceduralRules(db ?? dbInstance);
    // SQLite file maintenance: refresh planner stats every pass (cheap) and
    // VACUUM weekly on Sundays (slower, reclaims free pages). Failures are
    // logged but never fail the sweep — memory work already completed.
    try {
      await runPragmaOptimize();
    } catch {
      // runPragmaOptimize already logged the failure via syslog.
    }
    let sqliteMaintenance: Record<string, unknown> = { pragmaOptimize: "completed" };
    if (new Date().getDay() === 0) {
      try {
        sqliteMaintenance = { ...sqliteMaintenance, vacuum: await runVacuum() };
      } catch {
        // runVacuum already logged the failure via syslog.
        sqliteMaintenance = { ...sqliteMaintenance, vacuum: "failed" };
      }
    }
    return { ...compaction, ...backfill, ...ruleReview, ...sqliteMaintenance };
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

  registerJobHandler("proactive_event_check", async (_payload, db) => {
    const result = await generateProactiveEvents(db ?? dbInstance);
    syslog(
      "info",
      "proactive",
      `Proactive event scan complete: ${result.created} event(s) created`
    );
    return result;
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

  // 0. Register AI SDK DevTools telemetry for local debugging (dev-only).
  //    Registration is global so no streamText() changes are needed.
  const devTools = getDevToolsInstance();
  if (devTools) {
    registerTelemetry(devTools);
  }

  // 1. Start the persistent queue runner
  startQueueRunner(dbInstance);

  // 2. Initialize autonomous node-cron cognitive maintenance scheduler
  initCognitiveDaemon(dbInstance);

  // 3. Register process teardown hooks
  registerGracefulShutdown();

  // 4. Non-blocking update check; also surfaces an available update as a
  //    proactive event in the header notification center.
  void announceUpdateIfAvailable().catch((err) => {
    syslog("warn", "update-check", `Startup update check failed: ${err}`);
  });

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
