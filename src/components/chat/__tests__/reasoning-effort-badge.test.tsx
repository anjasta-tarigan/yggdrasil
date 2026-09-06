import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReasoningEffortBadge } from "../ReasoningEffortBadge";

describe("ReasoningEffortBadge", () => {
  it("renders default Auto state when no effort is active", () => {
    render(<ReasoningEffortBadge />);
    expect(screen.getByText("Reasoning: Auto")).toBeInTheDocument();
  });

  it("renders resolved effort tier when provided", () => {
    const { rerender } = render(<ReasoningEffortBadge activeEffort="xhigh" />);
    expect(screen.getByText("Reasoning: Extended")).toBeInTheDocument();

    rerender(<ReasoningEffortBadge activeEffort="high" />);
    expect(screen.getByText("Reasoning: High")).toBeInTheDocument();

    rerender(<ReasoningEffortBadge activeEffort="medium" />);
    expect(screen.getByText("Reasoning: Medium")).toBeInTheDocument();

    rerender(<ReasoningEffortBadge activeEffort="low" />);
    expect(screen.getByText("Reasoning: Low")).toBeInTheDocument();

    rerender(<ReasoningEffortBadge activeEffort="none" />);
    expect(screen.getByText("Reasoning: Direct")).toBeInTheDocument();
  });

  it("renders Thinking badge state with active effort when actively thinking", () => {
    render(<ReasoningEffortBadge activeEffort="high" isStreaming={true} isThinking={true} />);
    expect(screen.getByText("Thinking (High)")).toBeInTheDocument();
  });

  it("renders active effort label while streaming response tokens", () => {
    render(<ReasoningEffortBadge activeEffort="high" isStreaming={true} isThinking={false} />);
    expect(screen.getByText("Reasoning: High")).toBeInTheDocument();
  });
});
