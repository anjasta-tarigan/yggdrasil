import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ChatMessageRow } from "../ChatMessageRow";
import type { ChatUIMessage } from "@/app/api/chat/route";

afterEach(() => {
  cleanup();
});

describe("ChatMessageRow bubble layout constraints", () => {
  const dummyProps = {
    isLastMessage: false,
    isStreaming: false,
    onOpenArtifact: vi.fn(),
    onApproveTool: vi.fn(),
    onDenyTool: vi.fn(),
    onFeedback: vi.fn(),
    onRegenerate: vi.fn(),
  };

  it("constrains user message width so long text does not stretch full-width edge to edge", () => {
    const userMessage: ChatUIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Very long user prompt ".repeat(50) }],
    };

    const { container } = render(
      <ChatMessageRow {...dummyProps} message={userMessage} />
    );

    const messageRoot = container.firstChild as HTMLElement;
    expect(messageRoot).toBeDefined();

    // User message MUST NOT be max-w-full (which stretches 100% edge-to-edge)
    expect(messageRoot.className).not.toContain("max-w-full");
    // User message should have constrained max-w to keep negative space on the left
    expect(messageRoot.className).toMatch(/max-w-\[(80|85)%\]/);
  });

  it("applies responsive layout constraint for assistant message", () => {
    const assistantMessage: ChatUIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "Assistant response text" }],
    };

    const { container } = render(
      <ChatMessageRow {...dummyProps} message={assistantMessage} />
    );

    const messageRoot = container.firstChild as HTMLElement;
    expect(messageRoot).toBeDefined();
    // Assistant message should have bounded width
    expect(messageRoot.className).toMatch(/max-w-/);
  });

  it("does not render action buttons when assistant message has no content yet", () => {
    const emptyAssistantMessage: ChatUIMessage = {
      id: "assistant-empty",
      role: "assistant",
      parts: [],
    };

    const { queryByRole } = render(
      <ChatMessageRow {...dummyProps} isStreaming message={emptyAssistantMessage} />
    );

    // Copy, thumbs, etc. should not be present in the DOM
    expect(queryByRole("button", { name: /copy message/i })).toBeNull();
    expect(queryByRole("button", { name: /good response/i })).toBeNull();
    expect(queryByRole("button", { name: /bad response/i })).toBeNull();
  });

  it("renders warming-up indicator when assistant message is streaming and has no content yet", () => {
    const emptyAssistantMessage: ChatUIMessage = {
      id: "assistant-empty",
      role: "assistant",
      parts: [],
    };

    const { getByText } = render(
      <ChatMessageRow {...dummyProps} isStreaming message={emptyAssistantMessage} />
    );

    expect(getByText(/Warming up/i)).toBeDefined();
  });

  it("does not render warming-up indicator when assistant message is NOT streaming", () => {
    const emptyAssistantMessage: ChatUIMessage = {
      id: "assistant-empty-settled",
      role: "assistant",
      parts: [],
    };

    const { queryByText } = render(
      <ChatMessageRow
        {...dummyProps}
        isLastMessage
        isStreaming={false}
        message={emptyAssistantMessage}
      />
    );

    expect(queryByText(/Warming up/i)).toBeNull();
  });

  it("renders action buttons once assistant message has text content", () => {
    const assistantMessage: ChatUIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "Here is the response." }],
    };

    const { getByRole } = render(
      <ChatMessageRow {...dummyProps} message={assistantMessage} />
    );

    expect(getByRole("button", { name: /copy message/i })).toBeDefined();
    expect(getByRole("button", { name: /good response/i })).toBeDefined();
    expect(getByRole("button", { name: /bad response/i })).toBeDefined();
  });
});
