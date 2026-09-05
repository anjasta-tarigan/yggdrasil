import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addEpisodicMemory } from "../episodic-memory";
import {
  consolidationSchema,
  defaultSummarizer,
  consolidateEpisodicMemories,
} from "../consolidation";

vi.mock("../embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings")>();
  return {
    ...actual,
    generateEmbedding: vi.fn(async (text: string) => {
      const v = new Float32Array(8);
      for (let i = 0; i < v.length; i++) v[i] = Math.sin(text.length + i + 1);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    }),
  };
});

// Mock generateText from "ai"
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

vi.mock("@/lib/ai/provider", () => ({
  getDefaultModel: vi.fn(async () => ({ modelId: "test-model" })),
}));

describe("consolidationSchema and defaultSummarizer", () => {
  it("validates structured consolidation output against consolidationSchema", () => {
    const validData = {
      summary: "User prefers TypeScript and uses Drizzle ORM with SQLite.",
      extractedFacts: [
        {
          content: "Prefers TypeScript for type safety",
          category: "preference",
          importance: 0.9,
        },
        {
          content: "Uses Drizzle ORM with SQLite for persistence",
          category: "fact",
          importance: 0.85,
        },
      ],
    };

    const parsed = consolidationSchema.safeParse(validData);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.summary).toBe(validData.summary);
      expect(parsed.data.extractedFacts).toHaveLength(2);
    }
  });

  it("fails validation if importance is out of [0, 1] range or fields are missing", () => {
    const invalidData = {
      summary: "Invalid importance fact",
      extractedFacts: [
        {
          content: "Broken importance",
          category: "test",
          importance: 1.5,
        },
      ],
    };

    const parsed = consolidationSchema.safeParse(invalidData);
    expect(parsed.success).toBe(false);
  });

  it("uses generateText with Output.object and returns structured summary", async () => {
    const { generateText } = await import("ai");
    const mockOutput = {
      summary: "User is building Yggdrasil cognitive loop.",
      extractedFacts: [
        {
          content: "Building Yggdrasil project",
          category: "project",
          importance: 0.9,
        },
      ],
    };

    vi.mocked(generateText).mockResolvedValueOnce({
      output: mockOutput,
      text: JSON.stringify(mockOutput),
    } as never);

    const result = await defaultSummarizer([
      "User started working on Yggdrasil",
      "Yggdrasil implements autonomous cognitive memory",
    ]);

    expect(result).toBe("User is building Yggdrasil cognitive loop.");
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.anything(),
        system: expect.stringContaining("memory consolidation assistant"),
      })
    );
  });

  it("falls back gracefully to text when output is not structured or empty", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      output: undefined,
      text: "Fallback summary string extracted from plain text response.",
    } as never);

    const result = await defaultSummarizer([
      "Event 1",
      "Event 2",
    ]);

    expect(result).toBe("Fallback summary string extracted from plain text response.");
  });
});

describe("consolidateEpisodicMemories integration", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("consolidates episodic memories in a session using custom or default summarizer", async () => {
    // Create the chat session first to satisfy SQLite foreign key constraint
    await testDb.insert(schema.chatSessions).values({
      id: "sess_test",
      title: "Test Session",
    });

    await addEpisodicMemory(
      {
        sessionId: "sess_test",
        content: "User likes dark mode and high contrast.",
        importance: 0.8,
      },
      testDb
    );
    await addEpisodicMemory(
      {
        sessionId: "sess_test",
        content: "User requested solarized dark theme.",
        importance: 0.7,
      },
      testDb
    );

    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      output: {
        summary: "User prefers dark themes, specifically solarized dark.",
        extractedFacts: [
          {
            content: "Prefers solarized dark theme",
            category: "preference",
            importance: 0.85,
          },
        ],
      },
      text: "",
    } as never);

    const result = await consolidateEpisodicMemories({
      db: testDb,
    });

    expect(result.consolidatedCount).toBe(2);
    expect(result.createdSemanticId).toBeTruthy();

    const semantics = await testDb.select().from(schema.semanticMemories);
    expect(semantics.length).toBe(1);
    expect(semantics[0].content).toBe("User prefers dark themes, specifically solarized dark.");
    expect(semantics[0].tags).toContain("consolidated_memory");
  });
});
