import { describe, it, expect } from "vitest";
import {
  getReasoningProviderOptions,
  extractThinkTags,
  createThinkTagStreamTransformer,
} from "../reasoning";

describe("Reasoning Engine", () => {
  it("maps xhigh reasoning effort to OpenAI and Anthropic provider options", () => {
    const oaiOptions = getReasoningProviderOptions("o3-mini", "xhigh");
    expect(oaiOptions).toMatchObject({
      openai: { reasoningEffort: "high" },
    });

    const claudeOptions = getReasoningProviderOptions("claude-3-7-sonnet-20250219", "xhigh");
    expect(claudeOptions).toMatchObject({
      anthropic: { thinking: { type: "enabled", budgetTokens: 16000 } },
    });
  });

  it("extracts <think> tags from complete text", () => {
    const raw = "<think>Let me analyze the algorithm.</think>Here is the solution.";
    const result = extractThinkTags(raw);
    expect(result.reasoning).toBe("Let me analyze the algorithm.");
    expect(result.text).toBe("Here is the solution.");
  });

  it("transforms split <think> stream chunks into reasoning and text parts", async () => {
    const transformer = createThinkTagStreamTransformer();
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", text: "<th" });
        controller.enqueue({ type: "text-delta", text: "ink>Thinking about code" });
        controller.enqueue({ type: "text-delta", text: "</think>Final output" });
        controller.close();
      },
    });

    const reader = readable.pipeThrough(transformer).getReader();
    const parts: any[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    const reasoningParts = parts.filter((p) => p.type === "reasoning");
    const textParts = parts.filter((p) => p.type === "text-delta");
    expect(reasoningParts.length).toBeGreaterThan(0);
    expect(reasoningParts.map((p) => p.text).join("")).toBe("Thinking about code");
    expect(textParts.map((p) => p.text).join("")).toBe("Final output");
  });
});
