import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema";
import { setupFtsAndTriggers } from "../init";
import {
  isBusyError,
  resetDatabase,
  runPragmaOptimize,
  runVacuum,
} from "../maintenance";

vi.mock("@/lib/observability/log-store", () => ({
  syslog: vi.fn(),
}));

describe("db/maintenance", () => {
  let sqlite: Database.Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    setupFtsAndTriggers(sqlite);
    db = drizzle(sqlite, { schema });
  });

  it("runPragmaOptimize completes without error", async () => {
    await expect(runPragmaOptimize(sqlite)).resolves.toBeUndefined();
  });

  it("runVacuum reports page counts", async () => {
    const result = await runVacuum(sqlite);
    expect(result.pagesBefore).toBeGreaterThan(0);
    expect(result.pagesAfter).toBeGreaterThan(0);
    expect(result.recoveredBytes).toBeGreaterThanOrEqual(0);
  });

  it("resetDatabase wipes conversation data and distrusts projects", async () => {
    db.insert(schema.chatSessions)
      .values({ id: "cs_1", title: "t" })
      .run();
    db.insert(schema.projects)
      .values({
        id: "p_1",
        name: "proj",
        directoryPath: "/tmp/proj",
        trusted: true,
        trustedAt: new Date(),
      })
      .run();

    const counts = await resetDatabase(db, sqlite);

    expect(counts.chatSessions).toBe(1);
    expect(counts.projectsDistrusted).toBe(1);
    expect(db.select().from(schema.chatSessions).all()).toHaveLength(0);
    const [project] = db.select().from(schema.projects).all();
    expect(project.trusted).toBe(false);
  });

  it("resetDatabase counts only newly-distrusted projects", async () => {
    db.insert(schema.projects)
      .values([
        {
          id: "p_trusted",
          name: "trusted",
          directoryPath: "/tmp/trusted",
          trusted: true,
          trustedAt: new Date(),
        },
        {
          id: "p_plain",
          name: "plain",
          directoryPath: "/tmp/plain",
          trusted: false,
        },
      ])
      .run();

    const counts = await resetDatabase(db, sqlite);

    expect(counts.projectsDistrusted).toBe(1);
    expect(db.select().from(schema.projects).all()).toHaveLength(2);
  });

  it("resetDatabase still throws busy errors for the route to map to 409", async () => {
    const failing = {
      transaction: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    };
    await expect(resetDatabase(failing, sqlite)).rejects.toThrow(
      "SQLITE_BUSY"
    );
  });

  it("isBusyError detects lock errors and ignores others", () => {
    expect(isBusyError(new Error("SQLITE_BUSY: database is locked"))).toBe(
      true
    );
    expect(isBusyError(new Error("database is locked"))).toBe(true);
    expect(isBusyError(new Error("no such table: foo"))).toBe(false);
    expect(isBusyError("plain string")).toBe(false);
  });
});
