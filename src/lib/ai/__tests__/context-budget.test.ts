import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  estimateMessageTokens,
  pruneMessagesToTokenBudget,
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
