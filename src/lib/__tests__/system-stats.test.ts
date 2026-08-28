import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { collectSystemStats } from "../system-stats";

describe("System stats collection", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("collects device, resource, scheduler and database facts", async () => {
    const stats = await collectSystemStats({ db: testDb });

    // Device
    expect(stats.device.hostname.length).toBeGreaterThan(0);
    expect(stats.device.cpuCores).toBeGreaterThan(0);
    expect(stats.device.nodeVersion).toMatch(/^v\d+/);
    expect(stats.device.processUptimeSeconds).toBeGreaterThanOrEqual(0);

    // Resources
    expect(stats.resources.memoryTotalBytes).toBeGreaterThan(0);
    expect(stats.resources.memoryFreeBytes).toBeGreaterThan(0);
    expect(stats.resources.processRssBytes).toBeGreaterThan(0);
    expect(stats.resources.loadAverage.length).toBe(3);

    // Scheduler
    expect(stats.scheduler.cron).toMatchObject({
      lightSleep: expect.any(String),
      dreamCycle: expect.any(String),
      decaySweep: expect.any(String),
    });
    expect(typeof stats.scheduler.daemonRunning).toBe("boolean");
    expect(typeof stats.scheduler.queueRunnerRunning).toBe("boolean");

    // Database block reflects the injected (empty) database.
    expect(stats.database.chatCount).toBe(0);
    expect(stats.database.memories).toEqual({
      episodic: 0,
      semantic: 0,
      working: 0,
    });

    expect(stats.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports LLM service status without throwing when unconfigured", async () => {
    // Vitest does not load .env.local, so LLM_BASE_URL is unset here.
    const stats = await collectSystemStats({ db: testDb });
    expect(["ok", "down", "unconfigured"]).toContain(stats.services.llm.status);
    expect(stats.services.embedding.provider.length).toBeGreaterThan(0);
  });

  it("gpu is null or a well-formed object", async () => {
    const stats = await collectSystemStats({ db: testDb });
    if (stats.gpu !== null) {
      expect(stats.gpu.name.length).toBeGreaterThan(0);
      expect(stats.gpu.memoryTotalMb).toBeGreaterThan(0);
    }
  });
});
