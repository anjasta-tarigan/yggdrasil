import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import type { AppDatabase } from "@/db";
import { POST as POSTReset } from "../maintenance/reset/route";
import { POST as POSTOptimize } from "../maintenance/optimize/route";
import { GET as GETDiagnostics, POST as POSTDiagnostics } from "../maintenance/diagnostics/route";

let sqlite: Database.Database;
let testDb: AppDatabase;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  get defaultDb() {
    return testDb;
  },
  get sqlite() {
    return sqlite;
  },
}));

vi.mock("@/lib/observability/log-store", () => ({
  syslog: vi.fn(),
  queryLogs: vi.fn().mockReturnValue([]),
}));

function seedConversation() {
  testDb
    .insert(schema.chatSessions)
    .values({ id: "cs_1", title: "Hello" })
    .run();
  testDb
    .insert(schema.chatMessages)
    .values({ id: "cm_1", sessionId: "cs_1", role: "user", content: "hi" })
    .run();
  testDb
    .insert(schema.episodicMemories)
    .values({ id: "ep_1", content: "remember this" })
    .run();
  testDb
    .insert(schema.settings)
    .values({ key: "keep_me", value: "preserved" })
    .run();
}

describe("Database maintenance API routes", () => {
  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  describe("POST /api/maintenance/reset", () => {
    it("deletes conversations and memories but preserves settings", async () => {
      seedConversation();

      const res = await POSTReset();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.deleted.chatSessions).toBe(1);
      expect(data.deleted.chatMessages).toBe(1);
      expect(data.deleted.episodicMemories).toBe(1);
      expect(data.message).toMatch(/3 records deleted/);

      const remainingSettings = testDb
        .select()
        .from(schema.settings)
        .all();
      expect(remainingSettings.map((s) => s.key)).toContain("keep_me");
      expect(
        testDb.select().from(schema.chatSessions).all()
      ).toHaveLength(0);
    });

    it("distrusts projects instead of deleting them", async () => {
      testDb
        .insert(schema.projects)
        .values({
          id: "p_1",
          name: "proj",
          directoryPath: "/tmp/proj",
          trusted: true,
          trustedAt: new Date(),
        })
        .run();

      const res = await POSTReset();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.deleted.projectsDistrusted).toBe(1);

      const [project] = testDb.select().from(schema.projects).all();
      expect(project.trusted).toBe(false);
      expect(project.trustedAt).toBeNull();
    });

    it("returns 409 when the database is locked", async () => {
      const busy = new Error("SQLITE_BUSY: database is locked");
      vi.spyOn(testDb, "transaction").mockImplementationOnce(() => {
        throw busy;
      });

      const res = await POSTReset();
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.code).toBe("DB_LOCKED");
    });
  });

  describe("POST /api/maintenance/optimize", () => {
    it("runs PRAGMA optimize without vacuum by default", async () => {
      const res = await POSTOptimize(
        new Request("http://localhost/api/maintenance/optimize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.pragmaOptimize).toBe("completed");
      expect(data.vacuum).toBeUndefined();
    });

    it("runs VACUUM when requested and reports page counts", async () => {
      const res = await POSTOptimize(
        new Request("http://localhost/api/maintenance/optimize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vacuum: true }),
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.vacuum.pagesBefore).toEqual(expect.any(Number));
      expect(data.vacuum.pagesAfter).toEqual(expect.any(Number));
      expect(data.vacuum.recoveredBytes).toEqual(expect.any(Number));
    });

    it("returns 400 on invalid JSON", async () => {
      const res = await POSTOptimize(
        new Request("http://localhost/api/maintenance/optimize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not-json{",
        })
      );
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/maintenance/diagnostics", () => {
    it("returns zeroed metrics when no maintenance has run", async () => {
      const res = await GETDiagnostics();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.metrics).toMatchObject({
        totalOperations: 0,
        slowOperations: 0,
        avgDurationMs: 0,
        maxDurationMs: 0,
      });
    });

    it("aggregates timings from the log store (filter must match syslog scopes)", async () => {
      const { queryLogs } = await import(
        "@/lib/observability/log-store"
      );
      vi.mocked(queryLogs).mockReturnValueOnce([
        {
          id: 1,
          at: new Date().toISOString(),
          level: "info",
          scope: "db",
          message: "PRAGMA optimize completed in 5ms",
        },
        {
          id: 2,
          at: new Date().toISOString(),
          level: "info",
          scope: "db",
          message: "VACUUM completed in 250ms: 100 → 90 pages",
        },
        {
          id: 3,
          at: new Date().toISOString(),
          level: "info",
          scope: "cron",
          message: "unrelated entry",
        },
      ]);

      const res = await GETDiagnostics();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.metrics.totalOperations).toBe(2);
      expect(data.metrics.slowOperations).toBe(1);
      expect(data.metrics.maxDurationMs).toBe(250);
      // The search filter must match bare syslog scopes ("db"), not "[db]".
      const calls = vi.mocked(queryLogs).mock.calls;
      expect(calls[calls.length - 1][0]).toMatchObject({ search: "db" });
      expect((calls[calls.length - 1][0] as { search: string }).search).not.toContain("[");
    });
  });

  describe("POST /api/maintenance/diagnostics", () => {
    it("returns EXPLAIN QUERY PLAN for a SELECT", async () => {
      const res = await POSTDiagnostics(
        new Request("http://localhost/api/maintenance/diagnostics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sql: "SELECT * FROM chat_sessions WHERE id = 'x'",
          }),
        })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.plan)).toBe(true);
    });

    it("rejects non-SELECT statements", async () => {
      for (const sql of [
        "DELETE FROM chat_sessions",
        "DROP TABLE chat_sessions",
        "SELECT 1; DELETE FROM chat_sessions",
        "PRAGMA page_count",
        "WITH x AS (SELECT 1) DELETE FROM chat_sessions",
        "WITH x AS (SELECT 1) UPDATE chat_sessions SET title = 'y'",
      ]) {
        const res = await POSTDiagnostics(
          new Request("http://localhost/api/maintenance/diagnostics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sql }),
          })
        );
        expect(res.status).toBe(400);
        expect((await res.json()).ok).toBe(false);
      }
    });

    it("returns 400 on invalid SQL", async () => {
      const res = await POSTDiagnostics(
        new Request("http://localhost/api/maintenance/diagnostics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT FROM WHERE" }),
        })
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 on invalid JSON", async () => {
      const res = await POSTDiagnostics(
        new Request("http://localhost/api/maintenance/diagnostics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not-json{",
        })
      );
      expect(res.status).toBe(400);
    });
  });
});
