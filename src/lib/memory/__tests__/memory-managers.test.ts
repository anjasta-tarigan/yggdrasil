import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  addWorkingMemory,
  getActiveWorkingMemories,
  deleteWorkingMemory,
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
  let testDb: AppDatabase;

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

  it("deletes working-memory notes by id (forget_note support)", async () => {
    const id = await addWorkingMemory(
      { content: "Deletable note", ttlSeconds: 600 },
      testDb
    );

    expect(await deleteWorkingMemory(id, testDb)).toBe(true);
    expect((await getActiveWorkingMemories(testDb)).length).toBe(0);
    // Deleting again reports no row removed.
    expect(await deleteWorkingMemory(id, testDb)).toBe(false);
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

  it("merges near-duplicate semantic memories instead of inserting copies", async () => {
    const vector = new Float32Array([1, 0, 0, 0]);

    const firstId = await addSemanticMemory(
      {
        content: "User prefers dark mode",
        importance: 0.6,
        tags: ["preference"],
        embedding: vector,
      },
      testDb
    );

    // Same fact re-extracted (identical embedding): must merge, not insert.
    const secondId = await addSemanticMemory(
      {
        content: "User prefers dark mode",
        importance: 0.9,
        tags: ["ui"],
        sources: ["sess_42"],
        embedding: new Float32Array([0.999, 0.001, 0, 0]),
      },
      testDb
    );

    expect(secondId).toBe(firstId);

    const rows = testDb.select().from(schema.semanticMemories).all();
    expect(rows.length).toBe(1);
    expect(rows[0].importance).toBeCloseTo(0.9, 5); // reinforced
    expect(rows[0].tags).toEqual(expect.arrayContaining(["preference", "ui"]));
    expect(rows[0].sources).toContain("sess_42");

    // A genuinely different memory still inserts.
    await addSemanticMemory(
      {
        content: "Project uses SQLite",
        importance: 0.7,
        embedding: new Float32Array([0, 1, 0, 0]), // orthogonal
      },
      testDb
    );
    expect(testDb.select().from(schema.semanticMemories).all().length).toBe(2);
  });

  it("inserts without dedup when no embedding is available", async () => {
    await addSemanticMemory({ content: "Unembedded fact one" }, testDb);
    await addSemanticMemory({ content: "Unembedded fact one" }, testDb);
    // No vectors → dedup is skipped; both rows exist (FTS still finds them).
    expect(testDb.select().from(schema.semanticMemories).all().length).toBe(2);
  });
});
