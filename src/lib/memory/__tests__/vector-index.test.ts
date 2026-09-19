import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { setupFtsAndTriggers } from "@/db/init";
import {
  syncVectorIndex,
  vectorKnn,
  purgeAllVectorIndexes,
  listVectorIndexTables,
  vectorTableFor,
} from "../vector-index";
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

/** Insert a memory row with a raw float32 vector. */
function insertSemantic(
  sqlite: Database.Database,
  id: string,
  vector: number[]
): number {
  const buf = Buffer.from(new Float32Array(vector).buffer);
  sqlite
    .prepare(
      `INSERT INTO semantic_memories (id, content, embedding, embedding_model, importance)
       VALUES (?, ?, ?, ?, 0.5)`
    )
    .run(id, `content ${id}`, buf, "model-" + vector.length);
  return (
    sqlite
      .prepare("SELECT rowid FROM semantic_memories WHERE id = ?")
      .get(id) as { rowid: number }
  ).rowid;
}

describe("vector-index model-scoped isolation", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
  });

  it.skipIf(!vecLoadable)(
    "namespaces the vec table by embedding model so differing dimensions coexist",
    () => {
      tryLoad(sqlite);

      const tableA = vectorTableFor("semantic", "model-a");
      const tableB = vectorTableFor("semantic", "model-b");
      expect(tableA).not.toBe(tableB);
      expect(tableA).toMatch(/^semantic_memories_vec_/);
    }
  );

  it.skipIf(!vecLoadable)(
    "keeps both a 384-dim and a 4096-dim index live at the same time",
    () => {
      tryLoad(sqlite);

      // Two rows under two different models / dimensions.
      insertSemantic(sqlite, "sem-384", new Array(384).fill(0.1));
      insertSemantic(sqlite, "sem-4096", new Array(4096).fill(0.1));

      expect(syncVectorIndex(sqlite, "semantic", 384, "model-384")).toBe(true);
      expect(syncVectorIndex(sqlite, "semantic", 4096, "model-4096")).toBe(true);

      // Both indexes exist independently — neither dropped the other.
      const tables = listVectorIndexTables(sqlite);
      expect(tables).toContain(vectorTableFor("semantic", "model-384"));
      expect(tables).toContain(vectorTableFor("semantic", "model-4096"));

      // Each KNN returns only its own dimension's rows.
      const hits384 = vectorKnn(sqlite, "semantic", "model-384", new Float32Array(new Array(384).fill(0.1)), 10);
      const hits4096 = vectorKnn(sqlite, "semantic", "model-4096", new Float32Array(new Array(4096).fill(0.1)), 10);

      expect(hits384).toHaveLength(1);
      expect(hits4096).toHaveLength(1);
      expect(hits384[0].rowid).not.toBe(hits4096[0].rowid);
    }
  );

  it.skipIf(!vecLoadable)(
    "purgeAllVectorIndexes removes every vec table and its shadow tables",
    () => {
      tryLoad(sqlite);

      insertSemantic(sqlite, "sem-a", new Array(8).fill(0.1));
      insertSemantic(sqlite, "sem-b", new Array(16).fill(0.1));

      syncVectorIndex(sqlite, "semantic", 8, "model-a");
      syncVectorIndex(sqlite, "semantic", 16, "model-b");
      syncVectorIndex(sqlite, "episodic", 8, "model-a");

      const before = listVectorIndexTables(sqlite);
      expect(before.length).toBeGreaterThanOrEqual(3);

      const purged = purgeAllVectorIndexes(sqlite);
      expect(purged).toBeGreaterThanOrEqual(3);

      // Nothing vector-related remains — not even sqlite-vec's shadow tables.
      const remaining = sqlite
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE name LIKE '%_vec%' AND name NOT LIKE 'sqlite_%'`
        )
        .all() as Array<{ name: string }>;
      expect(remaining).toEqual([]);

      // Base tables and their data survive untouched.
      const rows = sqlite
        .prepare("SELECT COUNT(*) AS n FROM semantic_memories")
        .get() as { n: number };
      expect(rows.n).toBe(2);
    }
  );

  it.skipIf(!vecLoadable)(
    "rebuilds cleanly from the base table after a full purge",
    () => {
      tryLoad(sqlite);

      insertSemantic(sqlite, "sem-rebuild", new Array(8).fill(0.25));
      syncVectorIndex(sqlite, "semantic", 8, "model-a");
      purgeAllVectorIndexes(sqlite);

      // Re-sync repopulates from the base table, not from stale index state.
      expect(syncVectorIndex(sqlite, "semantic", 8, "model-a")).toBe(true);
      const hits = vectorKnn(
        sqlite,
        "semantic",
        "model-a",
        new Float32Array(new Array(8).fill(0.25)),
        10
      );
      expect(hits).toHaveLength(1);
    }
  );

  it.skipIf(!vecLoadable)(
    "does not leave rows from another model's dimension in the index",
    () => {
      tryLoad(sqlite);

      // 8-dim row and a 16-dim row under the same logical slot.
      insertSemantic(sqlite, "only-8", new Array(8).fill(0.1));
      insertSemantic(sqlite, "only-16", new Array(16).fill(0.1));

      // Build the 8-dim index. It must contain exactly the 8-dim row.
      syncVectorIndex(sqlite, "semantic", 8, "model-a");
      const hits = vectorKnn(
        sqlite,
        "semantic",
        "model-a",
        new Float32Array(new Array(8).fill(0.1)),
        10
      );
      expect(hits).toHaveLength(1);

      const wrongDim = sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM ${vectorTableFor("semantic", "model-a")}
           WHERE length(embedding) != 32`
        )
        .get() as { n: number };
      expect(wrongDim.n).toBe(0);
    }
  );

  it("purgeAllVectorIndexes is a no-op when no vec tables exist", () => {
    expect(purgeAllVectorIndexes(sqlite)).toBe(0);
  });
});
