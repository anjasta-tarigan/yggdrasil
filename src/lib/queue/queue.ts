import { eq, and, lte, lt, asc } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { nanoid } from "nanoid";
import type { EnqueueJobInput, JobRow } from "./types";

export async function enqueueJob(
  input: EnqueueJobInput,
  dbInstance: AppDatabase = defaultDb
): Promise<string> {
  const id = input.id ?? `job_${nanoid(12)}`;
  const runAt = input.runAt ?? new Date();
  const maxAttempts = input.maxAttempts ?? 3;

  dbInstance
    .insert(schema.jobQueue)
    .values({
      id,
      type: input.type,
      payload: input.payload,
      status: "pending",
      attempts: 0,
      maxAttempts,
      runAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();

  return id;
}

export async function acquireNextJob(
  dbInstance: AppDatabase = defaultDb
): Promise<JobRow | null> {
  // Use a synchronous transaction for atomic dequeue in better-sqlite3
  return dbInstance.transaction((tx) => {
    const now = new Date();
    // Find the next eligible pending job (runAt <= now) ordered by runAt asc
    const [candidate] = tx
      .select()
      .from(schema.jobQueue)
      .where(
        and(
          eq(schema.jobQueue.status, "pending"),
          lte(schema.jobQueue.runAt, now)
        )
      )
      .orderBy(asc(schema.jobQueue.runAt))
      .limit(1)
      .all();

    if (!candidate) {
      return null;
    }

    const nextAttempts = candidate.attempts + 1;

    tx.update(schema.jobQueue)
      .set({
        status: "processing",
        attempts: nextAttempts,
        lockedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.jobQueue.id, candidate.id))
      .run();

    return {
      id: candidate.id,
      type: candidate.type,
      payload: candidate.payload,
      status: "processing" as const,
      attempts: nextAttempts,
      maxAttempts: candidate.maxAttempts,
      lastError: candidate.lastError,
      lockedAt: now,
      runAt: candidate.runAt,
      createdAt: candidate.createdAt,
      updatedAt: now,
    };
  });
}

export async function completeJob(
  id: string,
  dbInstance: AppDatabase = defaultDb
): Promise<void> {
  const now = new Date();
  dbInstance
    .update(schema.jobQueue)
    .set({
      status: "completed",
      lockedAt: null,
      updatedAt: now,
    })
    .where(eq(schema.jobQueue.id, id))
    .run();
}

export async function failJob(
  id: string,
  error: string,
  dbInstance: AppDatabase = defaultDb
): Promise<void> {
  dbInstance.transaction((tx) => {
    const [job] = tx
      .select()
      .from(schema.jobQueue)
      .where(eq(schema.jobQueue.id, id))
      .all();

    if (!job) return;

    const now = new Date();
    const isExhausted = job.attempts >= job.maxAttempts;
    const newStatus = isExhausted ? "failed" : "pending";
    // Exponential backoff: 30s, 60s, 120s...
    const backoffSeconds = Math.pow(2, Math.max(0, job.attempts - 1)) * 30;
    const retryRunAt = isExhausted ? job.runAt : new Date(now.getTime() + backoffSeconds * 1000);

    tx.update(schema.jobQueue)
      .set({
        status: newStatus,
        lastError: error,
        lockedAt: null,
        runAt: retryRunAt,
        updatedAt: now,
      })
      .where(eq(schema.jobQueue.id, id))
      .run();
  });
}

export interface PurgeOptions {
  /** Completed jobs older than this are deleted. Default: 7 days. */
  completedRetentionDays?: number;
  /** Failed jobs older than this are deleted. Default: 30 days. */
  failedRetentionDays?: number;
}

export interface PurgeResult {
  purgedCompleted: number;
  purgedFailed: number;
}

/**
 * Retention sweep for the durable queue. Finished jobs are audit trail,
 * not working state — completed rows are kept for a week and failed rows
 * for a month (longer, so recurring failures stay diagnosable), then
 * deleted so the table does not grow without bound.
 */
export async function purgeFinishedJobs(
  options: PurgeOptions = {},
  dbInstance: AppDatabase = defaultDb
): Promise<PurgeResult> {
  const completedRetentionDays = options.completedRetentionDays ?? 7;
  const failedRetentionDays = options.failedRetentionDays ?? 30;
  const dayMs = 24 * 60 * 60 * 1000;
  const completedCutoff = new Date(Date.now() - completedRetentionDays * dayMs);
  const failedCutoff = new Date(Date.now() - failedRetentionDays * dayMs);

  const completedResult = dbInstance
    .delete(schema.jobQueue)
    .where(
      and(
        eq(schema.jobQueue.status, "completed"),
        lt(schema.jobQueue.updatedAt, completedCutoff)
      )
    )
    .run();

  const failedResult = dbInstance
    .delete(schema.jobQueue)
    .where(
      and(
        eq(schema.jobQueue.status, "failed"),
        lt(schema.jobQueue.updatedAt, failedCutoff)
      )
    )
    .run();

  return {
    purgedCompleted: completedResult.changes ?? 0,
    purgedFailed: failedResult.changes ?? 0,
  };
}

export async function recoverStaleJobs(
  staleThresholdMs: number = 10 * 60 * 1000,
  dbInstance: AppDatabase = defaultDb
): Promise<number> {
  return dbInstance.transaction((tx) => {
    const cutoff = new Date(Date.now() - staleThresholdMs);

    const staleJobs = tx
      .select()
      .from(schema.jobQueue)
      .where(
        and(
          eq(schema.jobQueue.status, "processing"),
          lt(schema.jobQueue.lockedAt, cutoff)
        )
      )
      .all();

    let recovered = 0;
    const now = new Date();

    for (const job of staleJobs) {
      const isExhausted = job.attempts >= job.maxAttempts;
      const newStatus = isExhausted ? "failed" : "pending";

      tx.update(schema.jobQueue)
        .set({
          status: newStatus,
          lastError: "Job lock expired (stale timeout)",
          lockedAt: null,
          updatedAt: now,
        })
        .where(eq(schema.jobQueue.id, job.id))
        .run();

      recovered++;
    }

    return recovered;
  });
}
