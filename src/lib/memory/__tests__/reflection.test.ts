import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  shouldReflectOnTurn,
  executeTurnReflection,
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
});
