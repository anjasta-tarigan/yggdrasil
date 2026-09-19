import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addSemanticMemory } from "../semantic-memory";
import { hybridMemorySearch } from "../search";

vi.mock("../embeddings", () => ({
  generateEmbedding: vi.fn(async () => null),
}));

// This benchmark measures graph *traversal* overhead, not the ONNX reranker.
// The reranker loads a real cross-encoder model when a model file is present
// (it is on a dev machine, and `RERANKER_ENABLED` defaults to true), which
// costs seconds and completely dominates the sub-millisecond traversal cost —
// making the assertion below fail on any machine that has the model installed.
// Force it off so the measurement is deterministic and hardware-independent.
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return { ...actual, env: { ...actual.env, RERANKER_ENABLED: false } };
});

describe("Graph-RAG Benchmark (1000+ Relations)", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  function link(fromId: string, toId: string, type: string, strength = 0.9) {
    sqlite
      .prepare(
        "INSERT INTO memory_relations (id, from_memory_id, from_memory_type, to_memory_id, to_memory_type, relation_type, strength) VALUES (?, ?, 'semantic', ?, 'semantic', ?, ?)"
      )
      .run(`rel_${fromId}_${toId}`, fromId, toId, type, strength);
  }

  it("keeps graph-augmented traversal overhead low on a dense 1000+ relation graph", async () => {
    const seed = await addSemanticMemory({ content: "Benchmark Root Node Query Target" }, testDb, sqlite);
    // Create 40 nodes and 1000+ relations in a dense cluster
    const nodeIds: string[] = [seed];
    for (let i = 1; i <= 40; i++) {
      const id = await addSemanticMemory({ content: `Benchmark Cluster Node ${i}` }, testDb, sqlite);
      nodeIds.push(id);
    }

    sqlite.transaction(() => {
      let relCount = 0;
      for (let i = 0; i < nodeIds.length && relCount < 1000; i++) {
        for (let j = 0; j < nodeIds.length && relCount < 1000; j++) {
          if (i !== j) {
            link(nodeIds[i], nodeIds[j], "associative", 0.75);
            relCount++;
          }
        }
      }
    })();

    const query = "Benchmark Root Node Query Target";

    // Warm both paths so first-call module/JIT cost is not measured.
    await hybridMemorySearch(query, { db: testDb, sqlite, enableGraphAugmentation: false, limit: 50 });
    await hybridMemorySearch(query, { db: testDb, sqlite, enableGraphAugmentation: true, limit: 50 });

    const tBase = performance.now();
    const withoutGraph = await hybridMemorySearch(query, {
      db: testDb,
      sqlite,
      enableGraphAugmentation: false,
      limit: 50,
    });
    const baseDuration = performance.now() - tBase;

    const tGraph = performance.now();
    const withGraph = await hybridMemorySearch(query, {
      db: testDb,
      sqlite,
      enableGraphAugmentation: true,
      limit: 50,
    });
    const graphDuration = performance.now() - tGraph;

    // The 20-candidate ceiling still holds after graph expansion.
    expect(withGraph.length).toBeGreaterThan(0);
    expect(withGraph.length).toBeLessThanOrEqual(21);

    // Graph augmentation may only add the bounded 2-hop expansion (<= 20
    // candidates), never blow up the result set.
    expect(withGraph.length).toBeGreaterThanOrEqual(withoutGraph.length);

    // The actual claim: traversal over a dense 1000+ relation graph is a
    // small additive cost, not a quadratic blow-up. Assert the *overhead*
    // (graph − base) rather than an absolute wall-clock number, which varies
    // by machine and CI load. 100ms is a generous ceiling for the difference
    // between the two paths (typically well under 10ms).
    const overhead = graphDuration - baseDuration;
    expect(overhead).toBeLessThan(100);
  });
});
