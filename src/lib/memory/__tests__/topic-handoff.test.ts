import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";

// Controlled 2-dim vectors so cosine similarity is exact and no network is hit.
const { mockGenerateEmbedding, mockAddSemanticMemory } = vi.hoisted(() => ({
  mockGenerateEmbedding: vi.fn(),
  mockAddSemanticMemory: vi.fn(),
}));

vi.mock("../embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings")>();
  return {
    ...actual,
    generateEmbedding: mockGenerateEmbedding,
  };
});

vi.mock("../semantic-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../semantic-memory")>();
  return {
    ...actual,
    addSemanticMemory: mockAddSemanticMemory,
  };
});

import { detectAndMarkTopicShift } from "../topic-handoff";
import { addEpisodicMemory } from "../episodic-memory";

describe("topic handoff detection (fail-loud boundary writes)", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(async () => {
    vi.clearAllMocks();
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });

    // Seed recent episodic context on-topic for the "previous" conversation.
    // Must carry the same sessionId the detector queries by, and the session
    // row must exist to satisfy the FK.
    await testDb.insert(schema.chatSessions).values({
      id: "sess-1",
      title: "Topic Handoff Test Session",
    });

    await addEpisodicMemory(
      {
        sessionId: "sess-1",
        content: "User discussed authentication with JWT tokens at length.",
        embedding: new Float32Array([1, 0]),
        importance: 0.8,
      },
      testDb
    );
  });

  it("reports shifted=false when the boundary marker cannot be persisted", async () => {
    // New message embeds orthogonally to the prior centroid → cosine 0 < 0.35,
    // so a topic shift IS detected. But the boundary write fails.
    mockGenerateEmbedding.mockResolvedValue(new Float32Array([0, 1]));
    mockAddSemanticMemory.mockRejectedValue(new Error("disk full"));

    const result = await detectAndMarkTopicShift(
      "sess-1",
      "Completely unrelated tangent about gardening.",
      { db: testDb, sqlite }
    );

    // The shift was detected (low similarity)…
    expect(result.similarity).toBeLessThan(0.35);
    // …but the marker was NOT written, so we must not claim success.
    expect(result.shifted).toBe(false);
    expect(result.boundaryId).toBeNull();
  });

  it("reports shifted=true with a boundaryId when the marker write succeeds", async () => {
    mockGenerateEmbedding.mockResolvedValue(new Float32Array([0, 1]));
    mockAddSemanticMemory.mockResolvedValue("sem_boundary_123");

    const result = await detectAndMarkTopicShift(
      "sess-1",
      "Completely unrelated tangent about gardening.",
      { db: testDb, sqlite }
    );

    expect(result.shifted).toBe(true);
    expect(result.boundaryId).toBe("sem_boundary_123");
  });

  it("reports shifted=false when the message stays on topic", async () => {
    // Same direction as the prior centroid → cosine 1.0, no shift.
    mockGenerateEmbedding.mockResolvedValue(new Float32Array([1, 0]));

    const result = await detectAndMarkTopicShift(
      "sess-1",
      "Following up on the JWT authentication discussion.",
      { db: testDb, sqlite }
    );

    expect(result.shifted).toBe(false);
    expect(result.boundaryId).toBeNull();
    expect(mockAddSemanticMemory).not.toHaveBeenCalled();
  });
});
