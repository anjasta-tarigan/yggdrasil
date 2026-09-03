import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QuestionCard } from "@/components/ai-elements/question-card";
import type { ToolUIPart, DynamicToolUIPart } from "ai";

describe("QuestionCard Component (compact paged wizard)", () => {
  beforeEach(() => {
    cleanup();
  });

  const mockInput = {
    questions: [
      {
        question: "Which database should we use?",
        header: "Database",
        multiSelect: false,
        options: [
          {
            label: "PostgreSQL",
            description: "Robust relational database with ACID and pgvector support",
            preview: "CREATE TABLE users (id UUID PRIMARY KEY, name TEXT);",
          },
          {
            label: "SQLite",
            description: "Lightweight embedded file-based database for simplicity",
            preview: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
          },
        ],
      },
    ],
  };

  const mockMultiQuestionInput = {
    questions: [
      {
        question: "Which framework should we use?",
        header: "Framework",
        multiSelect: false,
        options: [
          { label: "Next.js", description: "react metaframework" },
          { label: "Astro", description: "islands" },
        ],
      },
      {
        question: "Which styling approach?",
        header: "Styling",
        multiSelect: false,
        options: [
          { label: "Tailwind", description: "utility css" },
          { label: "Vanilla", description: "plain css" },
        ],
      },
      {
        question: "Which testing library?",
        header: "Testing",
        multiSelect: false,
        options: [
          { label: "Vitest", description: "vite-native" },
          { label: "Jest", description: "classic" },
        ],
      },
    ],
  };

  const mockMultiSelectInput = {
    questions: [
      {
        question: "Which features should we enable?",
        header: "Features",
        multiSelect: true,
        options: [
          { label: "Authentication", description: "JWT and session management" },
          { label: "Logging", description: "Structured logging with Pino" },
          { label: "Rate Limiting", description: "Redis-backed rate limiting" },
        ],
      },
    ],
  };

  const part = (input: unknown): ToolUIPart =>
    ({
      type: "tool-ask_user_question",
      toolCallId: "call-1",
      state: "input-available",
      input,
    }) as unknown as ToolUIPart;

  // ------------------------------------------------------------------
  // Single question: renders as one small card, no pager.
  // ------------------------------------------------------------------

  it("renders exactly one question with its options, compactly", () => {
    render(<QuestionCard part={part(mockInput)} />);

    expect(screen.getByText("Which database should we use?")).toBeDefined();
    expect(screen.getByText("PostgreSQL")).toBeDefined();
    expect(screen.getByText("SQLite")).toBeDefined();
    expect(
      screen.getByText("Robust relational database with ACID and pgvector support")
    ).toBeDefined();
  });

  it("shows no pager for a single question", () => {
    render(<QuestionCard part={part(mockInput)} />);

    expect(screen.queryByRole("button", { name: /^Next$/i })).toBeNull();
    expect(screen.queryByText(/^1 \/ 1$/)).toBeNull();
  });

  it("renders code preview box when preview is provided in options", () => {
    render(<QuestionCard part={part(mockInput)} />);

    expect(screen.getByText(/CREATE TABLE users \(id UUID PRIMARY KEY, name TEXT\);/)).toBeDefined();
  });

  it("calls onAnswer directly when a single-select option is clicked (single question)", () => {
    const onAnswer = vi.fn();
    // NOTE: single-select single-question submits directly (existing
    // behavior) — but with the wizard, multi-question forms must submit
    // per page or on the last page. This test keeps the direct path.
    render(<QuestionCard onAnswer={onAnswer} part={part(mockInput)} />);

    fireEvent.click(screen.getByRole("button", { name: /PostgreSQL/i }));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({
      "Which database should we use?": "PostgreSQL",
    });
  });

  // ------------------------------------------------------------------
  // Multi question: pager < 1/3 > stepping through questions.
  // ------------------------------------------------------------------

  it("shows only the first question and a 1 / 3 pager initially", () => {
    render(<QuestionCard part={part(mockMultiQuestionInput)} />);

    expect(screen.getByText("Which framework should we use?")).toBeDefined();
    expect(screen.queryByText("Which styling approach?")).toBeNull();
    expect(screen.queryByText("Which testing library?")).toBeNull();
    // Pager indicator exists with accessible name for screen readers.
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    // Previous is disabled on page 1.
    expect(
      screen.getByRole("button", { name: "Previous page" })
    ).toHaveProperty("disabled", true);
  });

  it("auto-advances after answering a non-last page and submits after the last", () => {
    const onAnswer = vi.fn();
    render(<QuestionCard onAnswer={onAnswer} part={part(mockMultiQuestionInput)} />);

    // Page 1: pick Next.js — auto-advances to page 2 (no submit yet).
    fireEvent.click(screen.getByRole("button", { name: /Next\.js/i }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText("Which styling approach?")).toBeDefined();

    // Page 2: pick Tailwind — auto-advances to page 3 (last).
    fireEvent.click(screen.getByRole("button", { name: /Tailwind/i }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByText("3 / 3")).toBeInTheDocument();

    // Last page: answering submits all collected answers at once.
    fireEvent.click(screen.getByRole("button", { name: /Vitest/i }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({
      "Which framework should we use?": "Next.js",
      "Which styling approach?": "Tailwind",
      "Which testing library?": "Vitest",
    });
  });

  it("keeps earlier answers when stepping back and forth with the pager", () => {
    const onAnswer = vi.fn();
    render(<QuestionCard onAnswer={onAnswer} part={part(mockMultiQuestionInput)} />);

    // Answer page 1 (auto-advances), answer page 2, then step back twice.
    fireEvent.click(screen.getByRole("button", { name: /Next\.js/i }));
    fireEvent.click(screen.getByRole("button", { name: /Tailwind/i }));
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(screen.getByText("1 / 3")).toBeInTheDocument();

    // Page 1 must show the stored pick as selected (checked icon present
    // via aria-pressed or the selection state, verified by re-click
    // submitting the stored answers on the last page).
    // Step forward to page 3 and answer — page 1's stored answer must
    // still be part of the final submission.
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: /Vitest/i }));

    expect(onAnswer).toHaveBeenCalledWith({
      "Which framework should we use?": "Next.js",
      "Which styling approach?": "Tailwind",
      "Which testing library?": "Vitest",
    });
  });

  it("keeps the Previous button disabled on page 1 and Next disabled on the last page", () => {
    render(<QuestionCard part={part(mockMultiQuestionInput)} />);

    const prev = screen.getByRole("button", { name: "Previous page" });
    expect(prev).toHaveProperty("disabled", true);

    // Advance to the last page (page 3 of 3).
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    const next = screen.getByRole("button", { name: "Next page" });
    expect(next).toHaveProperty("disabled", true);
    expect(prev).toHaveProperty("disabled", false);
  });

  // ------------------------------------------------------------------
  // Multi-select & custom answers
  // ------------------------------------------------------------------

  it("allows selecting multiple options and submitting when multiSelect is true", () => {
    const onAnswer = vi.fn();
    render(<QuestionCard onAnswer={onAnswer} part={part(mockMultiSelectInput)} />);

    fireEvent.click(screen.getByRole("button", { name: /Authentication/i }));
    fireEvent.click(screen.getByRole("button", { name: /Logging/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Submit Answer/i })
    );

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({
      "Which features should we enable?": ["Authentication", "Logging"],
    });
  });

  it("renders auto-appended 'Other' text input and submits custom answer", () => {
    const onAnswer = vi.fn();
    render(<QuestionCard onAnswer={onAnswer} part={part(mockInput)} />);

    const customInput = screen.getByPlaceholderText(/Other/i);
    fireEvent.change(customInput, { target: { value: "MongoDB with Mongoose" } });

    const submitCustomButton = screen.getByRole("button", { name: /Submit Other|Submit/i });
    fireEvent.click(submitCustomButton);

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({
      "Which database should we use?": "MongoDB with Mongoose",
    });
  });

  it("renders answered state badge when part.state === 'output-available'", () => {
    const answeredPart: ToolUIPart = {
      type: "tool-ask_user_question",
      toolCallId: "call-1",
    state: "output-available",
      input: mockInput,
      output: {
        answers: {
          "Which database should we use?": "PostgreSQL",
        },
      },
    };

    render(<QuestionCard part={answeredPart} />);

    expect(screen.getByText(/Answered/i)).toBeDefined();
    expect(screen.getByText("PostgreSQL")).toBeDefined();
    expect(screen.queryByPlaceholderText(/Other/i)).toBeNull();
  });

  it("works seamlessly with DynamicToolUIPart", () => {
    const onAnswer = vi.fn();
    const dynamicPart: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "ask_user_question",
      toolCallId: "call-dynamic-1",
      state: "input-available",
      input: mockInput,
    };

    render(<QuestionCard onAnswer={onAnswer} part={dynamicPart} />);

    expect(screen.getByText("Database")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /SQLite/i }));
    expect(onAnswer).toHaveBeenCalledWith({
      "Which database should we use?": "SQLite",
    });
  });
});
