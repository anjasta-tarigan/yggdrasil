import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultTurnReflector } from "../reflection";

vi.mock("@/lib/ai/provider", () => ({
  getDefaultModel: vi.fn(async () => ({ modelId: "test-model" })),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

describe("defaultTurnReflector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns output directly when primary Output.object path succeeds", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      output: {
        newFacts: [{ content: "User likes TypeScript", category: "user_preference", importance: 0.9, tags: ["ts"] }],
        correctionDetected: false,
        proceduralRule: null,
      },
    } as never);

    const result = await defaultTurnReflector({
      sessionId: "s1",
      userPrompt: "I like TypeScript",
      assistantResponse: "Great!",
    });

    expect(result.newFacts).toHaveLength(1);
    expect(result.newFacts[0].content).toBe("User likes TypeScript");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("falls back to free-text parsing when Output.object fails with text output", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText)
      .mockRejectedValueOnce(new Error("Structured output failed"))
      .mockResolvedValueOnce({
        text: JSON.stringify({
          newFacts: [{ content: "User uses Next.js", category: "project_fact", importance: 0.8, tags: ["next"] }],
          correctionDetected: true,
          proceduralRule: null,
        }),
      } as never);

    const result = await defaultTurnReflector({
      sessionId: "s1",
      userPrompt: "Use Next.js instead",
      assistantResponse: "Switching to Next.js",
    });

    expect(result.correctionDetected).toBe(true);
    expect(result.newFacts[0].content).toBe("User uses Next.js");
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("falls back to reasoningText when Output.object fails and text is empty", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText)
      .mockRejectedValueOnce(new Error("Structured output failed"))
      .mockResolvedValueOnce({
        text: "",
        reasoningText: JSON.stringify({
          newFacts: [{ content: "User prefers dark mode", category: "user_preference", importance: 0.95, tags: ["ui"] }],
          correctionDetected: false,
          proceduralRule: null,
        }),
      } as never);

    const result = await defaultTurnReflector({
      sessionId: "s1",
      userPrompt: "Always use dark mode",
      assistantResponse: "Dark mode set",
    });

    expect(result.newFacts).toHaveLength(1);
    expect(result.newFacts[0].content).toBe("User prefers dark mode");
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("propagates error when both structured and free-text extraction fail", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText)
      .mockRejectedValueOnce(new Error("Structured output failed"))
      .mockResolvedValueOnce({
        text: "I am unable to answer in JSON format.",
        reasoningText: "Thinking...",
      } as never);

    await expect(
      defaultTurnReflector({
        sessionId: "s1",
        userPrompt: "Hello",
        assistantResponse: "Hi",
      })
    ).rejects.toThrow(/No JSON object found/);
  });
});
