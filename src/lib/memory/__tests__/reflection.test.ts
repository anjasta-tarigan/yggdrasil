import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addSemanticMemory } from "../semantic-memory";
import {
  shouldReflectOnTurn,
  executeTurnReflection,
  parseReflectionText,
} from "../reflection";

describe("Verbal Reflection & Procedural Rule Extraction", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("filters turns using heuristic cost rules", () => {
    expect(shouldReflectOnTurn("No, you made a mistake with transactions", 1)).toBe(true);
    expect(shouldReflectOnTurn("Actually use Tailwind v4", 1)).toBe(true);
    expect(shouldReflectOnTurn("I prefer dark mode always", 1)).toBe(true);
    expect(shouldReflectOnTurn("Hello there", 1)).toBe(false);
    expect(shouldReflectOnTurn("Hello there", 5)).toBe(true); // 5-turn milestone
  });

  it("extracts procedural mistake-prevention rules and stores in semantic_memories", async () => {
    const mockReflector = vi.fn().mockResolvedValue({
      newFacts: [{ content: "User is building a Next.js app", category: "project_fact", importance: 0.85, tags: ["nextjs"] }],
      correctionDetected: true,
      proceduralRule: {
        situation: "SQLite transactions with better-sqlite3",
        mistake: "Passing async callback to db.transaction()",
        correction: "Always pass synchronous callbacks db.transaction((tx) => ...)",
        tags: ["sqlite", "procedural_rule"],
      },
    });

    await executeTurnReflection(
      {
        sessionId: "s1",
        userPrompt: "No, better-sqlite3 transactions cannot be async!",
        assistantResponse: "I will use async transaction...",
      },
      testDb,
      mockReflector
    );

    const memories = testDb.select().from(schema.semanticMemories).all();
    expect(memories.length).toBe(2);

    const ruleMemory = memories.find((m) => m.content.includes("MISTAKE TO AVOID"));
    expect(ruleMemory).toBeDefined();
    expect(ruleMemory?.tags).toContain("procedural_rule");
  });

  it("supersedes conflicting prior semantic memories when correction is detected", async () => {
    // 1. Existing memory: User lives in Jakarta
    const oldId = await addSemanticMemory(
      {
        content: "User lives in Jakarta and works remotely",
        importance: 0.9,
      },
      testDb
    );

    // 2. User correction: User moved to Bandung
    const mockReflector = vi.fn().mockResolvedValue({
      newFacts: [
        {
          content: "User moved to Bandung and now lives in Bandung",
          category: "user_location",
          importance: 0.95,
          tags: ["location"],
        },
      ],
      correctionDetected: true,
      proceduralRule: null,
    });

    await executeTurnReflection(
      {
        sessionId: "s2",
        userPrompt: "No, actually I moved to Bandung now!",
        assistantResponse: "Got it, I updated your location to Bandung.",
      },
      testDb,
      mockReflector
    );

    // 3. Verify that old memory has been superseded
    const oldMem = testDb
      .select()
      .from(schema.semanticMemories)
      .where(eq(schema.semanticMemories.id, oldId))
      .get();
    expect(oldMem).toBeDefined();
    expect(oldMem?.importance).toBeLessThanOrEqual(0.2);
    const meta = (oldMem?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.superseded).toBe(true);

    // 4. Verify relation exists
    const relation = testDb
      .select()
      .from(schema.memoryRelations)
      .where(eq(schema.memoryRelations.fromMemoryId, oldId))
      .get();
    expect(relation).toBeDefined();
    expect(relation?.relationType).toBe("superseded_by");
  });

  describe("parseReflectionText (structured-output fallback parser)", () => {
    it("parses a clean JSON object", () => {
      const result = parseReflectionText(
        JSON.stringify({
          newFacts: [{ content: "User likes TypeScript", importance: 0.8 }],
          correctionDetected: false,
          proceduralRule: null,
        })
      );
      expect(result.newFacts.length).toBe(1);
      expect(result.newFacts[0].tags).toEqual([]); // schema default applied
      expect(result.correctionDetected).toBe(false);
      expect(result.proceduralRule).toBeNull();
    });

    it("tolerates conversational preambles and markdown fences", () => {
      const result = parseReflectionText(
        'Here is the JSON you asked for:\n```json\n{ "newFacts": [], "correctionDetected": true }\n```'
      );
      expect(result.newFacts).toEqual([]);
      expect(result.correctionDetected).toBe(true);
      expect(result.proceduralRule).toBeNull();
    });

    it("throws a clear error when no JSON object is present", () => {
      expect(() => parseReflectionText("I cannot comply with that request.")).toThrow(
        /No JSON object found/
      );
    });

    it("rejects JSON that violates the reflection schema", () => {
      expect(() =>
        parseReflectionText('{ "newFacts": [{ "importance": 0.5 }], "correctionDetected": false }')
      ).toThrow();
    });
  });
});
