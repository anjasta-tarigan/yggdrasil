import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import type { AppDatabase } from "@/db";

let testDb: AppDatabase;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  get defaultDb() {
    return testDb;
  },
}));

import { searchConversationsDb } from "@/lib/chat-service";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  setupFtsAndTriggers(db);
  return drizzle(db, { schema });
}

async function seed(db: AppDatabase) {
  await db.insert(schema.chatSessions).values([
    { id: "s1", title: "SQLite tuning", createdAt: new Date(1000), updatedAt: new Date(3000) },
    { id: "s2", title: "Vector search", createdAt: new Date(2000), updatedAt: new Date(2000) },
  ]);
  await db.insert(schema.chatMessages).values([
    { id: "m1", sessionId: "s1", role: "user", content: "How do I enable WAL mode in SQLite?" },
    { id: "m2", sessionId: "s1", role: "assistant", content: "Use PRAGMA journal_mode=WAL." },
    { id: "m3", sessionId: "s2", role: "user", content: "Explain reciprocal rank fusion." },
  ]);
}

describe("searchConversationsDb", () => {
  beforeEach(() => {
    testDb = freshDb();
  });

  it("finds messages by keyword and returns session context", async () => {
    await seed(testDb);

    const results = await searchConversationsDb("WAL", { limit: 10 }, testDb);

    expect(results.length).toBeGreaterThanOrEqual(1);
    const hit = results.find((r) => r.messageId === "m1")!;
    expect(hit).toBeDefined();
    expect(hit.sessionId).toBe("s1");
    expect(hit.sessionTitle).toBe("SQLite tuning");
    expect(hit.role).toBe("user");
    expect(hit.snippet.toLowerCase()).toContain("wal");
  });

  it("is case-insensitive", async () => {
    await seed(testDb);
    const results = await searchConversationsDb("wal", { limit: 10 }, testDb);
    expect(results.some((r) => r.messageId === "m1")).toBe(true);
  });

  it("returns results ordered by session recency", async () => {
    await seed(testDb);
    const results = await searchConversationsDb("e", { limit: 10 }, testDb);
    // s1 was updated more recently than s2, so its messages rank first.
    const firstSession = results[0]?.sessionId;
    if (results.length > 1) expect(firstSession).toBe("s1");
  });

  it("respects the limit and returns [] for an empty query", async () => {
    await seed(testDb);
    const limited = await searchConversationsDb("e", { limit: 1 }, testDb);
    expect(limited.length).toBeLessThanOrEqual(1);

    expect(await searchConversationsDb("", { limit: 10 }, testDb)).toEqual([]);
    expect(await searchConversationsDb("   ", { limit: 10 }, testDb)).toEqual([]);
  });

  it("treats LIKE wildcards as literal characters", async () => {
    await seed(testDb);
    // "%" must not match everything.
    const results = await searchConversationsDb("%", { limit: 10 }, testDb);
    expect(results).toEqual([]);
  });

  it("excludes messages from an optional session", async () => {
    await seed(testDb);
    const results = await searchConversationsDb(
      "fusion",
      { limit: 10, excludeSessionId: "s2" },
      testDb
    );
    expect(results.every((r) => r.sessionId !== "s2")).toBe(true);
  });
});
