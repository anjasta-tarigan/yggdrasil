import { describe, it, expect } from "vitest";
import { analyzeAiSlop } from "@/lib/ai/slop-detector";

describe("Real-time AI Slop Analyzer", () => {
  it("returns clean score for direct, concise factual prose", () => {
    const text =
      "To configure SQLite in WAL mode, execute `PRAGMA journal_mode = WAL;`. This enables concurrent readers without blocking writes.";
    const result = analyzeAiSlop(text);

    expect(result.tier).toBe("clean");
    expect(result.score).toBeLessThanOrEqual(15);
    expect(result.detections.tier1Count).toBe(0);
  });

  it("detects tier 1 AI slop buzzwords and scores them appropriately", () => {
    const text =
      "In this multifaceted tapestry of software architecture, we will delve into the intricacies that serve as a testament to our bedrock principles and unleash unprecedented synergy.";
    const result = analyzeAiSlop(text);

    expect(result.detections.tier1Count).toBeGreaterThanOrEqual(3);
    expect(result.detections.tier1Matches).toContain("delve");
    expect(result.detections.tier1Matches).toContain("tapestry");
    expect(result.detections.tier1Matches).toContain("multifaceted");
    expect(result.score).toBeGreaterThanOrEqual(50);
  });

  it("detects structural rhetorical AI patterns like 'it is not just X, it is Y'", () => {
    const text =
      "It's not just a database library, it's a game-changer for your workflow. It is important to note that only time will tell.";
    const result = analyzeAiSlop(text);

    expect(result.detections.structuralCount).toBeGreaterThanOrEqual(2);
    expect(result.score).toBeGreaterThanOrEqual(40);
  });

  it("ignores code blocks during prose slop evaluation", () => {
    const codeSample = `
\`\`\`typescript
// The function delves into the array
function delve() {
  const tapestry = "seamless synergy";
  return tapestry;
}
\`\`\`
Here is the actual implementation above.
`;
    const result = analyzeAiSlop(codeSample);
    // Because the buzzwords are inside fenced code blocks, prose analysis stays clean
    expect(result.tier).toBe("clean");
    expect(result.detections.tier1Count).toBe(0);
  });

  it("identifies sycophantic opening phrases", () => {
    const text =
      "Great question! You raise a really interesting point about distributed systems. Let's delve into this topic.";
    const result = analyzeAiSlop(text);

    expect(result.detections.structuralMatches).toContain("great question (sycophancy)");
    expect(result.detections.structuralMatches).toContain("validating opener");
  });
});
