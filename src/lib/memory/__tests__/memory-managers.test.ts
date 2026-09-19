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
import * as sqliteVecModule from "sqlite-vec";

function tryLoad(sqlite: Database.Database): boolean {
  try {
    sqliteVecModule.load(sqlite);
    return true;
  } catch (err) {
    return false;
  }
}

const vecLoadable = (() => {
  const probe = new Database(":memory:");
  const ok = tryLoad(probe);
  probe.close();
  return ok;
})();

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

  it("deletes working-memory notes by id (memory_note_delete support)", async () => {
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

  it("merges near-duplicates at the 0.90 threshold (e5-small compaction)", async () => {
    // Two summaries of different sessions sharing the same boilerplate prefix.
    // On a 384-dim model these land at ~0.90–0.94 similarity — above the
    // empirical duplicate floor but below the old 0.95 gate, so they used to
    // accumulate as separate rows.
    const firstId = await addSemanticMemory(
      {
        content: "## Key Facts & Preferences\n- User builds a self-hosted local-first assistant",
        importance: 0.7,
        embedding: new Float32Array([1, 0, 0, 0]),
      },
      testDb
    );

    const secondId = await addSemanticMemory(
      {
        content: "### Key Facts & Preferences\n- User is building a local-first AI assistant",
        importance: 0.8,
        embedding: new Float32Array([0.93, 0.368, 0, 0]), // cos ≈ 0.93
      },
      testDb
    );

    expect(secondId).toBe(firstId);
    expect(testDb.select().from(schema.semanticMemories).all().length).toBe(1);
  });

  it("does not merge genuinely distinct memories above the threshold gap", async () => {
    await addSemanticMemory(
      {
        content: "User prefers dark mode",
        importance: 0.6,
        embedding: new Float32Array([1, 0, 0, 0]),
      },
      testDb
    );

    // cos ≈ 0.75 — related topic but a distinct fact; must stay separate.
    await addSemanticMemory(
      {
        content: "Project uses SQLite with WAL",
        importance: 0.7,
        embedding: new Float32Array([0.75, 0.6614, 0, 0]),
      },
      testDb
    );

    expect(testDb.select().from(schema.semanticMemories).all().length).toBe(2);
  });

  it("merges lexically identical memories when no embedding is available", async () => {
    const firstId = await addSemanticMemory(
      { content: "User prefers dark mode in the editor", importance: 0.6 },
      testDb
    );

    // Same fact, different casing/whitespace — no vectors to compare.
    const secondId = await addSemanticMemory(
      { content: "  user prefers   dark mode in the editor  ", importance: 0.9 },
      testDb
    );

    expect(secondId).toBe(firstId);
    const rows = testDb.select().from(schema.semanticMemories).all();
    expect(rows.length).toBe(1);
    expect(rows[0].importance).toBeCloseTo(0.9, 5);
  });

  it("keeps distinct unembedded facts separate", async () => {
    await addSemanticMemory(
      { content: "User prefers dark mode in the editor" },
      testDb
    );
    await addSemanticMemory(
      { content: "Project uses SQLite with WAL mode enabled" },
      testDb
    );
    expect(testDb.select().from(schema.semanticMemories).all().length).toBe(2);
  });

  it("merges a new unembedded fact into an existing embedded duplicate", async () => {
    const firstId = await addSemanticMemory(
      {
        content: "The assistant runs fully offline on the local machine",
        importance: 0.6,
        embedding: new Float32Array([1, 0, 0, 0]),
      },
      testDb
    );

    // Embedding endpoint was down at write time, but the text is the same fact.
    const secondId = await addSemanticMemory(
      { content: "the assistant runs fully offline on the local machine", importance: 0.8 },
      testDb
    );

    expect(secondId).toBe(firstId);
    expect(testDb.select().from(schema.semanticMemories).all().length).toBe(1);
  });

  describe.skipIf(!vecLoadable)("with sqlite-vec loaded (vec0 fast path dedup)", () => {
    beforeEach(() => {
      tryLoad(sqlite);
    });

    it("merges near-duplicate semantic memories via vec0 index fast-path", async () => {
      const vector = new Float32Array([1, 0, 0, 0]);

      const firstId = await addSemanticMemory(
        {
          content: "User prefers light theme",
          importance: 0.5,
          tags: ["ui"],
          embedding: vector,
        },
        testDb,
        sqlite
      );

      // Same fact re-extracted with similarity ~0.999 >= 0.95:
      // must merge into firstId via the vec0 index fast-path
      const secondId = await addSemanticMemory(
        {
          content: "User prefers light theme",
          importance: 0.85,
          tags: ["settings"],
          sources: ["sess_99"],
          embedding: new Float32Array([0.999, 0.001, 0, 0]),
        },
        testDb,
        sqlite
      );

      expect(secondId).toBe(firstId);

      const rows = testDb.select().from(schema.semanticMemories).all();
      expect(rows.length).toBe(1);
      expect(rows[0].importance).toBeCloseTo(0.85, 5);
      expect(rows[0].tags).toEqual(expect.arrayContaining(["ui", "settings"]));
      expect(rows[0].sources).toContain("sess_99");
    });
  });
});
