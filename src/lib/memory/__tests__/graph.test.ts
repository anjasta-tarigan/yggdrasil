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

  it("hides superseded memories and their invalidation edges from the graph", async () => {
    // Invalidation bookkeeping (superseded_by) is a backend lifecycle signal,
    // not knowledge to visualize — showing it makes the graph display "facts"
    // the system already knows are wrong.
    const oldId = await addSemanticMemory({ content: "Outdated fact about the old capital" }, testDb);
    const newId = await addSemanticMemory({ content: "Current fact about the new capital" }, testDb);
    const otherId = await addSemanticMemory({ content: "Unrelated stable fact about rivers" }, testDb);
    link(oldId, newId, "superseded_by", 0.95);
    link(newId, otherId, "associative_link", 0.8);

    const graph = await getKnowledgeGraph({ db: testDb });

    const nodeIds = graph.nodes.map((n) => n.id);
    expect(nodeIds).not.toContain(oldId);
    expect(nodeIds).toContain(newId);
    expect(nodeIds).toContain(otherId);
    expect(graph.edges.some((e) => e.relationType === "superseded_by")).toBe(false);
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

  describe("filters", () => {
    beforeEach(async () => {
      // Three semantic + one consolidated episodic, mixed relation types.
      sqlite
        .prepare("INSERT INTO chat_sessions (id, title) VALUES (?, ?)")
        .run("s1", "Test chat");
      sqlite
        .prepare(
          "INSERT INTO episodic_memories (id, session_id, content, importance, consolidated_into, tags) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("ep1", "s1", "User asked about volcanoes", 0.5, "sem_c", '["volcano"]');
      const a = await addSemanticMemory(
        { content: "Volcano monitoring basics", tags: ["volcano", "geology"] },
        testDb
      );
      const b = await addSemanticMemory({ content: "Plain concept B" }, testDb);
      const c = await addSemanticMemory({ content: "Plain concept C" }, testDb);
      // Isolated: no relations, no volcano match — must stay out of
      // search results.
      await addSemanticMemory({ content: "Isolated concept D" }, testDb);
      link(a, b, "associative_link");
      link("ep1", c, "consolidated_into");
    });

    it("relationTypes filter keeps only matching edges and stats narrow", async () => {
      const graph = await getKnowledgeGraph({
        db: testDb,
        filters: { relationTypes: ["associative_link"] },
      });
      expect(graph.edges.every((e) => e.relationType === "associative_link")).toBe(true);
      expect(graph.stats.byRelationType).toEqual({ associative_link: 1 });
      // Global totals stay global for the filter chips.
      expect(graph.stats.relationCount).toBe(2);
    });

    it("nodeTypes filter drops nodes of the other type and their edges", async () => {
      const graph = await getKnowledgeGraph({
        db: testDb,
        filters: { nodeTypes: ["semantic"] },
      });
      expect(graph.nodes.every((n) => n.type === "semantic")).toBe(true);
      const kept = new Set(graph.nodes.map((n) => n.id));
      for (const edge of graph.edges) {
        expect(kept.has(edge.source)).toBe(true);
        expect(kept.has(edge.target)).toBe(true);
      }
    });

    it("search matches labels and tags, pulling in direct neighbors", async () => {
      const graph = await getKnowledgeGraph({
        db: testDb,
        filters: { search: "volcano" },
      });
      // Volcano-tagged/hit nodes plus their linked neighbors.
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.nodes.some((n) => n.label.includes("Volcano"))).toBe(true);
      // The neighbor linked by associative_link is included.
      expect(graph.nodes.some((n) => n.label.includes("Plain concept B"))).toBe(true);
      // An isolated, non-matching node is not.
      expect(graph.nodes.some((n) => n.label.includes("Isolated concept D"))).toBe(false);
    });

    it("a search with no hit returns an empty graph, not the unfiltered top-N", async () => {
      const graph = await getKnowledgeGraph({
        db: testDb,
        filters: { search: "doesnotexistanywhere" },
      });
      expect(graph.nodes).toEqual([]);
      expect(graph.edges).toEqual([]);
      // Stats remain global so chips keep showing real counts.
      expect(graph.stats.semanticCount).toBe(4);
      expect(graph.stats.relationCount).toBe(2);
    });

    it("nodes carry enrichment fields (tags, accessCount, createdAt, topTags stat)", async () => {
      const graph = await getKnowledgeGraph({ db: testDb });
      const volcano = graph.nodes.find((n) => n.label.includes("Volcano"));
      expect(volcano?.tags).toEqual(["volcano", "geology"]);
      expect(volcano?.accessCount).toBe(0);
      expect(volcano?.createdAt).not.toBeNull();
      expect(graph.stats.topTags.some((t) => t.tag === "volcano")).toBe(true);
    });
  });
});
