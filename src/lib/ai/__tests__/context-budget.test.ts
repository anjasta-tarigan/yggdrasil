import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  estimateMessageTokens,
  pruneMessagesToTokenBudget,
  calculateContextTokenBudget,
  compactAndPruneMessages,
  compactForModelSend,
  applyCompactionSafetyMargin,
  defaultClientCompactionBudget,
  getTokenRatio,
  recordTokenRatio,
} from "../context-budget";
import { processIncomingMessageAttachments } from "../attachments";

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

  it("server re-guard of a client-compacted list drops nothing (anti-thrash contract)", () => {
    // The client compacts the FULL transcript into modelContextMessages;
    // the server then runs the exact-budget guard on what it received.
    // If the server dropped again, long chats would be re-summarized on
    // every request (the old per-turn "[chat/route] Context guard
    // compacted..." log).
    const messages: UIMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(msg("user", `question ${i} `.repeat(200))); // ~1100 tokens
      messages.push(msg("assistant", `answer ${i} `.repeat(200)));
    }
    // Client side: decode attachments (none here), reserve summary room.
    const clientCompaction = compactForModelSend(messages, 6_000);
    expect(clientCompaction.droppedCount).toBeGreaterThan(0);
    // The sent list (summary included) fits the budget, so the server's
    // exact-budget re-guard below has nothing left to drop.
    expect(clientCompaction.estimatedTokens).toBeLessThanOrEqual(6_000);

    const serverGuard = compactAndPruneMessages(
      clientCompaction.messages,
      6_000
    );
    expect(serverGuard.droppedCount).toBe(0);
    expect(serverGuard.messages).toEqual(clientCompaction.messages);
  });
});

describe("client/server compaction parity", () => {
  it("client pre-compaction survives the server re-guard, even with text attachments", async () => {
    // Build a long transcript whose tail exceeds the budget, then a final
    // user turn that also attaches a text file. The client decodes the
    // attachment (processIncomingMessageAttachments) before compacting —
    // the identical pipeline the server runs. The server's second run must
    // not drop anything (droppedCount 0), otherwise every turn would log.
    const messages: UIMessage[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push(msg("user", `question ${i} `.repeat(200)));
      messages.push(msg("assistant", `answer ${i} `.repeat(200)));
    }
    const code = "const x = ".repeat(50);
    const dataUrl = `data:text/plain;base64,${Buffer.from(code).toString("base64")}`;
    messages.push({
      id: "attach",
      role: "user",
      parts: [
        { type: "file", filename: "x.txt", mediaType: "text/plain", url: dataUrl },
        { type: "text", text: "please analyze" },
      ],
    });

    const budget = 6_000;
    // Client side: decode attachments, then compact to the (already
    // server-reported) budget with summary-room reservation.
    const clientSide = await processIncomingMessageAttachments(messages);
    const clientCompaction = compactForModelSend(clientSide, budget);
    expect(clientCompaction.droppedCount).toBeGreaterThan(0);
    expect(clientCompaction.estimatedTokens).toBeLessThanOrEqual(budget);

    // Server side: re-run the same chain on exactly what it receives, with
    // its exact budget (no margin) — must drop nothing.
    const serverSide = await processIncomingMessageAttachments(
      clientCompaction.messages
    );
    const serverGuard = compactAndPruneMessages(serverSide, budget);
    expect(serverGuard.droppedCount).toBe(0);
    expect(serverGuard.messages).toEqual(clientCompaction.messages);
  });
});

describe("client compaction budget helpers", () => {
  it("defaults conservatively to a fraction of the model window", () => {
    expect(defaultClientCompactionBudget(1_000_000)).toBe(800_000);
    expect(defaultClientCompactionBudget(128_000)).toBe(102_400);
    expect(defaultClientCompactionBudget(32_000)).toBe(25_600);
    // Unknown windows fall back to the shared safe budget.
    expect(defaultClientCompactionBudget(0)).toBe(
      Math.floor(DEFAULT_CONTEXT_TOKEN_BUDGET * 0.8)
    );
  });

  it("applies a 5% safety margin to a server-reported budget", () => {
    expect(applyCompactionSafetyMargin(982_994)).toBe(933_844);
    expect(applyCompactionSafetyMargin(10_000)).toBe(9_500);
    // Never below the practical floor.
    expect(applyCompactionSafetyMargin(1_000)).toBe(1_000);
    expect(applyCompactionSafetyMargin(1)).toBe(1_000);
  });
});



describe("estimator self-calibration", () => {
  const MODEL = "calib-test-model";

  it("returns neutral ratio for an unknown model", () => {
    expect(getTokenRatio("never-seen-model")).toBe(1);
  });

  it("records an undercount and only tightens", () => {
    // Estimator said 10k, provider counted 13k -> ratio 1.3
    recordTokenRatio(MODEL, 10_000, 13_000);
    expect(getTokenRatio(MODEL)).toBeCloseTo(1.3, 5);
    // A later overcounted turn must not loosen the guard immediately:
    // the conservative max-with-decay keeps the tighter constraint.
    recordTokenRatio(MODEL, 10_000, 9_000);
    expect(getTokenRatio(MODEL)).toBeGreaterThanOrEqual(1.17);
    expect(getTokenRatio(MODEL)).toBeLessThanOrEqual(1.3);
  });

  it("ignores tiny prompts and garbage input", () => {
    const before = getTokenRatio(MODEL);
    recordTokenRatio(MODEL, 100, 999_999); // below the 1000-token floor
    recordTokenRatio(MODEL, Number.NaN, 5_000);
    recordTokenRatio(MODEL, 5_000, 0);
    recordTokenRatio("", 5_000, 5_000);
    expect(getTokenRatio(MODEL)).toBe(before);
  });

  it("clamps pathological ratios", () => {
    recordTokenRatio(`${MODEL}-clamp`, 10_000, 999_999); // would be 100x
    expect(getTokenRatio(`${MODEL}-clamp`)).toBe(4);
  });
});
