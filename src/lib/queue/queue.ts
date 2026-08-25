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

    tx.update(schema.jobQueue)
      .set({
        status: newStatus,
        lastError: error,
        lockedAt: null,
        updatedAt: now,
      })
      .where(eq(schema.jobQueue.id, id))
      .run();
  });
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
