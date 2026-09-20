import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  elideStaleToolOutputs,
  estimateModelMessagesTokens,
  evaluateContextGuard,
  HARNESS_CONTEXT_WRAPUP_RATIO,
  HARNESS_ELIDE_TARGET_RATIO,
  HARNESS_ELIDE_TRIGGER_RATIO,
  HARNESS_KEEP_RECENT_FALLBACK_ROUNDS,
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

// --- Adaptive protection of recent rounds (Task 1) ---

describe("evaluateContextGuard adaptive round protection", () => {
  it("never protects fewer than one round (the ladder never reaches 0)", () => {
    expect(HARNESS_KEEP_RECENT_FALLBACK_ROUNDS).toEqual([2, 1]);
    expect(Math.min(...HARNESS_KEEP_RECENT_FALLBACK_ROUNDS)).toBeGreaterThan(0);
    expect(HARNESS_KEEP_RECENT_TOOL_ROUNDS).toBeGreaterThan(
      HARNESS_KEEP_RECENT_FALLBACK_ROUNDS[0]
    );
  });

  it("falls back to fewer protected rounds instead of wrapping up", () => {
    const budget = 20_000;
    const messages: ModelMessage[] = [userMessage("go")];
    // 4 rounds of ~6_000 tokens each: with 4 protected rounds nothing can be
    // elided, so the old fixed-window behaviour would wrap up.
    for (let i = 0; i < 4; i++) {
      messages.push(...toolRound(`r${i}`, "bash", 24_000));
    }

    const decision = evaluateContextGuard({
      messages,
      budgetTokens: budget,
      stepNumber: 3,
    });

    expect(decision.action).toBe("elide");
    if (decision.action !== "elide") return;
    expect(decision.tokensAfter).toBeLessThanOrEqual(
      budget * HARNESS_CONTEXT_WRAPUP_RATIO
    );
    // The two oldest rounds were elided; the two newest are intact.
    const parts = resultParts(decision.messages);
    const elidedIds = parts
      .filter((p) =>
        (p.output as { value?: string }).value?.startsWith(
          "[tool output elided"
        )
      )
      .map((p) => p.toolCallId);
    expect(elidedIds).toEqual(["r0", "r1"]);
    const intactIds = parts
      .filter(
        (p) =>
          !(p.output as { value?: string }).value?.startsWith(
            "[tool output elided"
          )
      )
      .map((p) => p.toolCallId);
    expect(intactIds).toEqual(["r2", "r3"]);
  });

  it("wraps up when even the newest round alone exceeds the wrap-up ratio", () => {
    const budget = 10_000;
    const messages: ModelMessage[] = [userMessage("go")];
    for (let i = 0; i < 3; i++) {
      messages.push(...toolRound(`s${i}`, "bash", 6_000));
    }
    // The newest round is huge and can never be elided.
    messages.push(...toolRound("keep", "bash", 44_000));

    const decision = evaluateContextGuard({
      messages,
      budgetTokens: budget,
      stepNumber: 3,
    });
    expect(decision.action).toBe("wrap-up");

    // Never at step 0.
    const atZero = evaluateContextGuard({
      messages,
      budgetTokens: budget,
      stepNumber: 0,
    });
    expect(atZero.action).not.toBe("wrap-up");

    // The newest round is byte-for-byte intact in whatever messages the guard
    // returns (elide at step 0, or the carried messages on the wrap-up).
    const returned =
      decision.action === "wrap-up" ? decision.messages : undefined;
    const zeroReturned = atZero.action === "elide" ? atZero.messages : undefined;
    const observed = returned ?? zeroReturned;
    expect(observed).toBeDefined();
    expect(observed!.slice(-2)).toEqual(messages.slice(-2));
  });

  it("is idempotent: feeding an elide result back in never re-elides stubs", () => {
    const budget = 20_000;
    const messages: ModelMessage[] = [userMessage("go")];
    for (let i = 0; i < 4; i++) {
      messages.push(...toolRound(`r${i}`, "bash", 24_000));
    }

    const first = evaluateContextGuard({
      messages,
      budgetTokens: budget,
      stepNumber: 3,
    });
    expect(first.action).toBe("elide");
    if (first.action !== "elide") return;

    const second = evaluateContextGuard({
      messages: first.messages,
      budgetTokens: budget,
      stepNumber: 4,
    });
    // Either nothing left to do, or a further-safe (never larger) prompt.
    if (second.action === "none") {
      expect(second).toEqual({ action: "none" });
    } else if (second.action === "elide") {
      expect(second.elidedCount).toBe(0);
      expect(second.tokensAfter).toBeLessThanOrEqual(first.tokensAfter);
    }
    expect(estimateModelMessagesTokens(first.messages)).toBeLessThanOrEqual(
      budget * HARNESS_CONTEXT_WRAPUP_RATIO
    );
  });

  it("leaves all four recent rounds untouched on a comfortable budget", () => {
    const budget = 200_000;
    const messages: ModelMessage[] = [userMessage("go")];
    for (let i = 0; i < 4; i++) {
      messages.push(...toolRound(`r${i}`, "bash", 24_000));
    }

    const decision = evaluateContextGuard({
      messages,
      budgetTokens: budget,
      stepNumber: 3,
    });
    expect(decision.action).toBe("none");
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
    // 3 stale rounds (elidable) followed by one huge round that is protected
    // at every fallback level, so eliding everything elidable still cannot
    // get under 95%.
    for (let i = 0; i < 3; i++) {
      messages.push(...toolRound(`stale${i}`, "bash", 6_000));
    }
    messages.push(...toolRound("keep", "bash", 44_000));

    const total = estimateModelMessagesTokens(messages);
    expect(total).toBeGreaterThan(budget * HARNESS_CONTEXT_WRAPUP_RATIO);

    const decision = evaluateContextGuard({
      messages,
      budgetTokens: budget,
      stepNumber: 3,
    });
    expect(decision.action).toBe("wrap-up");
    // The newest round survived every fallback attempt, byte-for-byte.
    if (decision.action === "wrap-up" && decision.messages) {
      expect(decision.messages.slice(-2)).toEqual(messages.slice(-2));
    }
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
