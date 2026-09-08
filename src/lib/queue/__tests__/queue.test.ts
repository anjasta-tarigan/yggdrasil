import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  enqueueJob,
  acquireNextJob,
  completeJob,
  failJob,
  recoverStaleJobs,
  purgeFinishedJobs,
} from "../queue";

describe("SQLite Job Queue Core", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("enqueues and acquires jobs in runAt order", async () => {
    const id1 = await enqueueJob(
      {
        type: "reflect_turn",
        payload: { num: 1 },
        runAt: new Date(Date.now() - 1000),
      },
      testDb
    );

    await enqueueJob(
      {
        type: "sleep_consolidation",
        payload: { num: 2 },
        runAt: new Date(Date.now() + 5000), // Future
      },
      testDb
    );

    const job = await acquireNextJob(testDb);
    expect(job).not.toBeNull();
    expect(job?.id).toBe(id1);
    expect(job?.status).toBe("processing");

    // Second job is in the future, should not be acquired
    const nextJob = await acquireNextJob(testDb);
    expect(nextJob).toBeNull();

    await completeJob(id1, testDb);
  });

  it("recovers stale processing jobs on timeout", async () => {
    const id = await enqueueJob(
      {
        type: "reflect_turn",
        payload: { test: true },
        runAt: new Date(Date.now() - 1000),
      },
      testDb
    );

    const acquired = await acquireNextJob(testDb);
    expect(acquired?.id).toBe(id);

    // Simulate stale lock older than 10 mins
    testDb
      .update(schema.jobQueue)
      .set({ lockedAt: new Date(Date.now() - 15 * 60 * 1000) })
      .run();

    const recoveredCount = await recoverStaleJobs(10 * 60 * 1000, testDb);
    expect(recoveredCount).toBe(1);

    const reacquired = await acquireNextJob(testDb);
    expect(reacquired?.id).toBe(id);
    expect(reacquired?.attempts).toBe(2);
  });

  it("handles job failure and retries up to maxAttempts", async () => {
    const id = await enqueueJob(
      {
        type: "reflect_turn",
        payload: { attempt: 1 },
        maxAttempts: 2,
        runAt: new Date(Date.now() - 1000),
      },
      testDb
    );

    const job1 = await acquireNextJob(testDb);
    expect(job1?.id).toBe(id);
    expect(job1?.attempts).toBe(1);

    // Fail attempt 1
    await failJob(id, "Error on attempt 1", testDb);

    // Should be pending again with incremented attempts
    const [rowAfterFail1] = testDb
      .select()
      .from(schema.jobQueue)
      .all();
    expect(rowAfterFail1.status).toBe("pending");
    expect(rowAfterFail1.lastError).toBe("Error on attempt 1");

    // Manually advance runAt for immediate test acquisition (exponential backoff pushes it into future)
    testDb
      .update(schema.jobQueue)
      .set({ runAt: new Date(Date.now() - 1000) })
      .where(eq(schema.jobQueue.id, id))
      .run();

    // Acquire attempt 2
    const job2 = await acquireNextJob(testDb);
    expect(job2?.id).toBe(id);
    expect(job2?.attempts).toBe(2);

    // Fail attempt 2 (hits maxAttempts: 2)
    await failJob(id, "Error on attempt 2", testDb);

    const [rowAfterFail2] = testDb
      .select()
      .from(schema.jobQueue)
      .all();
    expect(rowAfterFail2.status).toBe("failed");
    expect(rowAfterFail2.lastError).toBe("Error on attempt 2");

    // No further job acquired
    const job3 = await acquireNextJob(testDb);
    expect(job3).toBeNull();
  });

  it("purges finished jobs past their retention window only", async () => {
    const dayMs = 24 * 60 * 60 * 1000;

    // Old completed job (8 days) — beyond the 7-day completed retention.
    const oldCompleted = await enqueueJob(
      { type: "sleep_consolidation", payload: { old: true } },
      testDb
    );
    // Recent completed job (1 day) — must survive the purge.
    const recentCompleted = await enqueueJob(
      { type: "sleep_consolidation", payload: { recent: true } },
      testDb
    );
    // Old failed job (31 days) — beyond the 30-day failed retention.
    const oldFailed = await enqueueJob(
      { type: "reflect_turn", payload: { failed: true } },
      testDb
    );
    // Pending job, old — must never be purged.
    const oldPending = await enqueueJob(
      { type: "dream_graph_discovery", payload: { pending: true } },
      testDb
    );

    testDb
      .update(schema.jobQueue)
      .set({ status: "completed", createdAt: new Date(Date.now() - 8 * dayMs), updatedAt: new Date(Date.now() - 8 * dayMs) })
      .where(eq(schema.jobQueue.id, oldCompleted))
      .run();
    testDb
      .update(schema.jobQueue)
      .set({ status: "completed", createdAt: new Date(Date.now() - 1 * dayMs), updatedAt: new Date(Date.now() - 1 * dayMs) })
      .where(eq(schema.jobQueue.id, recentCompleted))
      .run();
    testDb
      .update(schema.jobQueue)
      .set({ status: "failed", createdAt: new Date(Date.now() - 31 * dayMs), updatedAt: new Date(Date.now() - 31 * dayMs) })
      .where(eq(schema.jobQueue.id, oldFailed))
      .run();
    testDb
      .update(schema.jobQueue)
      .set({ createdAt: new Date(Date.now() - 60 * dayMs), updatedAt: new Date(Date.now() - 60 * dayMs) })
      .where(eq(schema.jobQueue.id, oldPending))
      .run();

    const result = await purgeFinishedJobs({}, testDb);
    expect(result.purgedCompleted).toBe(1);
    expect(result.purgedFailed).toBe(1);

    const survivors = testDb.select().from(schema.jobQueue).all();
    expect(survivors.length).toBe(2);
    const ids = survivors.map((j) => j.id);
    expect(ids).toContain(recentCompleted);
    expect(ids).toContain(oldPending);
  });
});
