import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// The queue must never actually enqueue during service tests.
vi.mock("@/lib/queue/queue", () => ({
  enqueueJob: vi.fn().mockResolvedValue("job_test_enqueue"),
}));

import {
  BUILT_IN_SCHEDULES,
  CronValidationError,
  createCronSchedule,
  deleteCronSchedule,
  describeCronExpressionErrors,
  getNextRunIso,
  isValidCronExpression,
  listCronSchedules,
  runCronScheduleNow,
  updateCronSchedule,
} from "../cron-jobs-service";
import { setSettingsDb } from "@/lib/settings-service";

// settings rows persist across tests inside one in-memory DB; use fresh
// databases per test for isolation.
function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  setupFtsAndTriggers(db);
  return drizzle(db, { schema });
}

describe("cron-jobs-service", () => {
  beforeEach(() => {
    testDb = freshDb();
  });

  describe("listCronSchedules (seeding)", () => {
    it("seeds the 3 built-in schedules on first read", () => {
      const schedules = listCronSchedules(testDb);
      expect(schedules).toHaveLength(3);
      expect(schedules.map((s) => s.jobType).sort()).toEqual([
        "decay_sweep",
        "dream_graph_discovery",
        "sleep_consolidation",
      ]);
      for (const s of schedules) {
        expect(s.enabled).toBe(true);
        expect(s.builtIn).toBe(true);
        expect(isValidCronExpression(s.schedule)).toBe(true);
      }
    });

    it("returns the same rows on subsequent reads (no double seeding)", () => {
      listCronSchedules(testDb);
      const again = listCronSchedules(testDb);
      expect(again).toHaveLength(3);
    });

    it("returns [] when the stored value is not an array", () => {
      
      setSettingsDb({ cronSchedules: "garbage" }, testDb);
      expect(listCronSchedules(testDb)).toEqual([]);
    });

    it("filters out malformed rows but keeps valid ones", () => {
      
      const now = new Date().toISOString();
      setSettingsDb(
        {
          cronSchedules: [
            {
              id: "cron_ok",
              name: "OK",
              schedule: "* * * * *",
              jobType: "decay_sweep",
              enabled: true,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "cron_bad_expr",
              name: "Bad expression",
              schedule: "not cron",
              jobType: "decay_sweep",
              enabled: true,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "cron_bad_type",
              name: "Bad type",
              schedule: "* * * * *",
              jobType: "ingest_turn", // not schedulable
              enabled: true,
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
        testDb
      );
      const schedules = listCronSchedules(testDb);
      expect(schedules).toHaveLength(1);
      expect(schedules[0].id).toBe("cron_ok");
    });
  });

  describe("createCronSchedule", () => {
    it("creates a valid schedule with defaults", async () => {
      const created = await createCronSchedule(
        { name: "Nightly tidy", schedule: "0 4 * * *", jobType: "decay_sweep" },
        testDb
      );
      expect(created.id).toMatch(/^cron_/);
      expect(created.name).toBe("Nightly tidy");
      expect(created.enabled).toBe(true); // default enabled
      expect(created.description).toBeUndefined();

      const all = listCronSchedules(testDb);
      expect(all).toHaveLength(4); // 3 seeded + 1 created
      expect(all.find((s) => s.id === created.id)?.name).toBe("Nightly tidy");
    });

    it("rejects invalid cron expressions", async () => {
      await expect(
        createCronSchedule(
          { name: "Bad", schedule: "61 * * * *", jobType: "decay_sweep" },
          testDb
        )
      ).rejects.toThrow(CronValidationError);
    });

    it("rejects non-schedulable job types", async () => {
      await expect(
        createCronSchedule(
          { name: "Bad", schedule: "* * * * *", jobType: "ingest_turn" as never },
          testDb
        )
      ).rejects.toThrow(CronValidationError);
    });

    it("rejects empty names", async () => {
      await expect(
        createCronSchedule(
          { name: "   ", schedule: "* * * * *", jobType: "decay_sweep" },
          testDb
        )
      ).rejects.toThrow(CronValidationError);
    });
  });

  describe("updateCronSchedule", () => {
    it("updates schedule expression and enabled flag", async () => {
      const seeded = listCronSchedules(testDb);
      const target = seeded.find((s) => s.jobType === "decay_sweep")!;

      const updated = await updateCronSchedule(
        target.id,
        { schedule: "30 5 * * *", enabled: false, name: "Renamed decay" },
        testDb
      );
      expect(updated).not.toBeNull();
      expect(updated!.schedule).toBe("30 5 * * *");
      expect(updated!.enabled).toBe(false);
      expect(updated!.name).toBe("Renamed decay");
      // createdAt preserved, updatedAt bumped
      expect(updated!.createdAt).toBe(target.createdAt);
      expect(updated!.updatedAt >= target.updatedAt).toBe(true);
    });

    it("returns null for unknown ids", async () => {
      expect(
        await updateCronSchedule("cron_nope", { enabled: false }, testDb)
      ).toBeNull();
    });

    it("refuses to save an invalid expression mid-edit", async () => {
      const seeded = listCronSchedules(testDb);
      await expect(
        updateCronSchedule(seeded[0].id, { schedule: "oops" }, testDb)
      ).rejects.toThrow(CronValidationError);
      // ...and leaves the stored row untouched
      const after = listCronSchedules(testDb).find((s) => s.id === seeded[0].id)!;
      expect(after.schedule).toBe(seeded[0].schedule);
    });
  });

  describe("deleteCronSchedule", () => {
    it("deletes a schedule and returns it", () => {
      const seeded = listCronSchedules(testDb);
      const target = seeded[0];
      const removed = deleteCronSchedule(target.id, testDb);
      expect(removed?.id).toBe(target.id);
      expect(listCronSchedules(testDb)).toHaveLength(2);
    });

    it("returns null for unknown ids", () => {
      expect(deleteCronSchedule("cron_nope", testDb)).toBeNull();
    });
  });

  describe("runCronScheduleNow", () => {
    it("enqueues the schedule's job type with metadata", async () => {
      const { enqueueJob } = await import("@/lib/queue/queue");
      const created = await createCronSchedule(
        { name: "Quick sweep", schedule: "* * * * *", jobType: "decay_sweep" },
        testDb
      );

      const jobId = await runCronScheduleNow(created.id, testDb);
      expect(jobId).toBe("job_test_enqueue");
      expect(enqueueJob).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "decay_sweep",
          payload: expect.objectContaining({
            triggeredBy: "manual_pass",
            cronScheduleId: created.id,
            cronScheduleName: "Quick sweep",
          }),
        }),
        testDb
      );
    });

    it("returns null for unknown ids", async () => {
      expect(await runCronScheduleNow("cron_nope", testDb)).toBeNull();
    });
  });

  describe("cron expression helpers", () => {
    it("validates expressions with node-cron", () => {
      expect(isValidCronExpression("*/15 * * * *")).toBe(true);
      expect(isValidCronExpression("0 3 * * *")).toBe(true);
      expect(isValidCronExpression("bad")).toBe(false);
      expect(isValidCronExpression("61 * * * *")).toBe(false);
    });

    it("describes field-level errors", () => {
      const errors = describeCronExpressionErrors("61 * * * *");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/minute/i);
    });

    it("computes the next run time for valid expressions", () => {
      const next = getNextRunIso("*/15 * * * *");
      expect(next).not.toBeNull();
      expect(new Date(next!).getTime()).toBeGreaterThan(Date.now());
    });

    it("returns null for invalid expressions", () => {
      expect(getNextRunIso("nope")).toBeNull();
    });
  });

  describe("MAX_SCHEDULES guard", () => {
    it("refuses to exceed 50 schedules", async () => {
      for (let i = 0; i < 47; i++) {
        await createCronSchedule(
          { name: `Filler ${i}`, schedule: "* * * * *", jobType: "decay_sweep" },
          testDb
        );
      }
      // 3 seeded + 47 = 50
      await expect(
        createCronSchedule(
          { name: "Over limit", schedule: "* * * * *", jobType: "decay_sweep" },
          testDb
        )
      ).rejects.toThrow(/Maximum of 50 schedules reached/);
    }, 30000);
  });
});
