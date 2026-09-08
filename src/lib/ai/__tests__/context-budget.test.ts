import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  estimateMessageTokens,
  pruneMessagesToTokenBudget,
  calculateContextTokenBudget,
  compactAndPruneMessages,
} from "../context-budget";

function msg(
  role: "user" | "assistant" | "system",
  text: string,
  id?: string
): UIMessage {
  return {
    id: id ?? `${role}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    parts: [{ type: "text", text }],
  };
}

describe("Context-window guard", () => {
  it("estimates tokens from text parts (~4 chars/token)", () => {
    expect(estimateMessageTokens(msg("user", "a".repeat(400)))).toBe(100);
    // Non-text parts get a flat allowance instead of being free.
    const withFile: UIMessage = {
      id: "f",
      role: "user",
      parts: [{ type: "file", mediaType: "image/png", url: "data:..." }],
    };
    expect(estimateMessageTokens(withFile)).toBeGreaterThan(0);
  });

  it("leaves conversations under the budget untouched", () => {
    const messages = [msg("user", "hello"), msg("assistant", "hi there")];
    const result = pruneMessagesToTokenBudget(messages, 10_000);
    expect(result.droppedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("keeps the newest messages and drops the oldest over budget", () => {
    const messages: UIMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(msg("user", `question ${i} `.repeat(50))); // ~250 tokens
      messages.push(msg("assistant", `answer ${i} `.repeat(50)));
    }
    // Budget fits roughly the last few turns only.
    const result = pruneMessagesToTokenBudget(messages, 1_500);

    expect(result.droppedCount).toBeGreaterThan(0);
    const last = result.messages[result.messages.length - 1];
    expect(last.parts[0]).toMatchObject({ text: expect.stringContaining("answer 19") });
    // The truncation note is prepended as text inside the first kept user
    // message (AI SDK v7 rejects system-role UIMessages in messages).
    expect(result.messages[0].role).toBe("user");
    expect((result.messages[0].parts[0] as { text: string }).text).toContain(
      "truncated"
    );
  });

  it("never starts the kept slice on an assistant message", () => {
    const messages = [
      msg("user", "old ".repeat(400)),
      msg("assistant", "stale reply ".repeat(400)),
      msg("user", "recent question"),
      msg("assistant", "recent answer"),
    ];
    const result = pruneMessagesToTokenBudget(messages, 300);
    expect(result.droppedCount).toBeGreaterThan(0);
    const firstKept = result.messages.find((m) => m.role !== "system");
    expect(firstKept?.role).toBe("user");
  });

  it("always keeps at least the final message even if it alone exceeds budget", () => {
    const huge = [msg("user", "x".repeat(100_000))];
    const result = pruneMessagesToTokenBudget(huge, 10);
    expect(result.droppedCount).toBe(0);
    expect(result.messages.length).toBe(1);
  });

  it("exposes a sane default budget", () => {
    expect(DEFAULT_CONTEXT_TOKEN_BUDGET).toBeGreaterThan(1_000);
  });
});

describe("calculateContextTokenBudget", () => {
  const WINDOWS = [4_000, 8_000, 16_000, 24_000, 32_000, 64_000, 128_000, 400_000, 1_000_000];

  it("strictly guarantees budgetTokens + effectiveMaxOutputTokens + effectiveSystemTokens <= effectiveWindow", () => {
    for (const w of WINDOWS) {
      for (const reqOutput of [2_000, 4_000, 8_000, 16_000, 32_000, 64_000]) {
        const res = calculateContextTokenBudget({
          contextWindow: w,
          requestedOutputTokens: reqOutput,
          systemAndToolsTokens: 4_000,
        });
        const total = res.budgetTokens + res.effectiveMaxOutputTokens + res.effectiveSystemTokens;
        expect(total).toBeLessThanOrEqual(res.effectiveWindow);
        expect(res.budgetTokens).toBeGreaterThanOrEqual(1_000);
      }
    }
  });

  it("falls back to conservative 24k window when contextWindow is null or 0 (honest unknown)", () => {
    const res = calculateContextTokenBudget({
      contextWindow: null,
      requestedOutputTokens: 4_000,
    });
    expect(res.isFallback).toBe(true);
    expect(res.effectiveWindow).toBe(24_000);
  });

  it("clamps effectiveMaxOutputTokens proportionally on small context windows", () => {
    const res = calculateContextTokenBudget({
      contextWindow: 16_000,
      requestedOutputTokens: 64_000,
      systemAndToolsTokens: 4_000,
    });
    expect(res.effectiveMaxOutputTokens).toBeLessThan(16_000);
    expect(res.effectiveMaxOutputTokens).toBe(5_600); // 35% of 16k
    expect(res.budgetTokens).toBe(7_200); // 16k - 5600 - 3200
    expect(res.budgetTokens + res.effectiveMaxOutputTokens + 3_200).toBe(16_000);
  });
});

describe("compactAndPruneMessages", () => {
  it("preserves tool-call and tool-result atomicity across the pruning boundary", () => {
    const toolCallMsg: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "test" } } as never],
    };
    const toolResultMsg: UIMessage = {
      id: "u2",
      role: "user",
      parts: [{ type: "tool-result", toolCallId: "c1", toolName: "search", output: { result: "ok" } } as never],
    };
    const recentUser: UIMessage = {
      id: "u3",
      role: "user",
      parts: [{ type: "text", text: "latest question" }],
    };

    const messages = [msg("user", "very old ".repeat(500)), toolCallMsg, toolResultMsg, recentUser];
    const res = compactAndPruneMessages(messages, 400);

    // If toolCall is dropped, toolResult must also be dropped; or both kept
    const hasCall = res.messages.some((m) => m.id === "a1");
    const hasResult = res.messages.some((m) => m.id === "u2");
    expect(hasCall).toBe(hasResult);
  });

  it("caps hierarchical summary to 1500 tokens across successive compactions", () => {
    const messagesWithExistingSummary: UIMessage[] = [
      msg("user", "[Conversation Summary:\n- Old point 1\n- Old point 2]\n\nFollow-up question"),
      msg("assistant", "Response ".repeat(300)),
      msg("user", "New question ".repeat(300)),
    ];
    const res = compactAndPruneMessages(messagesWithExistingSummary, 300);
    const text = (res.messages[0].parts[0] as { text: string }).text;
    expect(text).toContain("[Conversation Summary:");
    expect(text.length).toBeLessThan(6000); // 1500 tokens * 4 chars
  });

  it("produces [Conversation Summary: ...] block when dropping messages", () => {
    const messages: UIMessage[] = [
      msg("user", "What is the project architecture and what decisions were made? ".repeat(20)),
      msg("assistant", "We decided to use Next.js 16 and SQLite with WAL mode. Updated src/lib/ai/context-budget.ts."),
      msg("user", "Recent user question"),
    ];
    const res = compactAndPruneMessages(messages, 200);
    expect(res.droppedCount).toBeGreaterThan(0);
    const firstText = (res.messages[0].parts[0] as { text: string }).text;
    expect(firstText).toContain("[Conversation Summary:");
    expect(firstText).toMatch(/Next\.js|SQLite|context-budget|decisions|User query/i);
  });

  it("handles messages with empty list gracefully", () => {
    const res = compactAndPruneMessages([], 1000);
    expect(res.messages).toEqual([]);
    expect(res.droppedCount).toBe(0);
    expect(res.estimatedTokens).toBe(0);
  });

  it("keeps conversations under budget untouched without injecting summary", () => {
    const messages = [msg("user", "hello"), msg("assistant", "hi")];
    const res = compactAndPruneMessages(messages, 10_000);
    expect(res.droppedCount).toBe(0);
    expect(res.messages).toEqual(messages);
  });
});


