import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  createProactiveEvent,
  generateProactiveEvents,
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

  describe("generateProactiveEvents (timestamp arithmetic)", () => {
    it("detects a chat session whose last activity is older than 3 days", async () => {
      // Timestamps are stored as epoch SECONDS (integer). Calling
      // strftime('%s', <integer>) returns NULL, so the previous query compared
      // NULL and never matched — proactive events were never emitted at all.
      const staleEpoch = Math.floor(Date.now() / 1000) - 5 * 86400;
      sqlite
        .prepare(
          `INSERT INTO chat_sessions (id, title, created_at, updated_at)
           VALUES ('chat-stale', 'Old conversation', ?, ?)`
        )
        .run(staleEpoch, staleEpoch);

      const result = await generateProactiveEvents(testDb);

      expect(result.created).toBeGreaterThanOrEqual(1);
      const events = await listUnreadEvents({ db: testDb });
      expect(events.some((e) => e.chatId === "chat-stale")).toBe(true);
    });

    it("does not flag a recently active chat session", async () => {
      const freshEpoch = Math.floor(Date.now() / 1000) - 60;
      sqlite
        .prepare(
          `INSERT INTO chat_sessions (id, title, created_at, updated_at)
           VALUES ('chat-fresh', 'Recent conversation', ?, ?)`
        )
        .run(freshEpoch, freshEpoch);

      await generateProactiveEvents(testDb);

      const events = await listUnreadEvents({ db: testDb });
      expect(events.some((e) => e.chatId === "chat-fresh")).toBe(false);
    });

    it("reports consolidation work completed within the last 24h", async () => {
      const recentEpoch = Math.floor(Date.now() / 1000) - 3600;
      sqlite
        .prepare(
          `INSERT INTO semantic_memories (id, content, tags, importance, created_at, updated_at)
           VALUES ('sem-consol', 'Consolidated fact', '["consolidated_memory"]', 0.8, ?, ?)`
        )
        .run(recentEpoch, recentEpoch);

      const result = await generateProactiveEvents(testDb);

      expect(result.created).toBeGreaterThanOrEqual(1);
      const events = await listUnreadEvents({ db: testDb });
      expect(events.some((e) => e.title.includes("maintenance"))).toBe(true);
    });

    it("does not report consolidation work older than 24h", async () => {
      const oldEpoch = Math.floor(Date.now() / 1000) - 3 * 86400;
      sqlite
        .prepare(
          `INSERT INTO semantic_memories (id, content, tags, importance, created_at, updated_at)
           VALUES ('sem-old', 'Old consolidated fact', '["consolidated_memory"]', 0.8, ?, ?)`
        )
        .run(oldEpoch, oldEpoch);

      await generateProactiveEvents(testDb);

      const events = await listUnreadEvents({ db: testDb });
      expect(events.some((e) => e.title.includes("maintenance"))).toBe(false);
    });
  });
});
