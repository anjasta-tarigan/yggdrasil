import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MessageParts } from "@/components/chat/MessageParts";
import type { ChatUIMessage } from "@/app/api/chat/route";

// RTL auto-cleanup never registers in this setup (globals not enabled).
beforeEach(() => cleanup());
afterEach(() => cleanup());

const pendingQuestionPart = {
  type: "tool-ask_user_question",
  toolCallId: "call-q-pending",
  state: "input-available",
  input: {
    questions: [
      {
        question: "Which database should we use?",
        header: "Database",
        multiSelect: false,
        options: [
          { label: "PostgreSQL", description: "relational" },
          { label: "SQLite", description: "embedded" },
        ],
      },
    ],
  },
} as unknown as ChatUIMessage["parts"][number];

const answeredQuestionPart = {
  type: "tool-ask_user_question",
  toolCallId: "call-q-answered",
  state: "output-available",
  input: (pendingQuestionPart as { input: unknown }).input,
  output: {
    answers: { "Which database should we use?": "PostgreSQL" },
  },
} as unknown as ChatUIMessage["parts"][number];

const assistantMessage = (parts: ChatUIMessage["parts"]): ChatUIMessage =>
  ({ id: "msg-1", role: "assistant", parts }) as ChatUIMessage;

const noop = () => {};

describe("MessageParts: ask_user_question rendering (popup-owned QnA)", () => {
  it("renders NOTHING inline for a pending question (the popup owns it)", () => {
    render(
      <MessageParts
        isLastMessage
        isStreaming={false}
        message={assistantMessage([pendingQuestionPart])}
        onOpenArtifact={noop}
      />
    );

    // The interactive form must not appear in the transcript.
    expect(screen.queryByRole("button", { name: /PostgreSQL/i })).toBeNull();
    expect(screen.queryByText(/Which database should we use\?/)).toBeNull();
  });

  it("renders the answered summary in the unified Questions CoT trail, never a card", () => {
    render(
      <MessageParts
        isLastMessage
        isStreaming={false}
        message={assistantMessage([answeredQuestionPart])}
        onOpenArtifact={noop}
      />
    );

    // Unified ChainOfThought trail owns the summary.
    expect(screen.getByText("Questions — 1 step")).toBeInTheDocument();
    expect(screen.getByText("Asked the user")).toBeInTheDocument();
    expect(screen.getByText(/Which database should we use\?/)).toBeInTheDocument();
    expect(screen.getByText(/PostgreSQL/i)).toBeInTheDocument();

    // No card remnants in the chat view.
    expect(screen.queryByText(/Interactive Question/i)).toBeNull();
    expect(screen.queryByText(/Answered/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /SQLite/i })).toBeNull();
  });

  it("keeps surrounding content visible while a question is pending", () => {
    render(
      <MessageParts
        isLastMessage
        isStreaming={false}
        message={assistantMessage([pendingQuestionPart])}
        onOpenArtifact={noop}
      />
    );

    // No crash, container renders (empty of the question form) — and no
    // Questions trail either: pending parts are popup-owned only.
    expect(
      screen.queryByRole("button", { name: /PostgreSQL/i })
    ).toBeNull();
    expect(screen.queryByText(/Questions — /)).toBeNull();
    expect(screen.queryByText(/Which database should we use\?/)).toBeNull();
  });
});
