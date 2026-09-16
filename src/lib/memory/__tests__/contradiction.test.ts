import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addSemanticMemory } from "../semantic-memory";

// Mock embedding generator to control cosine similarities deterministically
vi.mock("../embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings")>();
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => new Float32Array(8).fill(0.1)),
  };
});

describe("Calibrated Passive Semantic Contradiction Detection", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("automatically supersedes conflicting prior preference in the same category", async () => {
    // Prior memory: User prefers tabs for indentation
    const oldId = await addSemanticMemory(
      {
        content: "User prefers tabs for code indentation",
        importance: 0.8,
        tags: ["preference", "user_preference"],
        embedding: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
      },
      testDb,
      sqlite
    );

    // New conflicting memory: User prefers spaces for code indentation
    // Cosine similarity between [1, 0...] and [0.85, 0.52...] is approx 0.85 (in 0.78..0.90 window)
    const newId = await addSemanticMemory(
      {
        content: "User prefers spaces for code indentation",
        importance: 0.9,
        tags: ["preference", "user_preference"],
        embedding: new Float32Array([0.85, 0.52, 0, 0, 0, 0, 0, 0]),
      },
      testDb,
      sqlite
    );

    expect(newId).not.toBe(oldId);

    // Check old memory is superseded
    const [oldRow] = testDb.select().from(schema.semanticMemories).where(eq(schema.semanticMemories.id, oldId)).all();
    expect(oldRow.importance).toBe(0.1);
    expect(oldRow.metadata?.superseded).toBe(true);
    expect(oldRow.metadata?.supersededBy).toBe(newId);

    // Check superseded_by relation was created
    const relations = testDb.select().from(schema.memoryRelations).all();
    const supersededRel = relations.find((r: any) => r.relationType === "superseded_by");
    expect(supersededRel).toBeDefined();
    expect(supersededRel.fromMemoryId).toBe(oldId);
    expect(supersededRel.toMemoryId).toBe(newId);
  });

  it("does NOT supersede facts from different categories even if words overlap", async () => {
    const codePrefId = await addSemanticMemory(
      {
        content: "Prefers dark theme for coding environment",
        importance: 0.8,
        tags: ["coding", "editor_setting"],
        embedding: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
      },
      testDb,
      sqlite
    );

    const photoPrefId = await addSemanticMemory(
      {
        content: "Prefers dark mode for photography portfolio",
        importance: 0.8,
        tags: ["photography", "design_setting"],
        embedding: new Float32Array([0.85, 0.52, 0, 0, 0, 0, 0, 0]),
      },
      testDb,
      sqlite
    );

    const [codeRow] = testDb.select().from(schema.semanticMemories).where(eq(schema.semanticMemories.id, codePrefId)).all();
    expect(codeRow.importance).toBe(0.8);
    expect(codeRow.metadata?.superseded).toBeUndefined();
  });

  it("does NOT supersede when cosine similarity is below the 0.78 threshold", async () => {
    const oldId = await addSemanticMemory(
      {
        content: "User prefers tabs for code indentation",
        importance: 0.8,
        tags: ["preference", "user_preference"],
        embedding: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
      },
      testDb,
      sqlite
    );

    // Cosine similarity ~0.70 (< 0.78 window)
    const newId = await addSemanticMemory(
      {
        content: "User prefers spaces for code indentation",
        importance: 0.9,
        tags: ["preference", "user_preference"],
        embedding: new Float32Array([0.7, 0.714, 0, 0, 0, 0, 0, 0]),
      },
      testDb,
      sqlite
    );

    expect(newId).not.toBe(oldId);
    const [oldRow] = testDb.select().from(schema.semanticMemories).where(eq(schema.semanticMemories.id, oldId)).all();
    expect(oldRow.importance).toBe(0.8);
    expect(oldRow.metadata?.superseded).toBeUndefined();
  });

  it("does NOT supersede uncategorized facts without matching tags", async () => {
    const oldId = await addSemanticMemory(
      {
        content: "User prefers tabs for code indentation",
        importance: 0.8,
        tags: [],
        embedding: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
      },
      testDb,
      sqlite
    );

    const newId = await addSemanticMemory(
      {
        content: "User prefers spaces for code indentation",
        importance: 0.9,
        tags: [],
        embedding: new Float32Array([0.85, 0.52, 0, 0, 0, 0, 0, 0]),
      },
      testDb,
      sqlite
    );

    expect(newId).not.toBe(oldId);
    const [oldRow] = testDb.select().from(schema.semanticMemories).where(eq(schema.semanticMemories.id, oldId)).all();
    expect(oldRow.importance).toBe(0.8);
    expect(oldRow.metadata?.superseded).toBeUndefined();
  });
});
