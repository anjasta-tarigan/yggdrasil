import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema";
import { setupFtsAndTriggers } from "../init";

describe("Job Queue Schema", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
  });

  it("creates job_queue table with proper columns and index", () => {
    const db = drizzle(sqlite, { schema });

    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("job_queue");

    // Insert a test job
    const now = new Date();
    db.insert(schema.jobQueue)
      .values({
        id: "job_test_1",
        type: "reflect_turn",
        payload: { test: true },
        status: "pending",
        runAt: now,
      })
      .run();

    const [job] = db.select().from(schema.jobQueue).all();
    expect(job.id).toBe("job_test_1");
    expect(job.type).toBe("reflect_turn");
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(3);
    expect(job.payload).toEqual({ test: true });

    // Verify index on status and run_at
    const indices = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as { name: string }[];
    const indexNames = indices.map((i) => i.name);
    expect(indexNames).toContain("idx_job_queue_status_run_at");
  });
});
