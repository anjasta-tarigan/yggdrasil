import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { setupFtsAndTriggers } from "@/db/init";
import {
  isVectorIndexAvailable,
  syncVectorIndex,
  vectorKnn,
} from "../vector-index";
import * as sqliteVecModule from "sqlite-vec";

function vecBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function tryLoad(sqlite: Database.Database): boolean {
  try {
    sqliteVecModule.load(sqlite);
    return true;
  } catch {
    return false;
  }
}

const vecLoadable = (() => {
  const probe = new Database(":memory:");
  const ok = tryLoad(probe);
  probe.close();
  return ok;
})();

describe("sqlite-vec vector index", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
  });

  it("reports unavailable on connections without the extension", () => {
    expect(isVectorIndexAvailable(sqlite)).toBe(false);
    expect(syncVectorIndex(sqlite, "episodic", 4)).toBe(false);
  });

  describe.skipIf(!vecLoadable)("with sqlite-vec loaded", () => {
    beforeEach(() => {
      expect(tryLoad(sqlite)).toBe(true);
    });

    function insertEpisodic(id: string, vector: number[] | null) {
      sqlite
        .prepare(
          "INSERT INTO episodic_memories (id, content, embedding, importance) VALUES (?, ?, ?, 0.5)"
        )
        .run(id, `content ${id}`, vector ? vecBuffer(vector) : null);
    }

    it("detects availability and builds a cosine index over all rows", () => {
      expect(isVectorIndexAvailable(sqlite)).toBe(true);

      insertEpisodic("a", [1, 0]);
      insertEpisodic("b", [0, 1]);
      insertEpisodic("c", null); // no vector → not indexed

      expect(syncVectorIndex(sqlite, "episodic", 2)).toBe(true);

      const hits = vectorKnn(sqlite, "episodic", new Float32Array([1, 0]), 10);
      expect(hits.length).toBe(2);
      expect(hits[0].distance).toBeCloseTo(0, 5); // identical vector first
      // Cosine metric: orthogonal vector → distance 1.
      expect(hits[1].distance).toBeCloseTo(1, 5);
    });

    it("re-syncs when new rows arrive", () => {
      insertEpisodic("a", [1, 0]);
      syncVectorIndex(sqlite, "episodic", 2);

      insertEpisodic("late", [0.9, 0.1]);
      // Before sync the new row is invisible to KNN…
      let hits = vectorKnn(sqlite, "episodic", new Float32Array([0.9, 0.1]), 5);
      expect(hits.length).toBe(1);

      // …and after sync it is the nearest neighbor.
      syncVectorIndex(sqlite, "episodic", 2);
      hits = vectorKnn(sqlite, "episodic", new Float32Array([0.9, 0.1]), 5);
      expect(hits.length).toBe(2);
      expect(hits[0].distance).toBeCloseTo(0, 5);
    });

    it("rebuilds when pruned rows leave the index stale", () => {
      insertEpisodic("a", [1, 0]);
      insertEpisodic("b", [0, 1]);
      syncVectorIndex(sqlite, "episodic", 2);

      sqlite.prepare("DELETE FROM episodic_memories WHERE id = 'a'").run();
      syncVectorIndex(sqlite, "episodic", 2);

      const count = sqlite
        .prepare("SELECT COUNT(*) AS n FROM episodic_memories_vec")
        .get() as { n: number };
      expect(count.n).toBe(1);
    });

    it("drops and rebuilds the index when the embedding dimension changes", () => {
      insertEpisodic("old2", [1, 0]);
      syncVectorIndex(sqlite, "episodic", 2);

      // Model switch: new rows carry 3-dim vectors.
      insertEpisodic("new3", [1, 0, 0]);
      expect(syncVectorIndex(sqlite, "episodic", 3)).toBe(true);

      // Only the 3-dim row (8-byte → 12-byte blobs) matches the new index.
      const count = sqlite
        .prepare("SELECT COUNT(*) AS n FROM episodic_memories_vec")
        .get() as { n: number };
      expect(count.n).toBe(1);

      const hits = vectorKnn(sqlite, "episodic", new Float32Array([1, 0, 0]), 5);
      expect(hits.length).toBe(1);
      expect(hits[0].distance).toBeCloseTo(0, 5);
    });

    it("keeps episodic and semantic tiers independent", () => {
      insertEpisodic("a", [1, 0]);
      sqlite
        .prepare(
          "INSERT INTO semantic_memories (id, content, embedding, importance) VALUES (?, ?, ?, 0.5)"
        )
        .run("s1", "semantic content", vecBuffer([0, 1]));

      syncVectorIndex(sqlite, "episodic", 2);
      syncVectorIndex(sqlite, "semantic", 2);

      expect(vectorKnn(sqlite, "episodic", new Float32Array([1, 0]), 5).length).toBe(1);
      expect(vectorKnn(sqlite, "semantic", new Float32Array([1, 0]), 5).length).toBe(1);
    });
  });
});
