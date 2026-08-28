import { eq } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import type { JobType, JobPayload } from "./types";
import { acquireNextJob, completeJob, failJob, recoverStaleJobs, purgeFinishedJobs } from "./queue";
import { chatActiveTracker } from "./tracker";

export type JobHandler<T = JobPayload> = (
  payload: T,
  dbInstance?: AppDatabase
) => Promise<unknown>;

/**
 * Runner state lives on globalThis so it survives dev-server HMR module
 * reloads: the handler map stays shared between a running loop and the
 * freshly re-evaluated module, and loop bookkeeping lets a new start
 * supersede a loop owned by a previous module generation instead of
 * running two loops side by side.
 */
type RunnerGlobalState = {
  handlers: Map<JobType, JobHandler>;
  running: boolean;
  activeLoopId: number;
  loopTimeoutId: NodeJS.Timeout | null;
};

const RUNNER_GLOBAL_KEY = "__yggdrasilQueueRunner";

function runnerGlobal(): RunnerGlobalState {
  const g = globalThis as unknown as Record<string, RunnerGlobalState | undefined>;
  if (!g[RUNNER_GLOBAL_KEY]) {
    g[RUNNER_GLOBAL_KEY] = {
      handlers: new Map(),
      running: false,
      activeLoopId: 0,
      loopTimeoutId: null,
    };
  }
  return g[RUNNER_GLOBAL_KEY];
}

const BACKGROUND_LLM_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  "ingest_turn",
  "sleep_consolidation",
  "reflect_turn",
  // decay_sweep itself is pure SQL, but its embedded backfill pass calls
  // the embedding endpoint and must not compete with live chat streaming.
  "decay_sweep",
]);

let isProcessing = false;
let lastStaleRecoveryAt = 0;
let lastRetentionPurgeAt = 0;
const STALE_RECOVERY_INTERVAL_MS = 60 * 1000; // Run stale recovery once every minute
const RETENTION_PURGE_INTERVAL_MS = 60 * 60 * 1000; // Purge finished jobs once per hour
const POLL_INTERVAL_MS = 1000;
const ACTIVE_CHAT_DEFER_MS = 2 * 60 * 1000; // 2 minutes

export function registerJobHandler<T = JobPayload>(
  type: JobType,
  handler: JobHandler<T>
): void {
  runnerGlobal().handlers.set(type, handler as JobHandler);
}

export async function processOneJob(
  dbInstance: AppDatabase = defaultDb
): Promise<boolean> {
  const job = await acquireNextJob(dbInstance);
  if (!job) {
    return false;
  }

  // GPU & Resource protection: if user is actively chatting, defer background LLM jobs
  if (BACKGROUND_LLM_JOB_TYPES.has(job.type) && chatActiveTracker.isChatActive()) {
    const deferredRunAt = new Date(Date.now() + ACTIVE_CHAT_DEFER_MS);
    // Decrement attempts back by 1 so active chat deferrals do not consume retry budget
    const restoredAttempts = Math.max(0, job.attempts - 1);
    dbInstance
      .update(schema.jobQueue)
      .set({
        status: "pending",
        attempts: restoredAttempts,
        lockedAt: null,
        runAt: deferredRunAt,
        updatedAt: new Date(),
      })
      .where(eq(schema.jobQueue.id, job.id))
      .run();

    return false;
  }

  const handler = runnerGlobal().handlers.get(job.type);
  if (!handler) {
    const errMsg = `No job handler registered for type: ${job.type}`;
    console.error(`[QueueRunner] ${errMsg} (job ID: ${job.id})`);
    await failJob(job.id, errMsg, dbInstance);
    return false;
  }

  try {
    await handler(job.payload, dbInstance);
    await completeJob(job.id, dbInstance);
    return true;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[QueueRunner] Error processing job ${job.id} (${job.type}):`, error);
    await failJob(job.id, errorMsg, dbInstance);
    return false;
  }
}

async function runnerHeartbeat(
  myLoopId: number,
  dbInstance: AppDatabase
): Promise<void> {
  const state = runnerGlobal();
  if (!state.running || state.activeLoopId !== myLoopId || isProcessing) return;

  isProcessing = true;
  try {
    // Run stale job recovery periodically
    const now = Date.now();
    if (now - lastStaleRecoveryAt >= STALE_RECOVERY_INTERVAL_MS) {
      await recoverStaleJobs(10 * 60 * 1000, dbInstance);
      lastStaleRecoveryAt = now;
    }

    // Purge long-finished jobs so the durable queue stays bounded
    if (now - lastRetentionPurgeAt >= RETENTION_PURGE_INTERVAL_MS) {
      try {
        await purgeFinishedJobs({}, dbInstance);
      } catch (err) {
        console.error("[QueueRunner] Retention purge error:", err);
      }
      lastRetentionPurgeAt = now;
    }

    // Process available jobs sequentially with single concurrency
    let processed = false;
    do {
      if (runnerGlobal().activeLoopId !== myLoopId) break;
      processed = await processOneJob(dbInstance);
    } while (processed && runnerGlobal().activeLoopId === myLoopId);
  } catch (err) {
    console.error("[QueueRunner] Loop heartbeat error:", err);
  } finally {
    isProcessing = false;
    const current = runnerGlobal();
    if (current.running) {
      if (current.loopTimeoutId) {
        clearTimeout(current.loopTimeoutId);
      }
      current.loopTimeoutId = setTimeout(() => {
        void runnerHeartbeat(current.activeLoopId, dbInstance);
      }, POLL_INTERVAL_MS);
    }
  }
}

export function startQueueRunner(dbInstance: AppDatabase = defaultDb): void {
  const state = runnerGlobal();
  // Supersede any live loop (including one owned by a previous HMR module
  // generation) so exactly one loop is active.
  state.activeLoopId += 1;
  if (state.loopTimeoutId) {
    clearTimeout(state.loopTimeoutId);
    state.loopTimeoutId = null;
  }
  state.running = true;
  lastStaleRecoveryAt = 0;
  lastRetentionPurgeAt = 0;
  void runnerHeartbeat(state.activeLoopId, dbInstance);
}

export function stopQueueRunner(): void {
  const state = runnerGlobal();
  state.running = false;
  state.activeLoopId += 1; // invalidate any live loop
  if (state.loopTimeoutId) {
    clearTimeout(state.loopTimeoutId);
    state.loopTimeoutId = null;
  }
}

export function isQueueRunnerRunning(): boolean {
  return runnerGlobal().running;
}
