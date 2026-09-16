import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addEpisodicMemory } from "../episodic-memory";
import {
  consolidationSchema,
  defaultFactExtractor,
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

describe("defaultFactExtractor (structured-output fault tolerance)", () => {
  it("recovers facts from free text when structured output returns only text", async () => {
    // Local gateways frequently answer the structured call with plain text
    // ("Invalid JSON response" path). The extractor must still return a
    // usable summary instead of an empty string that consolidates nothing.
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      output: undefined,
      text: "User runs Arch Linux. User prefers Neovim over VSCode.",
      reasoningText: "",
    } as never);

    const output = await defaultFactExtractor(["event one", "event two"]);

    expect(output.summary).toContain("Arch Linux");
    expect(output.extractedFacts.length).toBeGreaterThan(0);
  });

  it("extracts atomic facts from line-oriented free text", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      output: undefined,
      text: "- User runs Arch Linux\n- User prefers Neovim\n- Note: remember that these are durable preferences",
      reasoningText: "",
    } as never);

    const output = await defaultFactExtractor(["event one", "event two"]);

    const contents = output.extractedFacts.map((f) => f.content);
    expect(contents.some((c) => c.includes("Arch Linux"))).toBe(true);
    expect(contents.some((c) => c.includes("Neovim"))).toBe(true);
    // Meta-commentary ("note:", "remember that") is not a fact.
    expect(contents.every((c) => !/^(note|remember)\b/i.test(c))).toBe(true);
  });

  it("returns an empty summary instead of throwing when the model returns nothing", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      output: undefined,
      text: "",
      reasoningText: "",
    } as never);

    const output = await defaultFactExtractor(["event one"]);

    expect(output.summary).toBe("");
    expect(output.extractedFacts).toEqual([]);
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
    // The atomic fact is stored, not the bulk summary — per-fact rows are what
    // deduplication and decay operate on.
    expect(semantics[0].content).toBe("Prefers solarized dark theme");
    expect(semantics[0].tags).toContain("consolidated_memory");
    expect(semantics[0].tags).toContain("preference");
  });

  it("stores one atomic semantic memory per extracted fact instead of one bulk summary", async () => {
    await testDb.insert(schema.chatSessions).values({
      id: "sess_atomic",
      title: "Atomic Facts Session",
    });

    await addEpisodicMemory(
      { sessionId: "sess_atomic", content: "User mentioned using Arch Linux.", importance: 0.7 },
      testDb
    );
    await addEpisodicMemory(
      { sessionId: "sess_atomic", content: "User prefers Neovim over VSCode.", importance: 0.7 },
      testDb
    );

    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      output: {
        summary: "User runs Arch Linux and prefers Neovim.",
        extractedFacts: [
          { content: "User runs Arch Linux", category: "technical_detail", importance: 0.85 },
          { content: "User prefers Neovim over VSCode", category: "preference", importance: 0.9 },
          { content: "User uses a tiling window manager", category: "technical_detail", importance: 0.6 },
        ],
      },
      text: "",
    } as never);

    const result = await consolidateEpisodicMemories({ db: testDb });
    expect(result.consolidatedCount).toBe(2);

    const semantics = await testDb.select().from(schema.semanticMemories).all();
    // One row per fact — not a single 941-char bulk summary.
    expect(semantics.length).toBe(3);
    const contents = semantics.map((s) => s.content).sort();
    expect(contents).toEqual([
      "User prefers Neovim over VSCode",
      "User runs Arch Linux",
      "User uses a tiling window manager",
    ]);
    // No bulk summary row is written.
    expect(semantics.some((s) => s.content.includes("User runs Arch Linux and prefers Neovim"))).toBe(false);
  });

  it("falls back to the summary when the model returns no extracted facts", async () => {
    await testDb.insert(schema.chatSessions).values({
      id: "sess_nofacts",
      title: "No Facts Session",
    });

    await addEpisodicMemory(
      { sessionId: "sess_nofacts", content: "Casual greeting exchange.", importance: 0.5 },
      testDb
    );
    await addEpisodicMemory(
      { sessionId: "sess_nofacts", content: "User said hello back.", importance: 0.5 },
      testDb
    );

    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      output: {
        summary: "A brief greeting exchange with no durable facts.",
        extractedFacts: [],
      },
      text: "",
    } as never);

    await consolidateEpisodicMemories({ db: testDb });

    const semantics = await testDb.select().from(schema.semanticMemories).all();
    expect(semantics.length).toBe(1);
    expect(semantics[0].content).toBe("A brief greeting exchange with no durable facts.");
  });

  it("strips 'Key Facts & Preferences' boilerplate from stored facts", async () => {
    await testDb.insert(schema.chatSessions).values({
      id: "sess_boiler",
      title: "Boilerplate Session",
    });

    await addEpisodicMemory(
      { sessionId: "sess_boiler", content: "User discussed deployment.", importance: 0.6 },
      testDb
    );
    await addEpisodicMemory(
      { sessionId: "sess_boiler", content: "User asked about Docker.", importance: 0.6 },
      testDb
    );

    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      output: {
        summary: "## Key Facts & Preferences\n\n- User deploys with Docker Compose",
        extractedFacts: [
          {
            content: "## Key Facts & Preferences\n\n- User deploys with Docker Compose",
            category: "technical_detail",
            importance: 0.8,
          },
        ],
      },
      text: "",
    } as never);

    await consolidateEpisodicMemories({ db: testDb });

    const semantics = await testDb.select().from(schema.semanticMemories).all();
    expect(semantics.length).toBe(1);
    expect(semantics[0].content).toBe("User deploys with Docker Compose");
    expect(semantics[0].content).not.toContain("Key Facts");
  });
});
