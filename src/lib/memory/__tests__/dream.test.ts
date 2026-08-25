import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addSemanticMemory } from "../semantic-memory";
import { generateEmbedding } from "../embeddings";
import { runDreamGraphDiscovery } from "../dream";

describe("Dream Cycle Graph Discovery", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });

    const emb1 = new Float32Array([1, 0, 0, 0]);
    const emb2 = new Float32Array([0.95, 0.05, 0, 0]);

    await addSemanticMemory({ content: "Concept A: Drizzle schemas", embedding: emb1 }, testDb);
    await addSemanticMemory({ content: "Concept B: Drizzle tables", embedding: emb2 }, testDb);
  });

  it("creates bounded associative links for similar semantic nodes", async () => {
    const result = await runDreamGraphDiscovery({ similarityThreshold: 0.8, db: testDb });
    expect(result.edgesCreated).toBeGreaterThanOrEqual(1);

    const relations = testDb.select().from(schema.memoryRelations).all();
    expect(relations.length).toBeGreaterThanOrEqual(1);
    expect(relations[0].relationType).toBe("associative_link");
  });
});
