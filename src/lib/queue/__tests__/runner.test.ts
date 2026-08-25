import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { enqueueJob } from "../queue";
import {
  registerJobHandler,
  processOneJob,
  startQueueRunner,
  stopQueueRunner,
} from "../runner";
import { chatActiveTracker } from "../tracker";

describe("Queue Runner Loop", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
    chatActiveTracker.reset();
  });

  afterEach(() => {
    stopQueueRunner();
    chatActiveTracker.reset();
  });

  it("processes registered job handlers sequentially", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerJobHandler("reflect_turn", handler);

    const id = await enqueueJob(
      {
        type: "reflect_turn",
        payload: { sample: "data" },
        runAt: new Date(Date.now() - 1000),
      },
      testDb
    );

    const processed = await processOneJob(testDb);
    expect(processed).toBe(true);
    expect(handler).toHaveBeenCalledWith({ sample: "data" }, testDb);

    const [job] = testDb.select().from(schema.jobQueue).all();
    expect(job.status).toBe("completed");
  });

  it("defers background LLM jobs when user is actively chatting (GPU protection)", async () => {
    chatActiveTracker.startChat();

    const id = await enqueueJob(
      {
        type: "sleep_consolidation",
        payload: { batchSize: 10 },
        runAt: new Date(Date.now() - 1000),
      },
      testDb
    );

    const processed = await processOneJob(testDb);
    expect(processed).toBe(false); // Deferred

    const [job] = testDb.select().from(schema.jobQueue).all();
    expect(job.status).toBe("pending");
    // runAt should have been deferred into the future (+ 2 minutes)
    expect(new Date(job.runAt).getTime()).toBeGreaterThan(Date.now() + 60 * 1000);

    chatActiveTracker.endChat();
  });

  it("fails job and captures error when handler throws", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("Handler execution failed"));
    registerJobHandler("reflect_turn", handler);

    const id = await enqueueJob(
      {
        type: "reflect_turn",
        payload: { attempt: 1 },
        maxAttempts: 1,
        runAt: new Date(Date.now() - 1000),
      },
      testDb
    );

    const processed = await processOneJob(testDb);
    expect(processed).toBe(false);

    const [job] = testDb.select().from(schema.jobQueue).all();
    expect(job.status).toBe("failed");
    expect(job.lastError).toContain("Handler execution failed");
  });
});
