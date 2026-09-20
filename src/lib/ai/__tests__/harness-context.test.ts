import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  elideStaleToolOutputs,
  estimateModelMessagesTokens,
  evaluateContextGuard,
  HARNESS_CONTEXT_WRAPUP_RATIO,
  HARNESS_ELIDE_TARGET_RATIO,
  HARNESS_ELIDE_TRIGGER_RATIO,
  HARNESS_KEEP_RECENT_TOOL_ROUNDS,
  HARNESS_MIN_ELIDE_TOKENS,
} from "@/lib/ai/harness-context";

// --- Fixtures ---

/** A tool round: an assistant tool-call message plus its tool result. */
function toolRound(
  id: string,
  toolName: string,
  outputSize: number
): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: id,
          toolName,
          input: JSON.stringify({ command: `echo ${id}` }),
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName,
          output: { type: "text", value: "x".repeat(outputSize) },
        },
      ],
    },
  ];
}

function userMessage(text: string): ModelMessage {
  return { role: "user", content: text };
}

/** Collect every tool-call id and every tool-result id in the messages. */
function toolIds(messages: ModelMessage[]) {
  const calls: string[] = [];
  const results: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.push(part.toolCallId);
      if (part.type === "tool-result") results.push(part.toolCallId);
    }
  }
  return { calls, results };
}

/** All tool-result parts in order. */
function resultParts(messages: ModelMessage[]) {
  const parts: Array<{ toolCallId: string; output: unknown }> = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") {
        parts.push({ toolCallId: part.toolCallId, output: part.output });
      }
    }
  }
  return parts;
}

// --- Estimation ---

describe("estimateModelMessagesTokens", () => {
  it("is monotonic in content size", () => {
    const small = estimateModelMessagesTokens([userMessage("hello")]);
    const large = estimateModelMessagesTokens([userMessage("hello".repeat(100))]);
    expect(large).toBeGreaterThan(small);
  });

  it("returns 0 for an empty message list", () => {
    expect(estimateModelMessagesTokens([])).toBe(0);
  });

  it("counts tool output in the estimate", () => {
    const without = estimateModelMessagesTokens([userMessage("hi")]);
    const withTool = estimateModelMessagesTokens([
      userMessage("hi"),
      ...toolRound("c1", "bash", 4_000),
    ]);
    expect(withTool).toBeGreaterThan(without);
  });
});

// --- elideStaleToolOutputs ---

describe("elideStaleToolOutputs", () => {
  it("keeps the last keepRecentRounds rounds byte-for-byte identical", () => {
    const messages: ModelMessage[] = [userMessage("do work")];
    for (let i = 0; i < 8; i++) {
      messages.push(...toolRound(`c${i}`, "bash", 8_000));
    }

    const keep = HARNESS_KEEP_RECENT_TOOL_ROUNDS;
    const { messages: out } = elideStaleToolOutputs(messages, {
      keepRecentRounds: keep,
      targetTokens: 1,
    });

    // The trailing 2*keep messages (assistant + tool per round) are untouched.
    const tailBefore = messages.slice(-keep * 2);
    const tailAfter = out.slice(-keep * 2);
    expect(tailAfter).toEqual(tailBefore);
  });

  it("never removes a tool-call or tool-result part (no orphaned pairs)", () => {
    const messages: ModelMessage[] = [userMessage("go")];
    for (let i = 0; i < 10; i++) {
      messages.push(...toolRound(`c${i}`, "bash", 6_000));
    }

    const { messages: out } = elideStaleToolOutputs(messages, {
      keepRecentRounds: 2,
      targetTokens: 1,
    });

    const before = toolIds(messages);
    const after = toolIds(out);
    expect(after.calls).toEqual(before.calls);
    expect(after.results).toEqual(before.results);
    expect(after.calls.length).toBe(after.results.length);
  });

  it("replaces only outputs of at least HARNESS_MIN_ELIDE_TOKENS", () => {
    const tiny = "y".repeat(40); // ~10 tokens, below the minimum
    const big = "x".repeat(4_000); // ~1000 tokens
    const messages: ModelMessage[] = [
      userMessage("go"),
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tiny", toolName: "bash", input: "{}" },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tiny",
            toolName: "bash",
            output: { type: "text", value: tiny },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "big", toolName: "bash", input: "{}" },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "big",
            toolName: "bash",
            output: { type: "text", value: big },
          },
        ],
      },
    ];

    const { messages: out, elidedCount } = elideStaleToolOutputs(messages, {
      keepRecentRounds: 0,
      targetTokens: 1,
    });

    const parts = resultParts(out);
    expect(elidedCount).toBe(1);
    // tiny kept verbatim
    expect((parts[0].output as { value: string }).value).toBe(tiny);
    // big replaced by the stub
    expect((parts[1].output as { value: string }).value).toMatch(
      /^\[tool output elided to save context: ~\d+ tokens\. Re-run the tool if you still need it\.\]$/
    );
    expect(estimateModelMessagesTokens([userMessage(big)])).toBeGreaterThan(
      HARNESS_MIN_ELIDE_TOKENS
    );
  });

  it("is idempotent", () => {
    const messages: ModelMessage[] = [userMessage("go")];
    for (let i = 0; i < 6; i++) {
      messages.push(...toolRound(`c${i}`, "bash", 6_000));
    }

    const first = elideStaleToolOutputs(messages, {
      keepRecentRounds: 1,
      targetTokens: 1,
    });
    const second = elideStaleToolOutputs(first.messages, {
      keepRecentRounds: 1,
      targetTokens: 1,
    });

    expect(second.messages).toEqual(first.messages);
    expect(second.elidedCount).toBe(0);
  });

  it("stops once at or below targetTokens", () => {
    const messages: ModelMessage[] = [userMessage("go")];
    for (let i = 0; i < 10; i++) {
      messages.push(...toolRound(`c${i}`, "bash", 8_000));
    }

    const target = 2_000;
    const { messages: out, tokensAfter } = elideStaleToolOutputs(messages, {
      keepRecentRounds: 0,
      targetTokens: target,
    });

    expect(tokensAfter).toBeLessThanOrEqual(target);
    // And it did not need to elide everything to get there.
    const untouched = resultParts(out).filter((p) =>
      (p.output as { value?: string }).value?.startsWith("[tool output elided")
    );
    expect(untouched.length).toBeGreaterThan(0);
  });

  it("leaves non-tool messages and execution-denied outputs untouched", () => {
    const messages: ModelMessage[] = [
      userMessage("keep me"),
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "d1", toolName: "bash", input: "{}" },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "d1",
            toolName: "bash",
            output: { type: "execution-denied", reason: "user said no" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "d2", toolName: "bash", input: "{}" },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "d2",
            toolName: "bash",
            output: { type: "text", value: "z".repeat(9_000) },
          },
        ],
      },
    ];

    const { messages: out } = elideStaleToolOutputs(messages, {
      keepRecentRounds: 0,
      targetTokens: 1,
    });

    expect(out[0]).toEqual(messages[0]);
    const parts = resultParts(out);
    expect(parts[0].output).toEqual({
      type: "execution-denied",
      reason: "user said no",
    });
    expect((parts[1].output as { value: string }).value).toContain(
      "tool output elided"
    );
  });
});

// --- Reasoning pruning counts as a change (Task 0) ---

/**
 * A tool round whose assistant message carries a large reasoning part plus a
 * tiny tool result — the shape produced at `effort: "xhigh"`.
 */
function reasoningRound(id: string, reasoningSize: number): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "r".repeat(reasoningSize) },
        {
          type: "tool-call",
          toolCallId: id,
          toolName: "bash",
          input: JSON.stringify({ command: `echo ${id}` }),
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "bash",
          output: { type: "text", value: "ok" },
        },
      ],
    },
  ];
}

/** Three stale reasoning rounds and no elidable tool output. */
function staleReasoningHistory(): ModelMessage[] {
  const messages: ModelMessage[] = [userMessage("go")];
  for (let i = 0; i < 3; i++) {
    messages.push(...reasoningRound(`c${i}`, 40_000));
  }
  return messages;
}

describe("evaluateContextGuard reasoning pruning", () => {
  it("returns elide (not none) when pruning stale reasoning is the only change", () => {
    const messages = staleReasoningHistory();
    const estimated = estimateModelMessagesTokens(messages);
    // ~90% of the budget: above the trigger, and nothing to elide.
    const budget = Math.round(estimated / 0.9);

    const decision = evaluateContextGuard({
      messages,
      budgetTokens: budget,
      stepNumber: 2,
    });

    expect(decision.action).toBe("elide");
    if (decision.action !== "elide") return;
    expect(decision.elidedCount).toBe(0);
    expect(decision.prunedReasoning).toBe(true);
    // tokensBefore is measured BEFORE reasoning pruning.
    expect(decision.tokensBefore).toBe(estimated);
    expect(decision.tokensAfter).toBeLessThan(estimated / 2);
    expect(estimateModelMessagesTokens(decision.messages)).toBe(
      decision.tokensAfter
    );
  });

  it("returns elide at ~98% of the budget instead of none", () => {
    const messages = staleReasoningHistory();
    const estimated = estimateModelMessagesTokens(messages);
    const budget = Math.round(estimated / 0.98);

    const decision = evaluateContextGuard({
      messages,
      budgetTokens: budget,
      stepNumber: 2,
    });

    expect(decision.action).toBe("elide");
    if (decision.action !== "elide") return;
    // The returned prompt is safe: at or below the wrap-up ratio.
    expect(decision.tokensAfter).toBeLessThanOrEqual(
      budget * HARNESS_CONTEXT_WRAPUP_RATIO
    );
    expect(decision.prunedReasoning).toBe(true);
  });

  it("preserves the last message's reasoning", () => {
    const messages: ModelMessage[] = [userMessage("go")];
    for (let i = 0; i < 2; i++) {
      messages.push(...reasoningRound(`x${i}`, 40_000));
    }
    // The newest assistant turn carries the reasoning a provider may require
    // for tool continuity.
    messages.push({
      role: "assistant",
      content: [
        { type: "reasoning", text: "LASTREASONING".repeat(400) },
        { type: "text", text: "done" },
      ],
    });

    const estimated = estimateModelMessagesTokens(messages);
    const budget = Math.round(estimated / 0.9);

    const decision = evaluateContextGuard({
      messages,
      budgetTokens: budget,
      stepNumber: 2,
    });

    expect(decision.action).toBe("elide");
    if (decision.action !== "elide") return;
    const serialized = JSON.stringify(decision.messages);
    expect(serialized).toContain("LASTREASONING");
    // Old reasoning was pruned.
    expect(serialized).not.toContain("r".repeat(1_000));
  });
});

// --- evaluateContextGuard ---

describe("evaluateContextGuard", () => {
  const budget = 10_000;

  it("returns none below the trigger ratio", () => {
    const messages = [userMessage("small")];
    expect(
      evaluateContextGuard({ messages, budgetTokens: budget, stepNumber: 1 })
    ).toEqual({ action: "none" });
    expect(estimateModelMessagesTokens(messages)).toBeLessThanOrEqual(
      budget * HARNESS_ELIDE_TRIGGER_RATIO
    );
  });

  it("returns elide between the trigger and the wrap-up ratio", () => {
    const messages: ModelMessage[] = [userMessage("go")];
    // ~9000 tokens of tool output: above 80% (8000) but below 95% (9500).
    for (let i = 0; i < 8; i++) {
      messages.push(...toolRound(`c${i}`, "bash", 4_500));
    }
    const before = estimateModelMessagesTokens(messages);
    expect(before).toBeGreaterThan(budget * HARNESS_ELIDE_TRIGGER_RATIO);

    const decision = evaluateContextGuard({
      messages,
      budgetTokens: budget,
      stepNumber: 2,
    });
    expect(decision.action).toBe("elide");
    if (decision.action === "elide") {
      expect(decision.tokensAfter).toBeLessThanOrEqual(
        budget * HARNESS_ELIDE_TARGET_RATIO
      );
      expect(decision.elidedCount).toBeGreaterThan(0);
    }
  });

  it("returns wrap-up above the wrap-up ratio when stepNumber > 0", () => {
    const messages: ModelMessage[] = [userMessage("go")];
    // Keep the last round intact and huge, so eliding stale output cannot
    // get under 95%.
    messages.push(...toolRound("keep", "bash", 44_000));
    for (let i = 0; i < 3; i++) {
      messages.push(...toolRound(`stale${i}`, "bash", 6_000));
    }
    // Reorder so the huge round is last (it is already last).
    const total = estimateModelMessagesTokens(messages);
    expect(total).toBeGreaterThan(budget * HARNESS_CONTEXT_WRAPUP_RATIO);

    const decision = evaluateContextGuard({
      messages,
      budgetTokens: budget,
      stepNumber: 3,
    });
    expect(decision.action).toBe("wrap-up");
  });

  it("never returns wrap-up at step 0", () => {
    const messages: ModelMessage[] = [userMessage("go")];
    messages.push(...toolRound("keep", "bash", 60_000));

    const decision = evaluateContextGuard({
      messages,
      budgetTokens: budget,
      stepNumber: 0,
    });
    expect(decision.action).not.toBe("wrap-up");
  });
});
