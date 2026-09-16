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

  it("benchmarks dense graph with 1000+ relations ensuring low traversal overhead", async () => {
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

    const start = performance.now();
    const results = await hybridMemorySearch("Benchmark Root Node Query Target", {
      db: testDb,
      sqlite,
      enableGraphAugmentation: true,
      limit: 50,
    });
    const duration = performance.now() - start;

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(21);
    expect(duration).toBeLessThan(50);
  });
});
