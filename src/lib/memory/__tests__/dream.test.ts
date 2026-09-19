import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addSemanticMemory } from "../semantic-memory";
import { runDreamGraphDiscovery } from "../dream";
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

describe("Dream Cycle Graph Discovery", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });

    // Similar enough for the dream threshold (0.8) but below the semantic
    // near-duplicate merge threshold (0.95), so both nodes stay distinct:
    // cosine([1,0,0,0], [0.9,0.4359,0,0]) ≈ 0.9.
    const emb1 = new Float32Array([1, 0, 0, 0]);
    const emb2 = new Float32Array([0.9, 0.4359, 0, 0]);

    await addSemanticMemory({ content: "Concept A: Drizzle schemas", embedding: emb1 }, testDb);
    await addSemanticMemory({ content: "Concept B: Drizzle tables", embedding: emb2 }, testDb);
  });

  it("creates bounded associative links via the JS pairwise fallback", async () => {
    const result = await runDreamGraphDiscovery({
      similarityThreshold: 0.8,
      db: testDb,
      sqlite,
    });
    expect(result.engine).toBe("js_pairwise");
    expect(result.edgesCreated).toBeGreaterThanOrEqual(1);

    const relations = testDb.select().from(schema.memoryRelations).all();
    expect(relations.length).toBeGreaterThanOrEqual(1);
    expect(relations[0].relationType).toBe("associative_link");
  });

  it("returns no edges when fewer than two embedded nodes exist", async () => {
    sqlite.prepare("DELETE FROM semantic_memories").run();
    const result = await runDreamGraphDiscovery({ db: testDb, sqlite });
    expect(result.edgesCreated).toBe(0);
  });

  describe.skipIf(!vecLoadable)("with sqlite-vec loaded (KNN fast path)", () => {
    beforeEach(() => {
      tryLoad(sqlite);
    });

    it("uses the vec KNN engine and creates the same links", async () => {
      const result = await runDreamGraphDiscovery({
        similarityThreshold: 0.8,
        db: testDb,
        sqlite,
      });
      expect(result.engine).toBe("vec_knn");
      expect(result.skippedMixedDim).toBe(0);
      expect(result.edgesCreated).toBeGreaterThanOrEqual(1);

      const relations = testDb.select().from(schema.memoryRelations).all();
      expect(relations.length).toBeGreaterThanOrEqual(1);
      expect(relations[0].relationType).toBe("associative_link");
    });

    it("is idempotent — a second pass adds no duplicate edges", async () => {
      const first = await runDreamGraphDiscovery({
        similarityThreshold: 0.8,
        db: testDb,
        sqlite,
      });
      const second = await runDreamGraphDiscovery({
        similarityThreshold: 0.8,
        db: testDb,
        sqlite,
      });
      expect(first.edgesCreated).toBeGreaterThanOrEqual(1);
      expect(second.edgesCreated).toBe(0);
    });

    it("processes every embedding dimension, not just the majority one", async () => {
      // A 3-dim outlier alongside two 4-dim nodes. Indexes are namespaced by
      // embedding model, so the outlier gets its own vec table and is no
      // longer skipped while it waits for a backfill.
      await addSemanticMemory(
        { content: "Odd dim concept", embedding: new Float32Array([1, 0, 0]) },
        testDb
      );
      const result = await runDreamGraphDiscovery({
        similarityThreshold: 0.8,
        db: testDb,
        sqlite,
      });
      expect(result.engine).toBe("vec_knn");
      // Nothing is stranded by dimension mismatch.
      expect(result.skippedMixedDim).toBe(0);
      expect(result.edgesCreated).toBeGreaterThanOrEqual(1);
    });
  });
});
