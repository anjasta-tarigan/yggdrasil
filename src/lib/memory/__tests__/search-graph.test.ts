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

describe("Deep Multi-Hop Graph-RAG (2-Hop Expansion)", () => {
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

  it("expands to 2nd-degree neighbors through associative chaining with exponential damping", async () => {
    // A -> B -> C chain. Query matches A.
    const a = await addSemanticMemory({ content: "PostgreSQL connection pooling configuration" }, testDb, sqlite);
    const b = await addSemanticMemory({ content: "PgBouncer microservice deployment setup" }, testDb, sqlite);
    const c = await addSemanticMemory({ content: "Transaction max client timeout threshold constraint" }, testDb, sqlite);

    link(a, b, "associative_link", 0.9);
    link(b, c, "associative_link", 0.85);

    const results = await hybridMemorySearch("PostgreSQL connection", {
      db: testDb,
      sqlite,
      enableGraphAugmentation: true,
      limit: 10,
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b); // Hop 1
    expect(ids).toContain(c); // Hop 2

    const scoreA = results.find((r) => r.id === a)!.score;
    const scoreB = results.find((r) => r.id === b)!.score;
    const scoreC = results.find((r) => r.id === c)!.score;

    // Direct > Hop 1 > Hop 2
    expect(scoreA).toBeGreaterThan(scoreB);
    expect(scoreB).toBeGreaterThan(scoreC);
  });

  it("halts expansion when total graph candidate ceiling (20) is reached", async () => {
    const seed = await addSemanticMemory({ content: "Primary seed topic" }, testDb, sqlite);
    // Create 25 related nodes
    for (let i = 0; i < 25; i++) {
      const neighbor = await addSemanticMemory({ content: `Connected node ${i}` }, testDb, sqlite);
      link(seed, neighbor, "associative_link", 0.9);
    }

    const results = await hybridMemorySearch("Primary seed", {
      db: testDb,
      sqlite,
      enableGraphAugmentation: true,
      limit: 50,
    });

    // Seed (1) + graph candidates capped at 20 = max 21
    expect(results.length).toBeLessThanOrEqual(21);
  });

  it("handles cyclic relations (A <-> B <-> C <-> A) without infinite recursion", async () => {
    const a = await addSemanticMemory({ content: "Cyclic node Alpha" }, testDb, sqlite);
    const b = await addSemanticMemory({ content: "Cyclic node Beta" }, testDb, sqlite);
    const c = await addSemanticMemory({ content: "Cyclic node Gamma" }, testDb, sqlite);

    link(a, b, "associative_link", 0.9);
    link(b, c, "associative_link", 0.9);
    link(c, a, "associative_link", 0.9);

    const results = await hybridMemorySearch("Cyclic node Alpha", {
      db: testDb,
      sqlite,
      enableGraphAugmentation: true,
    });

    expect(results.length).toBe(3);
  });

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
