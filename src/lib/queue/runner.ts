import { eq } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import type { JobType, JobPayload } from "./types";
import { acquireNextJob, completeJob, failJob, recoverStaleJobs } from "./queue";
import { chatActiveTracker } from "./tracker";

export type JobHandler<T = JobPayload> = (
  payload: T,
  dbInstance?: AppDatabase
) => Promise<unknown>;

const jobHandlers = new Map<JobType, JobHandler>();

const BACKGROUND_LLM_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  "sleep_consolidation",
  "reflect_turn",
]);

let isRunning = false;
let loopTimeoutId: NodeJS.Timeout | null = null;
let isProcessing = false;
let lastStaleRecoveryAt = 0;
const STALE_RECOVERY_INTERVAL_MS = 60 * 1000; // Run stale recovery once every minute
const POLL_INTERVAL_MS = 1000;
const ACTIVE_CHAT_DEFER_MS = 2 * 60 * 1000; // 2 minutes

export function registerJobHandler<T = JobPayload>(
  type: JobType,
  handler: JobHandler<T>
): void {
  jobHandlers.set(type, handler as JobHandler);
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

  const handler = jobHandlers.get(job.type);
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

async function runnerHeartbeat(dbInstance: AppDatabase): Promise<void> {
  if (!isRunning || isProcessing) return;

  isProcessing = true;
  try {
    // Run stale job recovery periodically
    const now = Date.now();
    if (now - lastStaleRecoveryAt >= STALE_RECOVERY_INTERVAL_MS) {
      await recoverStaleJobs(10 * 60 * 1000, dbInstance);
      lastStaleRecoveryAt = now;
    }

    // Process available jobs sequentially with single concurrency
    let processed = false;
    do {
      if (!isRunning) break;
      processed = await processOneJob(dbInstance);
    } while (processed && isRunning);
  } catch (err) {
    console.error("[QueueRunner] Loop heartbeat error:", err);
  } finally {
    isProcessing = false;
    if (isRunning) {
      loopTimeoutId = setTimeout(() => {
        void runnerHeartbeat(dbInstance);
      }, POLL_INTERVAL_MS);
    }
  }
}

export function startQueueRunner(dbInstance: AppDatabase = defaultDb): void {
  if (isRunning) return;
  isRunning = true;
  lastStaleRecoveryAt = 0;
  void runnerHeartbeat(dbInstance);
}

export function stopQueueRunner(): void {
  isRunning = false;
  if (loopTimeoutId) {
    clearTimeout(loopTimeoutId);
    loopTimeoutId = null;
  }
}
