import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationActions,
  ConfirmationAction,
  useConfirmation,
} from "@/components/ai-elements/confirmation";
import type { ToolUIPart, DynamicToolUIPart } from "ai";

describe("Confirmation Component Suite", () => {
  beforeEach(() => {
    cleanup();
  });

  const mockApprovalRequest = {
    id: "approval-call-123",
  };

  const mockApprovedResponse = {
    id: "approval-call-123",
    approved: true,
  };

  const mockRejectedResponse = {
    id: "approval-call-123",
    approved: false,
    reason: "User denied execution",
  };

  describe("Rendering Lifecycle & State Visibility", () => {
    it("returns null when approval is undefined", () => {
      const { container } = render(
        <Confirmation approval={undefined} state="approval-requested">
          <ConfirmationTitle>Tool Approval</ConfirmationTitle>
          <ConfirmationRequest>Are you sure?</ConfirmationRequest>
        </Confirmation>
      );

      expect(container.firstChild).toBeNull();
    });

    it("returns null when state is 'input-streaming' or 'input-available'", () => {
      const { container: streamingContainer } = render(
        <Confirmation approval={mockApprovalRequest} state="input-streaming">
          <ConfirmationTitle>Tool Approval</ConfirmationTitle>
        </Confirmation>
      );
      expect(streamingContainer.firstChild).toBeNull();

      const { container: inputAvailableContainer } = render(
        <Confirmation approval={mockApprovalRequest} state="input-available">
          <ConfirmationTitle>Tool Approval</ConfirmationTitle>
        </Confirmation>
      );
      expect(inputAvailableContainer.firstChild).toBeNull();
    });

    it("renders Alert container with custom className when valid approval and state provided", () => {
      render(
        <Confirmation
          approval={mockApprovalRequest}
          className="custom-confirmation-class"
          data-testid="confirmation-card"
          state="approval-requested"
        >
          <ConfirmationTitle>Destructive Command</ConfirmationTitle>
        </Confirmation>
      );

      const card = screen.getByTestId("confirmation-card");
      expect(card).toBeDefined();
      expect(card.className).toContain("custom-confirmation-class");
      expect(screen.getByText("Destructive Command")).toBeDefined();
    });

    it("throws error when child component is rendered outside of Confirmation provider", () => {
      // Suppress console.error in this expected throw test
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const TestOrphan = () => {
        useConfirmation();
        return null;
      };

      expect(() => render(<TestOrphan />)).toThrow(
        "Confirmation components must be used within Confirmation"
      );

      spy.mockRestore();
    });
  });

  describe("Approval Request State ('approval-requested')", () => {
    it("renders <ConfirmationRequest> and <ConfirmationActions> during 'approval-requested'", () => {
      render(
        <Confirmation approval={mockApprovalRequest} state="approval-requested">
          <ConfirmationTitle>Execute Bash</ConfirmationTitle>
          <ConfirmationRequest>
            <span data-testid="request-content">
              This tool wants to execute: <code>rm -rf /tmp/data</code>
            </span>
          </ConfirmationRequest>
          <ConfirmationAccepted>
            <span data-testid="accepted-content">Approved</span>
          </ConfirmationAccepted>
          <ConfirmationRejected>
            <span data-testid="rejected-content">Denied</span>
          </ConfirmationRejected>
          <ConfirmationActions data-testid="actions-container">
            <ConfirmationAction variant="outline">Deny</ConfirmationAction>
            <ConfirmationAction variant="default">Accept</ConfirmationAction>
          </ConfirmationActions>
        </Confirmation>
      );

      expect(screen.getByTestId("request-content")).toBeDefined();
      expect(screen.getByText(/rm -rf \/tmp\/data/)).toBeDefined();
      expect(screen.getByTestId("actions-container")).toBeDefined();
      expect(screen.getByRole("button", { name: /Accept/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /Deny/i })).toBeDefined();

      // Accepted and Rejected sections should not be rendered
      expect(screen.queryByTestId("accepted-content")).toBeNull();
      expect(screen.queryByTestId("rejected-content")).toBeNull();
    });

    it("handles Accept and Deny button clicks with callbacks", () => {
      const onAccept = vi.fn();
      const onDeny = vi.fn();

      render(
        <Confirmation approval={mockApprovalRequest} state="approval-requested">
          <ConfirmationTitle>Execute Bash</ConfirmationTitle>
          <ConfirmationRequest>
            Do you approve running <code>pnpm add drizzle-orm</code>?
          </ConfirmationRequest>
          <ConfirmationActions>
            <ConfirmationAction
              onClick={() => onDeny(mockApprovalRequest.id)}
              variant="outline"
            >
              Deny
            </ConfirmationAction>
            <ConfirmationAction
              onClick={() => onAccept(mockApprovalRequest.id)}
              variant="default"
            >
              Accept
            </ConfirmationAction>
          </ConfirmationActions>
        </Confirmation>
      );

      const acceptButton = screen.getByRole("button", { name: /Accept/i });
      const denyButton = screen.getByRole("button", { name: /Deny/i });

      fireEvent.click(acceptButton);
      expect(onAccept).toHaveBeenCalledTimes(1);
      expect(onAccept).toHaveBeenCalledWith("approval-call-123");

      fireEvent.click(denyButton);
      expect(onDeny).toHaveBeenCalledTimes(1);
      expect(onDeny).toHaveBeenCalledWith("approval-call-123");
    });
  });

  describe("Accepted State ('approval-responded' / 'output-available')", () => {
    it("renders <ConfirmationAccepted> and hides <ConfirmationRequest> and <ConfirmationActions> when approved", () => {
      render(
        <Confirmation approval={mockApprovedResponse} state="approval-responded">
          <ConfirmationTitle>Execute Bash</ConfirmationTitle>
          <ConfirmationRequest>
            <span data-testid="request-content">Request message</span>
          </ConfirmationRequest>
          <ConfirmationAccepted>
            <span data-testid="accepted-content">Execution approved by user</span>
          </ConfirmationAccepted>
          <ConfirmationRejected>
            <span data-testid="rejected-content">Denied by user</span>
          </ConfirmationRejected>
          <ConfirmationActions data-testid="actions-container">
            <ConfirmationAction>Accept</ConfirmationAction>
          </ConfirmationActions>
        </Confirmation>
      );

      expect(screen.getByTestId("accepted-content")).toBeDefined();
      expect(screen.getByText("Execution approved by user")).toBeDefined();

      expect(screen.queryByTestId("request-content")).toBeNull();
      expect(screen.queryByTestId("rejected-content")).toBeNull();
      expect(screen.queryByTestId("actions-container")).toBeNull();
    });

    it("renders <ConfirmationAccepted> when state is 'output-available'", () => {
      render(
        <Confirmation approval={mockApprovedResponse} state="output-available">
          <ConfirmationAccepted>
            <span data-testid="accepted-content">Output produced after approval</span>
          </ConfirmationAccepted>
        </Confirmation>
      );

      expect(screen.getByTestId("accepted-content")).toBeDefined();
      expect(screen.getByText("Output produced after approval")).toBeDefined();
    });
  });

  describe("Rejected State ('output-denied' / 'approval-responded')", () => {
    it("renders <ConfirmationRejected> and hides <ConfirmationAccepted> when rejected with state 'output-denied'", () => {
      render(
        <Confirmation approval={mockRejectedResponse} state="output-denied">
          <ConfirmationTitle>Execute Bash</ConfirmationTitle>
          <ConfirmationRequest>
            <span data-testid="request-content">Request message</span>
          </ConfirmationRequest>
          <ConfirmationAccepted>
            <span data-testid="accepted-content">Execution approved</span>
          </ConfirmationAccepted>
          <ConfirmationRejected>
            <span data-testid="rejected-content">
              Execution denied: {mockRejectedResponse.reason}
            </span>
          </ConfirmationRejected>
          <ConfirmationActions data-testid="actions-container">
            <ConfirmationAction>Deny</ConfirmationAction>
          </ConfirmationActions>
        </Confirmation>
      );

      expect(screen.getByTestId("rejected-content")).toBeDefined();
      expect(screen.getByText(/Execution denied: User denied execution/)).toBeDefined();

      expect(screen.queryByTestId("request-content")).toBeNull();
      expect(screen.queryByTestId("accepted-content")).toBeNull();
      expect(screen.queryByTestId("actions-container")).toBeNull();
    });

    it("renders <ConfirmationRejected> when rejected with state 'approval-responded'", () => {
      render(
        <Confirmation approval={mockRejectedResponse} state="approval-responded">
          <ConfirmationRejected>
            <span data-testid="rejected-content">Action rejected</span>
          </ConfirmationRejected>
        </Confirmation>
      );

      expect(screen.getByTestId("rejected-content")).toBeDefined();
      expect(screen.getByText("Action rejected")).toBeDefined();
    });
  });

  describe("AI SDK Compatibility with ToolUIPart and DynamicToolUIPart", () => {
    it("works seamlessly with ToolUIPart approval structure", () => {
      const toolPart: ToolUIPart = {
        type: "tool-bash",
        toolCallId: "call-tool-999",
        state: "approval-requested",
        input: { command: "npm install -g pnpm" },
        approval: {
          id: "approval-999",
        },
      };

      const onApprove = vi.fn();

      render(
        <Confirmation approval={toolPart.approval} state={toolPart.state}>
          <ConfirmationTitle>Command: {(toolPart.input as { command: string }).command}</ConfirmationTitle>
          <ConfirmationRequest>Approve this global install?</ConfirmationRequest>
          <ConfirmationActions>
            <ConfirmationAction
              onClick={() => onApprove(toolPart.approval!.id)}
            >
              Approve
            </ConfirmationAction>
          </ConfirmationActions>
        </Confirmation>
      );

      expect(screen.getByText("Command: npm install -g pnpm")).toBeDefined();
      expect(screen.getByText("Approve this global install?")).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
      expect(onApprove).toHaveBeenCalledWith("approval-999");
    });

    it("works seamlessly with DynamicToolUIPart approval structure", () => {
      const dynamicPart: DynamicToolUIPart = {
        type: "dynamic-tool",
        toolName: "delete_skill",
        toolCallId: "call-dyn-888",
        state: "approval-requested",
        input: { skillName: "legacy-skill" },
        approval: {
          id: "approval-dyn-888",
        },
      };

      render(
        <Confirmation approval={dynamicPart.approval} state={dynamicPart.state}>
          <ConfirmationTitle>Tool: {dynamicPart.toolName}</ConfirmationTitle>
          <ConfirmationRequest>Are you sure you want to delete this skill?</ConfirmationRequest>
        </Confirmation>
      );

      expect(screen.getByText("Tool: delete_skill")).toBeDefined();
      expect(screen.getByText("Are you sure you want to delete this skill?")).toBeDefined();
    });
  });
});
