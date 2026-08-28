import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, POST } from "../cron/route";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";

let sqlite: Database.Database;
let testDb: any;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  get defaultDb() {
    return testDb;
  },
}));

vi.mock("@/lib/daemon/scheduler", () => ({
  getCronSchedules: vi.fn().mockReturnValue({
    lightSleep: "*/15 * * * *",
    dreamCycle: "0 * * * *",
    decaySweep: "0 3 * * *",
  }),
  isCognitiveDaemonRunning: vi.fn().mockReturnValue(true),
  triggerMaintenancePass: vi.fn().mockResolvedValue("job_mocked_123"),
}));

vi.mock("@/lib/queue/runner", () => ({
  isQueueRunnerRunning: vi.fn().mockReturnValue(true),
}));

describe("Cron API Route", () => {
  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });

    // Seed test jobs
    testDb
      .insert(schema.jobQueue)
      .values({
        id: "job_test_1",
        type: "sleep_consolidation",
        payload: { test: true },
        status: "completed",
        attempts: 1,
        maxAttempts: 3,
        runAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
  });

  it("GET /api/cron returns schedules, daemon status, definitions, and recent jobs", async () => {
    const res = await GET();
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.daemonRunning).toBe(true);
    expect(json.queueRunnerRunning).toBe(true);
    expect(json.schedules).toMatchObject({
      lightSleep: "*/15 * * * *",
    });
    expect(json.definitions.length).toBeGreaterThanOrEqual(3);
    expect(json.recentJobs.length).toBe(1);
    expect(json.recentJobs[0].id).toBe("job_test_1");
  });

  it("POST /api/cron triggers a maintenance pass", async () => {
    const req = new Request("http://localhost/api/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pass: "light_sleep" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.jobId).toBe("job_mocked_123");
  });

  it("POST /api/cron rejects invalid passes", async () => {
    const req = new Request("http://localhost/api/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pass: "invalid_pass" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
