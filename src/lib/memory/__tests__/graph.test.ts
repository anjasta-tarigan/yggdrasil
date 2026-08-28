import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addSemanticMemory } from "../semantic-memory";
import { getKnowledgeGraph } from "../graph";

describe("Knowledge graph extraction", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
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

  it("returns an empty graph for an empty database", async () => {
    const graph = await getKnowledgeGraph({ db: testDb });
    expect(graph.nodes.length).toBe(0);
    expect(graph.edges.length).toBe(0);
    expect(graph.stats.relationCount).toBe(0);
  });

  it("builds nodes and edges from memories and relations", async () => {
    const a = await addSemanticMemory({ content: "Concept A about schemas" }, testDb);
    const b = await addSemanticMemory({ content: "Concept B about tables" }, testDb);
    const c = await addSemanticMemory({ content: "Concept C about indexes" }, testDb);
    link(a, b, "associative_link");
    link(a, c, "associative_link", 0.85);

    const graph = await getKnowledgeGraph({ db: testDb });

    expect(graph.nodes.length).toBe(3);
    expect(graph.edges.length).toBe(2);
    expect(graph.stats.relationCount).toBe(2);
    expect(graph.stats.byRelationType).toEqual({ associative_link: 2 });

    // Hub node A has degree 2 and sorts first among candidates.
    const hub = graph.nodes.find((n) => n.id === a);
    expect(hub?.degree).toBe(2);
    expect(graph.stats.topHubs[0].id).toBe(a);
    expect(graph.truncated).toBe(false);
  });

  it("includes consolidated episodic memories and their edges", async () => {
    sqlite
      .prepare("INSERT INTO chat_sessions (id, title) VALUES (?, ?)")
      .run("s1", "Test chat");
    sqlite
      .prepare(
        "INSERT INTO episodic_memories (id, session_id, content, importance, consolidated_into) VALUES (?, ?, ?, ?, ?)"
      )
      .run("ep1", "s1", "User asked about schemas", 0.5, "sem_target");
    const sem = await addSemanticMemory({ content: "Summary of schema talk" }, testDb);

    sqlite
      .prepare(
        "INSERT INTO memory_relations (id, from_memory_id, from_memory_type, to_memory_id, to_memory_type, relation_type, strength) VALUES (?, ?, 'episodic', ?, 'semantic', ?, ?)"
      )
      .run("rel_cons", "ep1", sem, "consolidated_into", 1);

    const graph = await getKnowledgeGraph({ db: testDb });

    const epNode = graph.nodes.find((n) => n.id === "ep1");
    expect(epNode?.type).toBe("episodic");
    expect(graph.edges.length).toBe(1);
    expect(graph.stats.byRelationType).toEqual({ consolidated_into: 1 });
    // Unconsolidated episodic memories stay out of the graph.
    sqlite
      .prepare(
        "INSERT INTO episodic_memories (id, session_id, content, importance) VALUES (?, ?, ?, ?)"
      )
      .run("ep2", "s1", "Fresh unconsolidated turn", 0.5);
    const graph2 = await getKnowledgeGraph({ db: testDb });
    expect(graph2.nodes.some((n) => n.id === "ep2")).toBe(false);
  });

  it("caps the node count and drops edges to removed nodes", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(
        await addSemanticMemory({ content: `Concept number ${i}` }, testDb)
      );
    }
    // Chain: 0-1, 1-2, ... plus a hub at 0
    for (let i = 0; i < 19; i++) link(ids[i], ids[i + 1], "associative_link");

    const graph = await getKnowledgeGraph({ db: testDb, maxNodes: 10 });

    expect(graph.nodes.length).toBe(10);
    expect(graph.truncated).toBe(true);
    // Every edge must connect two kept nodes.
    const kept = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      expect(kept.has(edge.source)).toBe(true);
      expect(kept.has(edge.target)).toBe(true);
    }
    // Middle-of-chain nodes have degree 2 and survive the cap; the
    // degree-1 tail does not.
    expect(kept.has(ids[1])).toBe(true);
    expect(kept.has(ids[2])).toBe(true);
    expect(kept.has(ids[19])).toBe(false);
  });

  it("truncates long labels", async () => {
    const id = await addSemanticMemory(
      { content: "A very long concept ".repeat(10) },
      testDb
    );
    const graph = await getKnowledgeGraph({ db: testDb });
    const node = graph.nodes.find((n) => n.id === id);
    expect(node).toBeTruthy();
    expect(node!.label.length).toBeLessThanOrEqual(61);
    expect(node!.label.endsWith("…")).toBe(true);
  });
});
