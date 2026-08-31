import { describe, it, expect } from "vitest";
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";

/**
 * The chat auto-continues when
 * lastAssistantMessageIsCompleteWithToolCalls(messages) OR
 * lastAssistantMessageIsCompleteWithApprovalResponses(messages) is true.
 * These tests pin the behavior of both predicates so the wiring in
 * ChatArea keeps resuming after tool executions AND approval responses.
 */

const assistantMessage = (parts: UIMessage["parts"]): UIMessage =>
  ({
    id: "msg-1",
    role: "assistant",
    parts,
  }) as UIMessage;

const completedToolPart = {
  type: "dynamic-tool",
  toolCallId: "call-1",
  toolName: "parallel-search__web_search",
  state: "output-available",
  input: { query: "test" },
  output: { results: [] },
} as const;

const approvalRequestedPart = {
  type: "dynamic-tool",
  toolCallId: "call-1",
  toolName: "acme__delete_account",
  state: "approval-requested",
  input: { id: "u-1" },
  approval: { id: "approval-1", isAutomatic: false },
} as const;

const approvalRespondedPart = {
  type: "dynamic-tool",
  toolCallId: "call-1",
  toolName: "acme__delete_account",
  state: "approval-responded",
  input: { id: "u-1" },
  approval: { id: "approval-1", approved: true },
} as const;

const stepStart = { type: "step-start" } as const;

describe("auto-continue predicates (ChatArea sendAutomaticallyWhen)", () => {
  it("resumes when tool calls have results", () => {
    const messages: UIMessage[] = [
      assistantMessage([stepStart, completedToolPart]),
    ];
    expect(lastAssistantMessageIsCompleteWithToolCalls({ messages })).toBe(true);
  });

  it("stalls the tool-calls predicate while approval is requested", () => {
    const messages: UIMessage[] = [
      assistantMessage([stepStart, approvalRequestedPart]),
    ];
    expect(lastAssistantMessageIsCompleteWithToolCalls({ messages })).toBe(false);
  });

  it("stalls the tool-calls predicate after the user approves", () => {
    // Regression for the frozen chat: an approval-responded part has no
    // tool result yet, so the tool-calls predicate alone never fires —
    // the conversation stopped after clicking Accept until this OR was
    // added in ChatArea.
    const messages: UIMessage[] = [
      assistantMessage([stepStart, approvalRespondedPart]),
    ];
    expect(lastAssistantMessageIsCompleteWithToolCalls({ messages })).toBe(false);
  });

  it("resumes via the approval predicate after the user approves", () => {
    const messages: UIMessage[] = [
      assistantMessage([stepStart, approvalRespondedPart]),
    ];
    expect(
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages })
    ).toBe(true);
  });

  it("does not resume the approval predicate while approval is pending", () => {
    const messages: UIMessage[] = [
      assistantMessage([stepStart, approvalRequestedPart]),
    ];
    expect(
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages })
    ).toBe(false);
  });
});
