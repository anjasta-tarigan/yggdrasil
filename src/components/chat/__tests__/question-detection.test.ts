import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  findLatestQuestionPart,
  isQuestionAnswered,
} from "../chat-utils";

/**
 * Popup QnA behavior (Claude-web / DSH style):
 * - A pending ask_user_question part (input-streaming/input-available)
 *   is surfaced as a modal popup owned by ChatArea, NOT inline in the
 *   transcript.
 * - The helper must find the NEWEST unanswered question part in the
 *   whole message list, skipping answered ones (multi-question turns).
 */

const stepStart = { type: "step-start" } as const;

const pendingQuestionPart = {
  type: "tool-ask_user_question",
  toolCallId: "call-q-1",
  state: "input-available",
  input: {
    questions: [
      {
        question: "Which database?",
        header: "Database",
        multiSelect: false,
        options: [
          { label: "PostgreSQL", description: "relational" },
          { label: "SQLite", description: "embedded" },
        ],
      },
    ],
  },
} as const;

const streamingQuestionPart = {
  ...pendingQuestionPart,
  toolCallId: "call-q-stream",
  state: "input-streaming",
} as const;

const answeredQuestionPart = {
  type: "tool-ask_user_question",
  toolCallId: "call-q-answered",
  state: "output-available",
  input: pendingQuestionPart.input,
  output: {
    answers: { "Which database?": "PostgreSQL" },
  },
} as const;

const assistantWith = (parts: UIMessage["parts"]): UIMessage =>
  ({ id: "msg-a", role: "assistant", parts }) as UIMessage;

describe("findLatestQuestionPart (popup detection)", () => {
  it("finds the latest pending question part across messages", () => {
    const messages: UIMessage[] = [
      assistantWith([
        stepStart,
        answeredQuestionPart as unknown as UIMessage["parts"][number],
      ]),
      assistantWith([
        stepStart,
        pendingQuestionPart as unknown as UIMessage["parts"][number],
      ]),
    ];
    const found = findLatestQuestionPart(messages);
    expect(found?.toolCallId).toBe("call-q-1");
  });

  it("returns null when all questions are answered", () => {
    const messages: UIMessage[] = [
      assistantWith([
        stepStart,
        answeredQuestionPart as unknown as UIMessage["parts"][number],
      ]),
    ];
    expect(findLatestQuestionPart(messages)).toBeNull();
  });

  it("returns null for a message list without any question parts", () => {
    const messages: UIMessage[] = [
      assistantWith([
        stepStart,
        {
          type: "tool-web_search",
          toolCallId: "call-ws",
          state: "output-available",
          input: { query: "ai sdk" },
          output: { results: [] },
        } as unknown as UIMessage["parts"][number],
      ]),
    ];
    expect(findLatestQuestionPart(messages)).toBeNull();
  });

  it("does not treat an answered question as pending (multi-question turns)", () => {
    // Older message has the answered one; latest message has the pending one.
    const messages: UIMessage[] = [
      assistantWith([
        stepStart,
        answeredQuestionPart as unknown as UIMessage["parts"][number],
      ]),
      assistantWith([
        stepStart,
        answeredQuestionPart as unknown as UIMessage["parts"][number],
      ]),
    ];
    expect(findLatestQuestionPart(messages)).toBeNull();
  });

  it("skips approval-requested question parts (never pending for the modal)", () => {
    // ask_user_question is policy-exempt, but a hand-crafted part in
    // approval-requested state must not open the popup either.
    const messages: UIMessage[] = [
      assistantWith([
        stepStart,
        {
          type: "tool-ask_user_question",
          toolCallId: "call-q-appr",
          state: "approval-requested",
          input: pendingQuestionPart.input,
        } as unknown as UIMessage["parts"][number],
      ]),
    ];
    expect(findLatestQuestionPart(messages)).toBeNull();
  });

  it("treats input-streaming questions as pending while the input JSON is complete enough", () => {
    // While the tool input is still streaming, the part exists but its
    // questions array may be incomplete. The modal must not open on a
    // half-streamed question; only input-available opens it.
    const messages: UIMessage[] = [
      assistantWith([
        stepStart,
        streamingQuestionPart as unknown as UIMessage["parts"][number],
      ]),
    ];
    expect(findLatestQuestionPart(messages)).toBeNull();
  });
});

describe("isQuestionAnswered", () => {
  it("marks output-available parts as answered", () => {
    const part = {
      type: "tool-ask_user_question",
      toolCallId: "c1",
      state: "output-available",
    } as unknown as Parameters<typeof isQuestionAnswered>[0];
    expect(isQuestionAnswered(part)).toBe(true);
  });

  it("marks output-error parts as answered (error terminates the flow)", () => {
    const part = {
      type: "tool-ask_user_question",
      toolCallId: "c1",
      state: "output-error",
      errorText: "boom",
    } as unknown as Parameters<typeof isQuestionAnswered>[0];
    expect(isQuestionAnswered(part)).toBe(true);
  });

  it("marks input-available parts as NOT answered", () => {
    const part = {
      type: "tool-ask_user_question",
      toolCallId: "c1",
      state: "input-available",
    } as unknown as Parameters<typeof isQuestionAnswered>[0];
    expect(isQuestionAnswered(part)).toBe(false);
  });
});
