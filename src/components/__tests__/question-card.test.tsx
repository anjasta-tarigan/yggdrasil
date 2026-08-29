import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QuestionCard } from "@/components/ai-elements/question-card";
import type { ToolUIPart, DynamicToolUIPart } from "ai";

describe("QuestionCard Component", () => {
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

  const mockMultiSelectInput = {
    questions: [
      {
        question: "Which features should we enable?",
        header: "Features",
        multiSelect: true,
        options: [
          {
            label: "Authentication",
            description: "JWT and session management",
          },
          {
            label: "Logging",
            description: "Structured logging with Pino",
          },
          {
            label: "Rate Limiting",
            description: "Redis-backed rate limiting",
          },
        ],
      },
    ],
  };

  it("renders question header category chip and question text", () => {
    const part: ToolUIPart = {
      type: "tool-ask_user_question",
      toolCallId: "call-1",
      state: "input-available",
      input: mockInput,
    };

    render(<QuestionCard part={part} />);

    expect(screen.getByText("Database")).toBeDefined();
    expect(screen.getByText("Which database should we use?")).toBeDefined();
    expect(screen.getByText("PostgreSQL")).toBeDefined();
    expect(screen.getByText("Robust relational database with ACID and pgvector support")).toBeDefined();
    expect(screen.getByText("SQLite")).toBeDefined();
    expect(screen.getByText("Lightweight embedded file-based database for simplicity")).toBeDefined();
  });

  it("renders code preview box when preview is provided in options", () => {
    const part: ToolUIPart = {
      type: "tool-ask_user_question",
      toolCallId: "call-1",
      state: "input-available",
      input: mockInput,
    };

    render(<QuestionCard part={part} />);

    expect(screen.getByText(/CREATE TABLE users \(id UUID PRIMARY KEY, name TEXT\);/)).toBeDefined();
    expect(screen.getByText(/CREATE TABLE users \(id INTEGER PRIMARY KEY, name TEXT\);/)).toBeDefined();
  });

  it("calls onAnswer callback when a single-select option is clicked", () => {
    const onAnswer = vi.fn();
    const part: ToolUIPart = {
      type: "tool-ask_user_question",
      toolCallId: "call-1",
      state: "input-available",
      input: mockInput,
    };

    render(<QuestionCard onAnswer={onAnswer} part={part} />);

    const postgresButton = screen.getByRole("button", { name: /PostgreSQL/i });
    fireEvent.click(postgresButton);

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({
      "Which database should we use?": "PostgreSQL",
    });
  });

  it("allows selecting multiple options and submitting when multiSelect is true", () => {
    const onAnswer = vi.fn();
    const part: ToolUIPart = {
      type: "tool-ask_user_question",
      toolCallId: "call-2",
      state: "input-available",
      input: mockMultiSelectInput,
    };

    render(<QuestionCard onAnswer={onAnswer} part={part} />);

    const authButton = screen.getByRole("button", { name: /Authentication/i });
    const loggingButton = screen.getByRole("button", { name: /Logging/i });
    const submitButton = screen.getByRole("button", { name: /Submit Answer/i });

    // Select Auth and Logging
    fireEvent.click(authButton);
    fireEvent.click(loggingButton);

    // Click submit
    fireEvent.click(submitButton);

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({
      "Which features should we enable?": ["Authentication", "Logging"],
    });
  });

  it("renders auto-appended 'Other' text input and submits custom answer", () => {
    const onAnswer = vi.fn();
    const part: ToolUIPart = {
      type: "tool-ask_user_question",
      toolCallId: "call-1",
      state: "input-available",
      input: mockInput,
    };

    render(<QuestionCard onAnswer={onAnswer} part={part} />);

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
    const part: ToolUIPart = {
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

    render(<QuestionCard part={part} />);

    expect(screen.getByText(/Answered/i)).toBeDefined();
    expect(screen.getByText("PostgreSQL")).toBeDefined();
    // Options should be disabled or rendered in summary mode
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
    const sqliteButton = screen.getByRole("button", { name: /SQLite/i });
    fireEvent.click(sqliteButton);

    expect(onAnswer).toHaveBeenCalledWith({
      "Which database should we use?": "SQLite",
    });
  });
});
