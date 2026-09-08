import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, POST } from "../cron/route";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import type { AppDatabase } from "@/db";

let sqlite: Database.Database;
let testDb: AppDatabase;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  get defaultDb() {
    return testDb;
  },
}));

vi.mock("@/lib/daemon/scheduler", () => ({
  isCognitiveDaemonRunning: vi.fn().mockReturnValue(true),
  triggerMaintenancePass: vi.fn().mockResolvedValue("job_mocked_123"),
  syncCognitiveDaemon: vi.fn().mockReturnValue({ armed: 3, skipped: 0 }),
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

  it("GET /api/cron returns configured schedules, daemon status, job types, and recent jobs", async () => {
    const res = await GET(new Request("http://localhost/api/cron"));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.daemonRunning).toBe(true);
    expect(json.queueRunnerRunning).toBe(true);
    // First read seeds the 3 built-in schedules
    expect(json.schedules.length).toBe(3);
    expect(json.schedules[0]).toMatchObject({
      name: "Light Sleep Consolidation",
      schedule: "*/15 * * * *",
      jobType: "sleep_consolidation",
      enabled: true,
    });
    expect(json.schedulableJobTypes.length).toBe(3);
    expect(json.recentJobs.length).toBe(1);
    expect(json.recentJobs[0].id).toBe("job_test_1");
    // Enabled schedules expose a next-run time
    expect(typeof json.schedules[0].nextRunAt).toBe("string");
    // Pagination metadata: 1 seeded job, 1 page of 20
    expect(json.jobsPagination).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    });
  });

  it("GET /api/cron paginates executions by page param", async () => {
    // Seed 25 extra jobs so page 2 exists with default page size 20
    const now = new Date();
    for (let i = 0; i < 25; i++) {
      testDb
        .insert(schema.jobQueue)
        .values({
          id: `job_page_${i}`,
          type: "decay_sweep",
          payload: {},
          status: "completed",
          attempts: 1,
          maxAttempts: 3,
          runAt: now,
          createdAt: new Date(now.getTime() - i * 1000),
          updatedAt: now,
        })
        .run();
    }

    const res = await GET(
      new Request("http://localhost/api/cron?page=2&pageSize=20")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.jobsPagination).toMatchObject({
      page: 2,
      pageSize: 20,
      total: 26, // 1 original + 25 seeded
      totalPages: 2,
    });
    // Page 2 holds the overflow: 6 rows (26 - 20)
    expect(json.recentJobs.length).toBe(6);
  });

  it("GET /api/cron clamps invalid page params safely", async () => {
    const res = await GET(
      new Request("http://localhost/api/cron?page=-5&pageSize=99999")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.jobsPagination.page).toBe(1);
    expect(json.jobsPagination.pageSize).toBe(100); // clamped to max
  });

  it("POST /api/cron triggers a maintenance pass (legacy shape)", async () => {
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

  it("POST /api/cron with scheduleId runs a configured schedule now", async () => {
    const { createCronSchedule } = await import("@/lib/daemon/cron-jobs-service");
    const created = await createCronSchedule(
      {
        name: "Fast Test",
        schedule: "* * * * *",
        jobType: "decay_sweep",
      },
      testDb
    );

    const enqueueSpy = vi.fn().mockResolvedValue("job_now_999");
    const { runCronScheduleNow } = await import(
      "@/lib/daemon/cron-jobs-service"
    );

    const req = new Request("http://localhost/api/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduleId: created.id }),
    });

    // runCronScheduleNow uses the default db (mocked to testDb)
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(typeof json.jobId).toBe("string");
    expect(json.jobId).not.toBe("");
    void enqueueSpy;
    void runCronScheduleNow;
  });

  it("POST /api/cron with unknown scheduleId returns 404", async () => {
    const req = new Request("http://localhost/api/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduleId: "cron_missing" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
  });
});
