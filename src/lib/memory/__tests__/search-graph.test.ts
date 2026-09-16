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

  it("applies multi-path consensus boosting when multiple seeds link to the same candidate", async () => {
    // Seed 1 and Seed 2 both match the query. Both link to Shared Target X.
    const s1 = await addSemanticMemory({ content: "Alpha Architecture Core Component" }, testDb, sqlite);
    const s2 = await addSemanticMemory({ content: "Alpha Architecture Auxiliary Service" }, testDb, sqlite);
    const x = await addSemanticMemory({ content: "Shared Dependency Database" }, testDb, sqlite);
    const solo = await addSemanticMemory({ content: "Solo Linked Node" }, testDb, sqlite);

    link(s1, x, "associative", 0.9);
    link(s2, x, "associative", 0.9);
    link(s1, solo, "associative", 0.9);

    const results = await hybridMemorySearch("Alpha Architecture", {
      db: testDb,
      sqlite,
      enableGraphAugmentation: true,
      limit: 10,
    });

    const targetX = results.find((r) => r.id === x);
    const targetSolo = results.find((r) => r.id === solo);
    expect(targetX).toBeDefined();
    expect(targetSolo).toBeDefined();
    // X received consensus boost from second seed, so score(X) > score(Solo)
    expect(targetX!.score).toBeGreaterThan(targetSolo!.score);
  });

  it("limits Hop 2 expansion to at most 2 neighbors per Hop 1 node", async () => {
    // Query matches Seed. Seed -> Hop 1.
    // Hop 1 has 5 distinct neighbors.
    // Hop 2 should only expand at most 2 of them even if maxNeighborsPerHit > 2.
    const seed = await addSemanticMemory({ content: "Cluster Entrypoint Seed" }, testDb, sqlite);
    const h1 = await addSemanticMemory({ content: "Hop One Intermediate Gateway" }, testDb, sqlite);
    link(seed, h1, "associative", 0.9);

    const leafTopics = [
      "RabbitMQ message exchange broker topology",
      "Cassandra wide column storage partition layout",
      "Prometheus timeseries metric alert rules",
      "Grafana dashboard visualization panels",
      "Vault encryption transit secrets engine",
    ];

    const hop2Neighbors: string[] = [];
    for (const topic of leafTopics) {
      const neighbor = await addSemanticMemory({ content: topic }, testDb, sqlite);
      link(h1, neighbor, "associative", 0.9);
      hop2Neighbors.push(neighbor);
    }

    const results = await hybridMemorySearch("Cluster Entrypoint Seed", {
      db: testDb,
      sqlite,
      enableGraphAugmentation: true,
      maxGraphNeighborsPerHit: 5, // Request 5, but Hop 2 must enforce Math.min(2, maxNeighborsPerHit)
      limit: 10,
    });

    const resultIds = results.map((r) => r.id);
    expect(resultIds).toContain(seed);
    expect(resultIds).toContain(h1);

    const hop2Found = hop2Neighbors.filter((id) => resultIds.includes(id));
    expect(hop2Found.length).toBe(2);
  });

  it("enforces strict 20-candidate global ceiling with early-exit on Hop 2", async () => {
    const seed = await addSemanticMemory({ content: "Large Graph Root Seed" }, testDb, sqlite);
    // Create 10 distinct Hop 1 nodes
    const h1Topics = [
      "Alpha compiler optimization pass",
      "Beta memory allocator jemalloc",
      "Gamma network socket buffer tuning",
      "Delta disk scheduler blkio cgroup",
      "Epsilon kernel panic crashdump analysis",
      "Zeta systemd service unit sandbox",
      "Eta ebpf packet filter tracing",
      "Theta numa node cpu affinity binding",
      "Iota slab cache kmalloc fragmentation",
      "Kappa page cache writeback dirty ratio",
    ];

    const h1Nodes: string[] = [];
    for (const topic of h1Topics) {
      const node = await addSemanticMemory({ content: topic }, testDb, sqlite);
      link(seed, node, "associative", 0.9);
      h1Nodes.push(node);
    }

    // Each Hop 1 node has 2 distinct Hop 2 leaves (10 * 2 = 20 potential Hop 2 nodes)
    // Total potential graph candidates = 10 (Hop 1) + 20 (Hop 2) = 30 candidates.
    const leafTopics = [
      ["PostgreSQL WAL segment archival", "PostgreSQL vacuum autovacuum thresholds"],
      ["Redis snapshot RDB persistence", "Redis cluster gossip protocol"],
      ["Kafka consumer rebalance protocol", "Kafka log segment retention compaction"],
      ["Kubernetes ingress controller ingressclass", "Kubernetes mutating admission webhook"],
      ["Docker overlay2 storage driver", "Docker container namespace isolation"],
      ["Nginx worker processes event epoll", "Nginx gzip compression buffer size"],
      ["GraphQL AST validation schema directive", "GraphQL dataloader batch request deduplication"],
      ["Elasticsearch index shard allocation filter", "Elasticsearch translog sync interval flush"],
      ["Cassandra compaction strategy leveled", "Cassandra hinted handoff window size"],
      ["Terraform remote state s3 dynamodb lock", "Terraform provider alias multi region deploy"],
    ];

    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 2; j++) {
        const leaf = await addSemanticMemory({ content: leafTopics[i][j] }, testDb, sqlite);
        link(h1Nodes[i], leaf, "associative", 0.9);
      }
    }

    const results = await hybridMemorySearch("Large Graph Root Seed", {
      db: testDb,
      sqlite,
      enableGraphAugmentation: true,
      maxGraphNeighborsPerHit: 10,
      limit: 50,
    });

    // Seed (1) + strictly capped at 20 graph candidates = exactly 21 results
    expect(results.length).toBe(21);
  });

  it("excludes superseded memories from graph expansion in Hop 1 and Hop 2", async () => {
    const seed = await addSemanticMemory({ content: "Configuration Root Target" }, testDb, sqlite);
    const validH1 = await addSemanticMemory({ content: "Valid Active Intermediate Gateway" }, testDb, sqlite);
    const supersededH1 = await addSemanticMemory(
      {
        content: "Outdated Deprecated Intermediate Gateway",
        metadata: { superseded: true },
      },
      testDb,
      sqlite
    );
    const supersededRelH1 = await addSemanticMemory(
      { content: "Superseded via Relation Gateway" },
      testDb,
      sqlite
    );
    const replacement = await addSemanticMemory(
      { content: "New Replacement Gateway" },
      testDb,
      sqlite
    );
    link(supersededRelH1, replacement, "superseded_by", 0.95);

    const leafValid = await addSemanticMemory({ content: "Leaf from Valid Gateway" }, testDb, sqlite);
    const leafInvalid = await addSemanticMemory({ content: "Leaf from Superseded Gateway" }, testDb, sqlite);

    link(seed, validH1, "associative", 0.9);
    link(seed, supersededH1, "associative", 0.9);
    link(seed, supersededRelH1, "associative", 0.9);
    link(validH1, leafValid, "associative", 0.9);
    link(supersededH1, leafInvalid, "associative", 0.9);

    const results = await hybridMemorySearch("Configuration Root Target", {
      db: testDb,
      sqlite,
      enableGraphAugmentation: true,
      limit: 10,
    });

    const resultIds = results.map((r) => r.id);
    expect(resultIds).toContain(seed);
    expect(resultIds).toContain(validH1);
    expect(resultIds).toContain(leafValid);
    expect(resultIds).not.toContain(supersededH1);
    expect(resultIds).not.toContain(supersededRelH1);
    expect(resultIds).not.toContain(leafInvalid);
  });
});
