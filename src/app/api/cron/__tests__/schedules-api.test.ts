import { describe, it, expect, vi, beforeEach } from "vitest";
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
  syncCognitiveDaemon: vi.fn().mockReturnValue({ armed: 3, skipped: 0 }),
}));

vi.mock("@/lib/queue/queue", () => ({
  enqueueJob: vi.fn().mockResolvedValue("job_sched_test"),
}));

import { GET, POST, PATCH, DELETE } from "../schedules/route";
import {
  createCronSchedule,
  listCronSchedules,
} from "@/lib/daemon/cron-jobs-service";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  setupFtsAndTriggers(db);
  return drizzle(db, { schema });
}

function jsonReq(method: string, body: unknown, url = "http://localhost/api/cron/schedules") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("Cron Schedules CRUD Route", () => {
  beforeEach(() => {
    testDb = freshDb();
    vi.clearAllMocks();
  });

  it("GET lists schedules (seeding on first access)", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.schedules.length).toBe(3);
  });

  it("POST creates a valid schedule and syncs the daemon", async () => {
    const res = await POST(
      jsonReq("POST", {
        name: "Custom sweep",
        schedule: "20 */2 * * *",
        jobType: "decay_sweep",
        description: "Every 2 hours at :20",
      })
    );
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.schedule.id).toMatch(/^cron_/);
    expect(json.schedule.name).toBe("Custom sweep");
    expect(json.schedule.enabled).toBe(true);

    const { syncCognitiveDaemon } = await import("@/lib/daemon/scheduler");
    expect(syncCognitiveDaemon).toHaveBeenCalled();

    const all = listCronSchedules(testDb);
    expect(all).toHaveLength(4);
  });

  it("POST rejects invalid payloads with field issues", async () => {
    const res = await POST(
      jsonReq("POST", {
        name: "",
        schedule: "not cron",
        jobType: "ingest_turn",
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("PATCH updates an existing schedule and syncs the daemon", async () => {
    const created = await createCronSchedule(
      { name: "Before", schedule: "* * * * *", jobType: "decay_sweep" },
      testDb
    );

    const res = await PATCH(
      jsonReq("PATCH", {
        id: created.id,
        name: "After",
        schedule: "0 5 * * *",
        enabled: false,
      })
    );
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.schedule.name).toBe("After");
    expect(json.schedule.schedule).toBe("0 5 * * *");
    expect(json.schedule.enabled).toBe(false);

    const { syncCognitiveDaemon } = await import("@/lib/daemon/scheduler");
    expect(syncCognitiveDaemon).toHaveBeenCalled();
  });

  it("PATCH requires an id", async () => {
    const res = await PATCH(
      jsonReq("PATCH", { name: "No id", schedule: "* * * * *", jobType: "decay_sweep" })
    );
    expect(res.status).toBe(400);
  });

  it("PATCH returns 404 for unknown ids", async () => {
    const res = await PATCH(
      jsonReq("PATCH", { id: "cron_ghost", enabled: false })
    );
    expect(res.status).toBe(404);
  });

  it("DELETE removes a schedule", async () => {
    const created = await createCronSchedule(
      { name: "Doomed", schedule: "* * * * *", jobType: "decay_sweep" },
      testDb
    );

    const res = await DELETE(
      new Request(
        `http://localhost/api/cron/schedules?id=${encodeURIComponent(created.id)}`,
        { method: "DELETE" }
      )
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deleted.id).toBe(created.id);
    expect(listCronSchedules(testDb)).toHaveLength(3);
  });

  it("DELETE requires the id parameter", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/cron/schedules", { method: "DELETE" })
    );
    expect(res.status).toBe(400);
  });

  it("DELETE returns 404 for unknown ids", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/cron/schedules?id=cron_ghost", {
        method: "DELETE",
      })
    );
    expect(res.status).toBe(404);
  });
});
