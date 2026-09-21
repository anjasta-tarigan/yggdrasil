import { describe, it, expect } from "vitest";
import {
  getReasoningProviderOptions,
  extractThinkTags,
  createThinkTagStreamTransformer,
  calculateReasoningOutputBudget,
  reconcileThinkingBudget,
  classifyTaskReasoningEffort,
  resolveRequestedEffort,
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
    const parts: Array<Record<string, unknown>> = [];
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

  describe("classifyTaskReasoningEffort (Proactive & Self-Improving)", () => {
    it("classifies complex concurrency and race conditions as xhigh", () => {
      const tier = classifyTaskReasoningEffort(
        "Analyze potential race conditions and TOCTOU bugs in this transaction lock"
      );
      expect(tier).toBe("xhigh");
    });

    it("classifies mathematical proofs and algorithmic optimization as xhigh", () => {
      const tier = classifyTaskReasoningEffort(
        "Prove convergence for this optimization algorithm using dynamic programming"
      );
      expect(tier).toBe("xhigh");
    });

    it("classifies standard feature development and implementation as high", () => {
      const tier = classifyTaskReasoningEffort(
        "Implement a custom React hook for optimistic mutations with rollback"
      );
      expect(tier).toBe("high");
    });

    it("classifies code reviews and architectural trade-offs as medium", () => {
      const tier = classifyTaskReasoningEffort(
        "Compare Drizzle ORM versus Prisma for high-throughput SQLite"
      );
      expect(tier).toBe("medium");
    });

    it("classifies simple syntax or CSS formatting as low", () => {
      const tier = classifyTaskReasoningEffort(
        "Add a CSS margin-bottom to this button class"
      );
      expect(tier).toBe("low");
    });

    it("classifies casual greetings or direct translations as none", () => {
      const tierGreeting = classifyTaskReasoningEffort("Hello! How are you?");
      expect(tierGreeting).toBe("none");

      const tierTranslate = classifyTaskReasoningEffort(
        "Translate this sentence to French: Good morning"
      );
      expect(tierTranslate).toBe("none");
    });

    it("elevates reasoning tier based on learned procedural rules and preferences (self-improvement)", () => {
      // Normally an explanation query is medium:
      const baseTier = classifyTaskReasoningEffort("Explain how the database pool works");
      expect(baseTier).toBe("medium");

      // With learned rule requiring deep analysis:
      const elevatedTier = classifyTaskReasoningEffort(
        "Explain how the database pool works",
        {
          learnedRules: ["Always use deep reasoning when auditing database connection pools"],
        }
      );
      expect(elevatedTier).toBe("high");
    });

    it("lowers reasoning tier when learned preferences dictate fast response", () => {
      // Normally refactoring is high:
      const baseTier = classifyTaskReasoningEffort("Refactor this small helper function");
      expect(baseTier).toBe("high");

      // With preference for quick concise answers:
      const fastTier = classifyTaskReasoningEffort(
        "Refactor this small helper function",
        {
          userPreferences: ["User prefers fast and concise answers without deep thinking"],
        }
      );
      expect(fastTier).toBe("low");
    });
  });
});

describe("resolveRequestedEffort", () => {
  it("treats a missing request as auto, not as the xhigh ceiling", () => {
    // The Projects client sends no `effort` field at all, so the route fell
    // through to a hardcoded "xhigh" (32k thinking tokens) for every task —
    // the auto-classifier existed but was unreachable from the UI.
    expect(resolveRequestedEffort(undefined)).toEqual({ mode: "auto" });
    expect(resolveRequestedEffort(null)).toEqual({ mode: "auto" });
    expect(resolveRequestedEffort("")).toEqual({ mode: "auto" });
  });

  it("honours an explicit auto", () => {
    expect(resolveRequestedEffort("auto")).toEqual({ mode: "auto" });
  });

  it("honours each explicit tier", () => {
    for (const tier of ["xhigh", "high", "medium", "low", "none"] as const) {
      expect(resolveRequestedEffort(tier)).toEqual({ mode: "fixed", effort: tier });
    }
  });

  it("falls back to auto for an unrecognised value rather than guessing a tier", () => {
    expect(resolveRequestedEffort("maximum")).toEqual({ mode: "auto" });
    expect(resolveRequestedEffort(42)).toEqual({ mode: "auto" });
  });
});
