import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  initCognitiveDaemon,
  stopCognitiveDaemon,
  triggerMaintenancePass,
  getCronSchedules,
} from "../scheduler";

describe("Cognitive Daemon Scheduler", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  afterEach(() => {
    stopCognitiveDaemon();
  });

  it("enqueues maintenance jobs on manual triggers", async () => {
    const lightJobId = await triggerMaintenancePass("light_sleep", testDb);
    expect(lightJobId).toBeDefined();

    const dreamJobId = await triggerMaintenancePass("dream_cycle", testDb);
    expect(dreamJobId).toBeDefined();

    const decayJobId = await triggerMaintenancePass("decay_sweep", testDb);
    expect(decayJobId).toBeDefined();

    const jobs = testDb.select().from(schema.jobQueue).all();
    expect(jobs.length).toBe(3);
    expect(jobs.map((j: any) => j.type)).toEqual([
      "sleep_consolidation",
      "dream_graph_discovery",
      "decay_sweep",
    ]);
  });

  it("initializes and stops scheduled cron tasks", () => {
    expect(() => initCognitiveDaemon(testDb)).not.toThrow();
    const schedules = getCronSchedules();
    expect(schedules.lightSleep).toBe("*/15 * * * *");
    expect(schedules.dreamCycle).toBe("0 * * * *");
    expect(schedules.decaySweep).toBe("0 3 * * *");

    expect(() => stopCognitiveDaemon()).not.toThrow();
  });

  it("handles repeated calls to initCognitiveDaemon cleanly", () => {
    initCognitiveDaemon(testDb);
    initCognitiveDaemon(testDb); // Should not crash or double schedule
    stopCognitiveDaemon();
  });
});
