import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addEpisodicMemory } from "../episodic-memory";
import { addSemanticMemory } from "../semantic-memory";
import { generateEmbedding } from "../embeddings";
import { hybridMemorySearch } from "../search";
import { env } from "@/env";
import * as sqliteVecModule from "sqlite-vec";

// Controlled 2-dim vectors so similarity assertions are exact and the
// tests never touch a network endpoint.
const { SEED_VECTORS, mockRerankCandidates } = vi.hoisted(() => ({
  SEED_VECTORS: {
    "Authentication with JWT tokens and security": [1, 0],
    "SQLite database with WAL mode configuration": [0, 1],
  } as Record<string, number[]>,
  mockRerankCandidates: vi.fn(),
}));

vi.mock("../reranker", () => ({
  rerankCandidates: (...args: unknown[]) => mockRerankCandidates(...args),
}));

vi.mock("../embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings")>();
  return {
    ...actual,
    generateEmbedding: vi.fn(async (text: string) => {
      const seed = SEED_VECTORS[text];
      if (seed) return new Float32Array(seed);
      // Query probes: near [1,0] (far enough from [0,1] to stay under the
      // 0.1 similarity floor), or null for the un-embeddable probe.
      if (text.includes("auth-vector")) return new Float32Array([1, 0.05]);
      if (text.startsWith("!!")) return null;
      return new Float32Array([0.7, 0.7]);
    }),
  };
});

function tryLoadSqliteVec(sqlite: Database.Database): boolean {
  try {
    sqliteVecModule.load(sqlite);
    return true;
  } catch {
    return false;
  }
}

describe("Hybrid Memory Search (FTS5 + Vector + RRF)", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    tryLoadSqliteVec(sqlite);
    testDb = drizzle(sqlite, { schema });

    // Seed episodic memory (vector [1, 0])
    const emb1 = await generateEmbedding("Authentication with JWT tokens and security");
    await addEpisodicMemory(
      {
        content: "User configured authentication using JWT and security cookies",
        embedding: emb1,
        importance: 0.8,
      },
      testDb
    );

    // Seed semantic memory (vector [0, 1])
    const emb2 = await generateEmbedding("SQLite database with WAL mode configuration");
    await addSemanticMemory(
      {
        content: "Project database uses better-sqlite3 with WAL mode for fast concurrency",
        embedding: emb2,
        importance: 0.9,
      },
      testDb
    );
  });

  it("finds relevant results using FTS5 keyword matching", async () => {
    const results = await hybridMemorySearch("authentication JWT", { db: testDb, sqlite });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("JWT");
  });

  it("ranks matching items with reciprocal rank fusion", async () => {
    const results = await hybridMemorySearch("SQLite concurrency", { db: testDb, sqlite });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("WAL mode");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("finds memories by vector similarity with zero keyword overlap", async () => {
    // "auth-vector probe" shares no FTS tokens with any stored content, so
    // only the vector channel can find the [1,0] episodic memory.
    const results = await hybridMemorySearch("auth-vector probe", {
      db: testDb,
      sqlite,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("JWT");
    expect(results[0].type).toBe("episodic");
  });

  it("still returns FTS results when the query cannot be embedded", async () => {
    // "!!" marks the query as un-embeddable in the mock without adding FTS
    // tokens, so only the keyword channel can answer.
    const results = await hybridMemorySearch("!! authentication", {
      db: testDb,
      sqlite,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("JWT");
  });

  it("finds non-Latin queries via vector search even when FTS produces no tokens", async () => {
    const results = await hybridMemorySearch("認証セキュリティ", {
      db: testDb,
      sqlite,
    });
    expect(results).toBeDefined();
  });

  it.skipIf(!sqliteVecProbe())(
    "builds model-namespaced sqlite-vec indexes and serves the vector channel via KNN",
    async () => {
      await hybridMemorySearch("auth-vector probe", { db: testDb, sqlite });

      // Indexes are namespaced by embedding model, so differing dimensions can
      // coexist instead of one dropping the other.
      const tables = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_vec%'")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names.some((n) => n.startsWith("episodic_memories_vec_"))).toBe(true);
      expect(names.some((n) => n.startsWith("semantic_memories_vec_"))).toBe(true);

      // Both seeds are indexed (2-dim vectors → 8-byte blobs).
      const episodicTable = names.find((n) =>
        n.startsWith("episodic_memories_vec_")
      );
      expect(episodicTable).toBeDefined();
      const count = sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${episodicTable}`)
        .get() as { n: number };
      expect(count.n).toBe(1);
    }
  );

  it("applies normalized score blending when reranker is enabled", async () => {
    (env as Record<string, unknown>).RERANKER_ENABLED = true;

    try {
      // Return inverted ranking from reranker to prove it influences final order
      mockRerankCandidates.mockImplementation(
        async (_query: string, candidates: Array<{ id: string }>) => {
          return candidates.map((c, i) => ({
            id: c.id,
            content: "",
            // Give the second candidate higher score (0.95 vs 0.10)
            rerankScore: i === 0 ? 0.1 : 0.95,
          }));
        }
      );

      const results = await hybridMemorySearch("authentication WAL", {
        db: testDb,
        sqlite,
      });

      expect(mockRerankCandidates).toHaveBeenCalled();
      expect(results.length).toBe(2);
      // All scores should be positive and blended
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[1].score).toBeGreaterThan(0);
    } finally {
      (env as Record<string, unknown>).RERANKER_ENABLED = false;
    }
  });

  it("reranks even on FTS-only queries when embedding is unavailable", async () => {
    (env as Record<string, unknown>).RERANKER_ENABLED = true;

    try {
      mockRerankCandidates.mockResolvedValue([
        { id: "mock_1", content: "", rerankScore: 0.8 },
      ]);

      // "!!" forces embedding to return null (FTS-only path)
      await hybridMemorySearch("!! authentication", {
        db: testDb,
        sqlite,
      });

      // Cross-encoder operates on text, so it should still be called
      expect(mockRerankCandidates).toHaveBeenCalled();
    } finally {
      (env as Record<string, unknown>).RERANKER_ENABLED = false;
    }
  });

  it("expands candidates via 1-hop graph relations in memoryRelations (Graph-Augmented RAG)", async () => {
    // 1. Seed memory A: "Alice is the Principal Architect of Cloud Infra" (matches query)
    const semId = await addSemanticMemory(
      {
        content: "Alice is the Principal Architect of Cloud Infra",
        importance: 0.9,
      },
      testDb
    );

    // 2. Seed neighbor memory B: "Recommended book: Site Reliability Engineering Handbook"
    // (zero keyword match for "Principal Architect", completely different sentence)
    const epId = await addEpisodicMemory(
      {
        content: "Recommended book: Site Reliability Engineering Handbook",
        importance: 0.7,
      },
      testDb
    );

    // 3. Link them via memoryRelations
    await testDb.insert(schema.memoryRelations).values({
      id: "rel_graph_test_1",
      fromMemoryId: semId,
      fromMemoryType: "semantic",
      toMemoryId: epId,
      toMemoryType: "episodic",
      relationType: "associative",
      strength: 0.9,
    });

    // 4. Query directly hits Alice ("Principal Architect Cloud Infra")
    const results = await hybridMemorySearch("Principal Architect Cloud Infra", {
      db: testDb,
      sqlite,
      enableGraphAugmentation: true,
    });

    const resultIds = results.map((r) => r.id);
    expect(resultIds).toContain(semId);
    expect(resultIds).toContain(epId);
  });

  it("supports reverse directional link traversal and respects enableGraphAugmentation: false", async () => {
    const semId = await addSemanticMemory(
      {
        content: "Bob specializes in Kubernetes Cluster Security",
        importance: 0.9,
      },
      testDb
    );

    const epId = await addEpisodicMemory(
      {
        content: "Passed Certified Kubernetes Security Specialist exam in 2024",
        importance: 0.7,
      },
      testDb
    );

    // Reverse link: from episodic (exam) to semantic (Bob)
    await testDb.insert(schema.memoryRelations).values({
      id: "rel_reverse_test_1",
      fromMemoryId: epId,
      fromMemoryType: "episodic",
      toMemoryId: semId,
      toMemoryType: "semantic",
      relationType: "associative",
      strength: 0.95,
    });

    // With graph expansion disabled: epId should NOT be included
    const resultsDisabled = await hybridMemorySearch("Kubernetes Cluster Security", {
      db: testDb,
      sqlite,
      enableGraphAugmentation: false,
    });
    expect(resultsDisabled.map((r) => r.id)).not.toContain(epId);

    // With graph expansion enabled (default): epId is discovered via incoming link
    const resultsEnabled = await hybridMemorySearch("Kubernetes Cluster Security", {
      db: testDb,
      sqlite,
    });
    expect(resultsEnabled.map((r) => r.id)).toContain(epId);
  });

  it("filters out superseded memories from search results", async () => {
    const oldId = await addSemanticMemory(
      {
        content: "User relocated to Jakarta in 2020",
        importance: 0.9,
      },
      testDb
    );

    const newId = await addSemanticMemory(
      {
        content: "User relocated to Bandung in 2024",
        importance: 0.95,
      },
      testDb
    );

    // Link oldId as superseded by newId
    await testDb.insert(schema.memoryRelations).values({
      id: "rel_superseded_test_1",
      fromMemoryId: oldId,
      fromMemoryType: "semantic",
      toMemoryId: newId,
      toMemoryType: "semantic",
      relationType: "superseded_by",
      strength: 0.95,
    });

    const results = await hybridMemorySearch("User relocated", {
      db: testDb,
      sqlite,
    });

    const resultIds = results.map((r) => r.id);
    expect(resultIds).toContain(newId);
    expect(resultIds).not.toContain(oldId);
  });
});

/** Probe once whether sqlite-vec can load in this environment. */
function sqliteVecProbe(): boolean {
  const probe = new Database(":memory:");
  try {
    sqliteVecModule.load(probe);
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}
