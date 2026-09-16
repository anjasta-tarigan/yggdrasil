import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { ChatMessageRow } from "@/components/chat/ChatMessageRow";
import type { ChatUIMessage } from "@/app/api/chat/route";

// Mock the topic drift detector — real embeddings are too heavy for unit tests.
const mockDetectTopicDrift = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/pipeline/topic-drift-detector", () => ({
  detectTopicDrift: mockDetectTopicDrift,
}));

// Mock the quality scanner to always surface the quality indicator so
// the drift check is triggered.
vi.mock("@/lib/ai/pipeline/quality-scanner", () => ({
  evaluateMessageQuality: vi.fn().mockReturnValue({
    shouldDisplay: true,
    score: 40,
    tier: "moderate",
    summary: "Moderate buzzwords or generic template structures",
    flaggedPatterns: ["robust"],
    codeIssues: [],
    signalPercent: 60,
  }),
}));

const noop = () => {};

const baseProps = {
  isLastMessage: false,
  isStreaming: false,
  onOpenArtifact: noop,
  onApproveTool: noop,
  onDenyTool: noop,
  onFeedback: noop,
  onRegenerate: noop,
};

const assistantMessage = (text: string): ChatUIMessage =>
  ({
    id: "msg-1",
    role: "assistant",
    parts: [{ type: "text", text }],
  } as ChatUIMessage);

describe("ChatMessageRow — topic drift warning", () => {
  // RTL auto-cleanup not configured in vitest.setup; clean up manually.
  beforeEach(() => {
    mockDetectTopicDrift.mockReset();
    cleanup();
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("shows a drift warning icon when topic drift is detected", async () => {
    mockDetectTopicDrift.mockResolvedValue({
      driftDetected: true,
      confidence: 0.75,
      sentences: ["a", "b", "c"],
      threshold: 0.35,
      minSimilarity: 0.15,
    });

    render(
      <ChatMessageRow
        {...baseProps}
        message={assistantMessage(
          "To reset your password, navigate to the login page. Meanwhile, the weather has been unusual this year. Many people have noticed changes in their local ecosystems and migration patterns."
        )}
      />
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Possible topic drift detected" })
      ).toBeInTheDocument();
    });
  });

  it("does not show drift warning when no drift detected", async () => {
    mockDetectTopicDrift.mockResolvedValue({
      driftDetected: false,
      confidence: 0,
      sentences: ["a", "b", "c"],
      threshold: 0.35,
      minSimilarity: 0.8,
    });

    render(
      <ChatMessageRow
        {...baseProps}
        message={assistantMessage(
          "To reset your password, navigate to the login page and click Forgot. Enter your email and submit the form. Check your inbox for a reset link."
        )}
      />
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Possible topic drift detected" })
      ).toBeNull();
    });
  });

  it("does not call drift detector for user messages", async () => {
    render(
      <ChatMessageRow
        {...baseProps}
        message={
          {
            id: "msg-2",
            role: "user",
            parts: [{ type: "text", text: "Hello, how are you today?" }],
          } as ChatUIMessage
        }
      />
    );

    expect(mockDetectTopicDrift).not.toHaveBeenCalled();
  });
});
