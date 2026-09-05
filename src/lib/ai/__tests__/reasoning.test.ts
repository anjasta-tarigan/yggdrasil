import { describe, it, expect } from "vitest";
import {
  getReasoningProviderOptions,
  extractThinkTags,
  createThinkTagStreamTransformer,
  calculateReasoningOutputBudget,
  reconcileThinkingBudget,
  ReasoningEffortTier,
} from "../reasoning";

describe("calculateReasoningOutputBudget & reconcileThinkingBudget", () => {
  const SIZES = [500, 1000, 2048, 4096, 8192, 16384, 32768, 65536, 128000, 1000000];
  const TIERS: ReasoningEffortTier[] = ["none", "low", "medium", "high", "xhigh"];

  it("satisfies universal monotonicity across all modelMaxOutput capacities", () => {
    for (const size of SIZES) {
      const outputs = TIERS.map(
        (t) => calculateReasoningOutputBudget(t, size).requestedOutputTokens
      );
      for (let i = 0; i < outputs.length - 1; i++) {
        expect(outputs[i]).toBeLessThanOrEqual(outputs[i + 1]);
      }
    }
  });

  it("guarantees targetThinking < requestedOutputTokens when thinking is requested", () => {
    for (const size of SIZES) {
      for (const tier of TIERS) {
        if (tier === "none") continue;
        const { targetThinking, requestedOutputTokens } =
          calculateReasoningOutputBudget(tier, size);
        if (targetThinking > 0) {
          expect(targetThinking).toBeLessThan(requestedOutputTokens);
        }
      }
    }
  });

  it("reconciles thinking budget against clamped output and disables thinking if below 1024", () => {
    // Clamped output of 1,400 with targetThinking 3,072
    const reconciled = reconcileThinkingBudget(1400, 3072, "high", "claude-3-7-sonnet");
    expect(reconciled.thinkingEnabled).toBe(false);
    expect(reconciled.finalThinkingBudget).toBe(0);
    expect(reconciled.providerOptions).toEqual({
      anthropic: { thinking: { type: "disabled" } },
    });

    // Adequate output of 16,000 with targetThinking 8,000
    const reconciledOk = reconcileThinkingBudget(16000, 8000, "medium", "claude-3-7-sonnet");
    expect(reconciledOk.thinkingEnabled).toBe(true);
    expect(reconciledOk.finalThinkingBudget).toBe(8000);
    expect(reconciledOk.finalThinkingBudget).toBeLessThan(16000);
    expect(reconciledOk.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } },
    });
  });
});

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
