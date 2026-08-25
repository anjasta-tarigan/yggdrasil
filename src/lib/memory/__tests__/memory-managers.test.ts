import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  addWorkingMemory,
  getActiveWorkingMemories,
} from "../working-memory";
import {
  addEpisodicMemory,
  getEpisodicMemories,
} from "../episodic-memory";
import {
  addSemanticMemory,
  linkMemories,
} from "../semantic-memory";

describe("Memory Managers", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("stores and lazily filters working memory by expiresAt", async () => {
    await addWorkingMemory(
      {
        content: "Active short term note",
        tags: ["temp"],
        ttlSeconds: 60,
      },
      testDb
    );

    await addWorkingMemory(
      {
        content: "Expired short term note",
        tags: ["temp"],
        ttlSeconds: -10, // already expired
      },
      testDb
    );

    const active = await getActiveWorkingMemories(testDb);
    expect(active.length).toBe(1);
    expect(active[0].content).toBe("Active short term note");
  });

  it("creates episodic memories and updates semantic links", async () => {
    const epId = await addEpisodicMemory(
      {
        content: "User requested SQLite integration with Drizzle",
        importance: 0.8,
        tags: ["sqlite", "drizzle"],
      },
      testDb
    );

    const episodes = await getEpisodicMemories({ limit: 10 }, testDb);
    expect(episodes.length).toBe(1);
    expect(episodes[0].id).toBe(epId);

    const semId = await addSemanticMemory(
      {
        content: "The project uses Drizzle ORM on top of better-sqlite3 with WAL mode",
        importance: 0.9,
        tags: ["architecture", "db"],
        sources: [epId],
      },
      testDb
    );

    const linkId = await linkMemories(
      {
        fromMemoryId: epId,
        fromMemoryType: "episodic",
        toMemoryId: semId,
        toMemoryType: "semantic",
        relationType: "consolidated_to",
        strength: 0.95,
      },
      testDb
    );

    expect(linkId).toBeDefined();
  });
});
