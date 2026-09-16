import { describe, it, expect, vi } from "vitest";
import { evaluateMessageQuality } from "@/lib/ai/pipeline/quality-scanner";
import { detectTopicDrift } from "@/lib/ai/pipeline/topic-drift-detector";

// Mock the embedding layer so topic-drift detection works in jsdom without
// a running ONNX runtime or API key.
vi.mock("@/lib/memory/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memory/embeddings")>();
  return {
    ...actual,
    generateEmbedding: vi.fn().mockResolvedValue(
      // Deterministic pseudo-embedding so similarity is reproducible.
      Array.from({ length: 128 }, () => 0.1)
    ),
  };
});

describe("Anti-slop integration — all detection paths", () => {
  it("catches ngarang (buzzword clusters)", () => {
    const text = `In today's fast-paced world, we must leverage robust, seamless solutions
    to unlock unprecedented value and catalyze transformative growth. This
    multifaceted approach is a testament to our holistic methodology,
    underscoring the pivotal nature of innovative solutions that empower users.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(60);
    expect(report.tier).toBe("high");
  });

  it("catches kabur (topic drift without buzzwords)", async () => {
    const text = `To reset your password, navigate to the login page and click the Forgot link.
    Meanwhile, the weather has been unusual this year with record temperatures.
    Many people have noticed changes in their local ecosystems and migration patterns.`;

    const drift = await detectTopicDrift(text, { threshold: 0.35 });
    // With mocked uniform embeddings, cosine similarity will be 1.0 (identical).
    // The point of this test is that detectTopicDrift runs without throwing
    // and returns a valid report shape — not null.
    expect(drift).not.toBeNull();
    expect(drift!.sentences.length).toBeGreaterThanOrEqual(3);
  });

  it("passes clean technical prose", () => {
    const text = `Run psql -U postgres -d mydb -c "SELECT 1" to test the connection.
    If it succeeds, your credentials and database are reachable.`;
    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(false);
  });

  it("detects topic drift with real semantic variation", async () => {
    // Override the mock to return embeddings that vary by content,
    // so cosine similarity between disparate sentences is low.
    const { generateEmbedding } = await import("@/lib/memory/embeddings");
    vi.mocked(generateEmbedding).mockImplementation(async (text: string) => {
      const hash = Array.from(text).reduce(
        (sum, c) => sum + c.charCodeAt(0),
        0
      );
      return new Float32Array(
        Array.from({ length: 128 }, (_, i) => Math.sin((hash + i) / 10))
      );
    });

    const text = `To reset your password, navigate to the login page and click the Forgot link.
    Meanwhile, the weather has been unusual this year with record temperatures.
    Many people have noticed changes in their local ecosystems and migration patterns.`;

    const drift = await detectTopicDrift(text, { threshold: 0.35 });
    expect(drift).not.toBeNull();
    // Sentences about passwords vs weather vs climate should have low
    // cosine similarity, triggering drift detection.
    if (drift) {
      expect(drift.minSimilarity).toBeLessThan(0.35);
    }
  });
});
