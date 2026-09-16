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
    expect(prompt).toContain("<system_invariants>");
    expect(prompt).toContain("<temporal_anchor>");
    expect(prompt).toContain("<learned_rules_and_mistakes_to_avoid>");
    expect(prompt).toContain("Never use async callbacks");
    expect(prompt).toContain("<user_profile_and_preferences>");
    expect(prompt).toContain("User prefers concise answers");
    expect(prompt).toContain("<cognitive_memory_context>");
    expect(prompt).toContain("Active task: building cognitive loop");
  });

  it("injects model environment when model context is provided", async () => {
    const prompt = await synthesizeSystemPrompt({
      userQuery: "Hello",
      db: testDb,
      sqlite,
      modelContext: {
        modelId: "claude-3-7-sonnet-20250219",
        displayName: "Claude 3.7 Sonnet",
        providerName: "Anthropic",
        contextWindow: 200000,
        maxOutputTokens: 64000,
        supportsReasoning: true,
        supportsToolCalls: true,
      },
    });

    expect(prompt).toContain("<model_environment>");
    expect(prompt).toContain("Active Model: Claude 3.7 Sonnet (id: claude-3-7-sonnet-20250219) via Anthropic");
    expect(prompt).toContain("Context Window: 200,000 tokens");
    expect(prompt).toContain("Max Output: 64,000 tokens");
    expect(prompt).toContain("Reasoning: enabled");
    expect(prompt).toContain("Tool Calling: supported");
    expect(prompt).toContain("</model_environment>");
  });

  it("dynamically conditions tool protocols based on activeTools list", async () => {
    // 1. Only artifact_publish and web_search enabled
    const promptWithArtifactAndSearch = await synthesizeSystemPrompt({
      db: testDb,
      sqlite,
      activeTools: ["artifact_publish", "web_search"],
    });

    expect(promptWithArtifactAndSearch).toContain("Standalone Deliverables & Artifacts ('artifact_publish'):");
    expect(promptWithArtifactAndSearch).toContain("Web Research & Verification ('web_search', 'web_fetch'):");
    expect(promptWithArtifactAndSearch).not.toContain("Real Image Search & Visual Retrieval ('image_search'):");
    expect(promptWithArtifactAndSearch).not.toContain("Workspace & Sandbox Execution ('bash', 'readFile', 'writeFile'):");
    expect(promptWithArtifactAndSearch).not.toContain("Task Planning & Checklists ('task_list_manager'):");

    // 1b. With image_search enabled
    const promptWithImageSearch = await synthesizeSystemPrompt({
      db: testDb,
      sqlite,
      activeTools: ["image_search"],
    });
    expect(promptWithImageSearch).toContain("Real Image Search & Visual Retrieval ('image_search'):");
    expect(promptWithImageSearch).not.toContain("Web Research & Verification ('web_search', 'web_fetch'):");

    // 2. Only sandbox tools enabled
    const promptWithSandbox = await synthesizeSystemPrompt({
      db: testDb,
      sqlite,
      activeTools: ["bash", "readFile"],
    });

    expect(promptWithSandbox).toContain("Workspace & Sandbox Execution ('bash', 'readFile', 'writeFile'):");
    expect(promptWithSandbox).not.toContain("Standalone Deliverables & Artifacts ('artifact_publish'):");
    expect(promptWithSandbox).not.toContain("Web Research & Verification ('web_search', 'web_fetch'):");
  });

  it("anchors temporal reference time correctly", async () => {
    const fixedDate = new Date("2026-09-06T12:00:00.000Z");
    const prompt = await synthesizeSystemPrompt({
      db: testDb,
      sqlite,
      now: fixedDate,
    });

    expect(prompt).toContain("<temporal_anchor>");
    expect(prompt).toContain("Current System Time (UTC): 2026-09-06T12:00:00.000Z");
    expect(prompt).toContain("Current Year: 2026");
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
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeLessThan(15000);
  });

  it("surfaces user preferences stored only in metadata.category, not tags", async () => {
    // Reflection stores the category in metadata, not in tags — the production
    // rows from the live store carry tags like ["arch_linux","setup"] with
    // metadata {"category":"user_preference"}. A tags-only query misses them.
    await addSemanticMemory(
      {
        content: "User runs Arch Linux with Neovim as daily driver.",
        tags: ["arch_linux", "setup"],
        importance: 0.9,
        metadata: { category: "user_preference", extractedFrom: "verbal_reflection" },
      },
      testDb
    );

    const prompt = await synthesizeSystemPrompt({
      userQuery: "What editor setup do I use?",
      db: testDb,
      sqlite,
    });

    expect(prompt).toContain("<user_profile_and_preferences>");
    expect(prompt).toContain("User runs Arch Linux with Neovim");
  });

  it("surfaces project facts and domain knowledge in a dedicated project block", async () => {
    // 58 project_fact + 79 domain_knowledge rows exist in the live store but no
    // query ever retrieves them into the prompt.
    await addSemanticMemory(
      {
        content: "The Yggdrasil project stores memories in SQLite with WAL mode.",
        tags: ["database", "sqlite"],
        importance: 0.9,
        metadata: { category: "project_fact", extractedFrom: "verbal_reflection" },
      },
      testDb
    );
    await addSemanticMemory(
      {
        content: "FTS5 external-content tables need triggers for insert, delete, and content updates.",
        tags: ["sqlite", "fts5"],
        importance: 0.8,
        metadata: { category: "domain_knowledge", extractedFrom: "verbal_reflection" },
      },
      testDb
    );

    const prompt = await synthesizeSystemPrompt({
      userQuery: "How is the project database set up?",
      db: testDb,
      sqlite,
    });

    expect(prompt).toContain("<project_and_domain_knowledge>");
    expect(prompt).toContain("Yggdrasil project stores memories in SQLite");
    expect(prompt).toContain("FTS5 external-content tables");
  });
});
