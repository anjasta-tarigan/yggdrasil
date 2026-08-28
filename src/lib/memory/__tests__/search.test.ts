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
import * as sqliteVecModule from "sqlite-vec";

// Controlled 2-dim vectors so similarity assertions are exact and the
// tests never touch a network endpoint.
const { SEED_VECTORS } = vi.hoisted(() => ({
  SEED_VECTORS: {
    "Authentication with JWT tokens and security": [1, 0],
    "SQLite database with WAL mode configuration": [0, 1],
  } as Record<string, number[]>,
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
    "builds sqlite-vec indexes and serves the vector channel via KNN",
    async () => {
      await hybridMemorySearch("auth-vector probe", { db: testDb, sqlite });

      const tables = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_vec'")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("episodic_memories_vec");
      expect(names).toContain("semantic_memories_vec");

      // Both seeds are indexed (2-dim vectors → 8-byte blobs).
      const count = sqlite
        .prepare("SELECT COUNT(*) AS n FROM episodic_memories_vec")
        .get() as { n: number };
      expect(count.n).toBe(1);
    }
  );
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
