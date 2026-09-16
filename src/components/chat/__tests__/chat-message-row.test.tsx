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
});
