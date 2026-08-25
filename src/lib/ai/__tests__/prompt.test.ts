import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addSemanticMemory } from "@/lib/memory/semantic-memory";
import { addWorkingMemory } from "@/lib/memory/working-memory";
import { synthesizeSystemPrompt } from "../prompt";

describe("Dynamic Adaptive Prompt Synthesizer", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });

    // Seed procedural rule
    await addSemanticMemory(
      {
        content: "[MISTAKE TO AVOID in SQLite]: Never use async callbacks in better-sqlite3 transactions.",
        tags: ["procedural_rule", "sqlite"],
        importance: 0.95,
      },
      testDb
    );

    // Seed user preference
    await addSemanticMemory(
      {
        content: "User prefers concise answers and TypeScript with strict mode.",
        tags: ["user_preference", "preference"],
        importance: 0.9,
        metadata: { category: "user_preference" },
      },
      testDb
    );

    // Seed working memory
    await addWorkingMemory(
      {
        content: "Active task: building cognitive loop",
        tags: ["temp"],
      },
      testDb
    );
  });

  it("synthesizes all modular layers with procedural rules and working context", async () => {
    const prompt = await synthesizeSystemPrompt({
      userQuery: "How do I configure SQLite transactions?",
      db: testDb,
      sqlite,
    });

    expect(prompt).toContain("You are Yggdrasil");
    expect(prompt).toContain("<learned_rules_and_mistakes_to_avoid>");
    expect(prompt).toContain("Never use async callbacks");
    expect(prompt).toContain("<user_profile_and_preferences>");
    expect(prompt).toContain("User prefers concise answers");
    expect(prompt).toContain("<cognitive_memory_context>");
    expect(prompt).toContain("Active task: building cognitive loop");
  });

  it("enforces token budgets and cleanly truncates oversized sections", async () => {
    // Add many procedural rules to test truncation
    for (let i = 0; i < 20; i++) {
      await addSemanticMemory(
        {
          content: `[MISTAKE TO AVOID Rule #${i}]: Always adhere to SQLite WAL guidelines and avoid locking issues in step ${i}. ${"Very long repeated text to increase token size. ".repeat(15)}`,
          tags: ["procedural_rule", "sqlite"],
          importance: 0.9,
        },
        testDb
      );
    }

    const prompt = await synthesizeSystemPrompt({
      userQuery: "SQLite WAL guidelines and transactions",
      db: testDb,
      sqlite,
      budgets: {
        baseTokens: 500,
        proceduralTokens: 200, // tight budget
        preferenceTokens: 200,
        contextTokens: 300,
      },
    });

    expect(prompt).toContain("You are Yggdrasil");
    expect(prompt).toContain("<learned_rules_and_mistakes_to_avoid>");
    // Should still contain valid formatted prompt without throwing
    expect(typeof prompt).toBe("string");
    // Ensure overall character/token footprint is bounded
    expect(prompt.length).toBeLessThan(15000);
  });
});
