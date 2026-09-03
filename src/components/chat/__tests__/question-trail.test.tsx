import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { QuestionTrail } from "@/components/chat/QuestionTrail";
import type { DynamicToolUIPart, ToolUIPart } from "ai";

beforeEach(() => cleanup());
afterEach(() => cleanup());

const answeredPart: ToolUIPart = {
  type: "tool-ask_user_question",
  toolCallId: "call-q-1",
  state: "output-available",
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
      {
        question: "Which ORM?",
        header: "ORM",
        multiSelect: true,
        options: [
          { label: "Drizzle", description: "type-safe" },
          { label: "Prisma", description: "declarative" },
        ],
      },
    ],
  },
  output: {
    answers: {
      "Which database should we use?": "PostgreSQL",
      "Which ORM?": ["Drizzle", "Prisma"],
    },
  },
};

const declinedPart: ToolUIPart = {
  ...answeredPart,
  toolCallId: "call-q-declined",
  output: {
    answers: {
      "Which database should we use?": "User declined to answer the question.",
      "Which ORM?": "User declined to answer the question.",
    },
  },
};

describe("QuestionTrail (unified CoT rendering for answered questions)", () => {
  it("renders one trail with a step per answered tool call", () => {
    render(<QuestionTrail isLastMessage parts={[answeredPart]} />);

    expect(screen.getByText("Questions — 1 step")).toBeInTheDocument();
    // One step per tool call (not per sub-question).
    expect(screen.getByText("Asked the user")).toBeInTheDocument();
  });

  it("lists every question with its answer inside the step", () => {
    render(<QuestionTrail isLastMessage parts={[answeredPart]} />);

    expect(
      screen.getByText(/Which database should we use\?/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Which ORM\?/)).toBeInTheDocument();
    // Array answers join into readable text.
    expect(screen.getByText(/Drizzle, Prisma/)).toBeInTheDocument();
    expect(screen.getByText(/PostgreSQL/)).toBeInTheDocument();
  });

  it("renders nothing for pending parts (popup owns them)", () => {
    const pending: ToolUIPart = {
      type: "tool-ask_user_question",
      toolCallId: "call-q-pending",
      state: "input-available",
      input: answeredPart.input,
    };
    const { container } = render(
      <QuestionTrail isLastMessage parts={[pending, answeredPart]} />
    );

    // Only the answered call becomes a step; the pending one renders
    // nothing at all (no trail for it).
    expect(screen.getByText("Questions — 1 step")).toBeInTheDocument();
    expect(screen.queryByText(/asking/i)).toBeNull();
    // No interactive form leaks into the trail.
    expect(
      screen.queryByRole("button", { name: /PostgreSQL/i })
    ).toBeNull();
    expect(container.firstChild).not.toBeNull();
  });

  it("marks declined answers distinctly instead of showing the raw decline string", () => {
    render(<QuestionTrail isLastMessage parts={[declinedPart]} />);

    // Both questions in the fixture were declined.
    expect(screen.getAllByText(/Declined/i)).toHaveLength(2);
    expect(
      screen.queryByText(/User declined to answer the question\./)
    ).toBeNull();
  });

  it("renders multiple tool calls as multiple steps in one trail", () => {
    render(<QuestionTrail isLastMessage parts={[answeredPart, declinedPart]} />);

    expect(screen.getByText("Questions — 2 steps")).toBeInTheDocument();
  });

  it("supports MCP dynamic tool parts via getToolName", () => {
    const dynamic: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "ask_user_question",
      state: "output-available",
      toolCallId: "call-q-mcp",
      input: answeredPart.input,
      output: answeredPart.output,
    };
    render(<QuestionTrail isLastMessage parts={[dynamic]} />);

    expect(screen.getByText("Questions — 1 step")).toBeInTheDocument();
    expect(screen.getByText(/PostgreSQL/)).toBeInTheDocument();
  });

  it("returns null when there are no answered parts", () => {
    const { container } = render(<QuestionTrail parts={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("QuestionTrail auto-close (folds after the answer lands)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance virtual time past the auto-close grace delay (act-flushed). */
  async function advancePastDelay() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1010);
    });
  }

  it("mounts open on the live message so the fresh answer is visible", () => {
    render(<QuestionTrail isLastMessage parts={[answeredPart]} />);
    expect(screen.getByText("Asked the user")).toBeInTheDocument();
  });

  it("folds a second after the answer lands on the live message", async () => {
    render(<QuestionTrail isLastMessage parts={[answeredPart]} />);
    expect(screen.getByText("Asked the user")).toBeInTheDocument();

    await advancePastDelay();
    expect(screen.queryByText("Asked the user")).toBeNull();
    // The header stays as the minimized handle.
    expect(screen.getByText("Questions — 1 step")).toBeInTheDocument();
  });

  it("mounts folded for historical messages", () => {
    render(<QuestionTrail parts={[answeredPart]} />);
    expect(screen.getByText("Questions — 1 step")).toBeInTheDocument();
    expect(screen.queryByText("Asked the user")).toBeNull();
  });
});
