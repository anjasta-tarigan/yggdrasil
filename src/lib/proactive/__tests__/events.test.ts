import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  createProactiveEvent,
  listUnreadEvents,
  markAllEventsRead,
  markEventRead,
} from "../events";

describe("Proactive events store", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("creates events and lists only unread ones, newest first", async () => {
    const first = await createProactiveEvent(
      { title: "Stretch break", body: "Stand up for a minute" },
      testDb
    );
    const second = await createProactiveEvent(
      { title: "Follow up on deploy", kind: "reminder" },
      testDb
    );

    let unread = await listUnreadEvents({ db: testDb });
    expect(unread.length).toBe(2);
    expect(unread[0].id).toBe(second); // newest first
    expect(unread[1].body).toBe("Stand up for a minute");

    expect(await markEventRead(first, testDb)).toBe(true);
    unread = await listUnreadEvents({ db: testDb });
    expect(unread.length).toBe(1);
    expect(unread[0].id).toBe(second);

    // Marking the same event again reports nothing changed.
    expect(await markEventRead(first, testDb)).toBe(false);
  });

  it("marks all events read in one call", async () => {
    await createProactiveEvent({ title: "One" }, testDb);
    await createProactiveEvent({ title: "Two" }, testDb);

    expect(await markAllEventsRead(testDb)).toBe(2);
    expect((await listUnreadEvents({ db: testDb })).length).toBe(0);
  });

  it("bounds title and body lengths", async () => {
    const id = await createProactiveEvent(
      { title: "t".repeat(500), body: "b".repeat(2000) },
      testDb
    );
    const rows = await testDb.select().from(schema.proactiveEvents);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].title.length).toBeLessThanOrEqual(120);
    expect((rows[0].body ?? "").length).toBeLessThanOrEqual(500);
  });
});
