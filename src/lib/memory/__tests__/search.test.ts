import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addEpisodicMemory } from "../episodic-memory";
import { addSemanticMemory } from "../semantic-memory";
import { generateEmbedding } from "../embeddings";
import { hybridMemorySearch } from "../search";

describe("Hybrid Memory Search (FTS5 + Vector + RRF)", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });

    // Seed episodic memory
    const emb1 = await generateEmbedding("Authentication with JWT tokens and security");
    await addEpisodicMemory(
      {
        content: "User configured authentication using JWT and security cookies",
        embedding: emb1,
        importance: 0.8,
      },
      testDb
    );

    // Seed semantic memory
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
});
