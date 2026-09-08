import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QuestionCard } from "@/components/ai-elements/question-card";
import {
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationActions,
  ConfirmationAction,
} from "@/components/ai-elements/confirmation";
import type { ToolUIPart, DynamicToolUIPart } from "ai";

describe("Chat Feed Integration: QuestionCard & Confirmation gates", () => {
  beforeEach(() => {
    cleanup();
  });

  const mockQuestionInput = {
    questions: [
      {
        question: "Select the primary ORM for this project:",
        header: "Database",
        multiSelect: false,
        options: [
          {
            label: "Drizzle ORM",
            description: "Type-safe SQL dialect and lightweight query builder",
            preview: "export const users = pgTable('users', { id: text('id') });",
          },
          {
            label: "Prisma ORM",
            description: "Declarative schema with auto-generated client",
            preview: "model User { id String @id }",
          },
        ],
      },
    ],
  };

  it("renders QuestionCard for ask_user_question tool parts and handles user answers", () => {
    const onAnswerQuestion = vi.fn();
    const part: ToolUIPart = {
      type: "tool-ask_user_question",
      toolCallId: "call-qna-123",
      state: "input-available",
      input: mockQuestionInput,
    };

    render(
      <QuestionCard
        onAnswer={(answers) => onAnswerQuestion(part.toolCallId, answers)}
        part={part}
      />
    );

    expect(screen.getByText("Database")).toBeDefined();
    expect(
      screen.getByText("Select the primary ORM for this project:")
    ).toBeDefined();

    const drizzleBtn = screen.getByRole("button", { name: /Drizzle ORM/i });
    fireEvent.click(drizzleBtn);

    expect(onAnswerQuestion).toHaveBeenCalledTimes(1);
    expect(onAnswerQuestion).toHaveBeenCalledWith("call-qna-123", {
      "Select the primary ORM for this project:": "Drizzle ORM",
    });
  });

  it("renders Confirmation card when tool part is in 'approval-requested' state and handles Accept", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    const part: ToolUIPart = {
      type: "tool-bash",
      toolCallId: "call-bash-999",
      state: "approval-requested",
      input: { command: "rm -rf node_modules" },
      approval: {
        id: "approval-bash-999",
      },
    };

    render(
      <Confirmation approval={part.approval} state={part.state}>
        <ConfirmationTitle>Tool Approval Required: bash</ConfirmationTitle>
        <ConfirmationRequest>
          <div data-testid="approval-prompt">
            Dangerous command requested: <code>{(part.input as { command: string }).command}</code>
          </div>
        </ConfirmationRequest>
        <ConfirmationActions>
          <ConfirmationAction
            onClick={() => onDeny(part.approval!.id, "User denied execution")}
            variant="outline"
          >
            Deny
          </ConfirmationAction>
          <ConfirmationAction
            onClick={() => onApprove(part.approval!.id)}
            variant="default"
          >
            Accept
          </ConfirmationAction>
        </ConfirmationActions>
      </Confirmation>
    );

    expect(screen.getByText(/Tool Approval Required: bash/i)).toBeDefined();
    expect(screen.getByTestId("approval-prompt")).toBeDefined();
    expect(screen.getByText(/rm -rf node_modules/i)).toBeDefined();

    const acceptBtn = screen.getByRole("button", { name: /Accept/i });
    fireEvent.click(acceptBtn);

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith("approval-bash-999");
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("renders Confirmation card and handles Deny with custom reason", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    const dynamicPart: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "mcp_postgres_drop_table",
      toolCallId: "call-dyn-del-1",
      state: "approval-requested",
      input: { table: "production_data" },
      approval: {
        id: "approval-del-1",
      },
    };

    render(
      <Confirmation approval={dynamicPart.approval} state={dynamicPart.state}>
        <ConfirmationTitle>
          Tool Approval Required: {dynamicPart.toolName}
        </ConfirmationTitle>
        <ConfirmationRequest>
          <div>Approve dropping of {(dynamicPart.input as { table: string }).table}?</div>
        </ConfirmationRequest>
        <ConfirmationActions>
          <ConfirmationAction
            onClick={() => onDeny(dynamicPart.approval!.id, "User rejected")}
            variant="outline"
          >
            Deny
          </ConfirmationAction>
          <ConfirmationAction
            onClick={() => onApprove(dynamicPart.approval!.id)}
            variant="default"
          >
            Accept
          </ConfirmationAction>
        </ConfirmationActions>
      </Confirmation>
    );

    const denyBtn = screen.getByRole("button", { name: /Deny/i });
    fireEvent.click(denyBtn);

    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledWith("approval-del-1", "User rejected");
    expect(onApprove).not.toHaveBeenCalled();
  });
});
