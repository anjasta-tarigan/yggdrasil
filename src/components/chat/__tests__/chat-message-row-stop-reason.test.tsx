import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { ChatMessageRow } from "@/components/chat/ChatMessageRow";
import type { ChatUIMessage } from "@/app/api/chat/route";
import type { HarnessStopReason } from "@/lib/ai/harness-loop";

// Topic drift uses real embeddings; the footer's stop-reason line does not
// depend on it, so stub it out (same pattern as the drift test file).
const mockDetectTopicDrift = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/pipeline/topic-drift-client", () => ({
  detectTopicDrift: mockDetectTopicDrift,
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

const assistantMessage = (
  stopReason: HarnessStopReason | undefined,
  text = "Done."
): ChatUIMessage =>
  ({
    id: "msg-1",
    role: "assistant",
    parts: [{ type: "text", text }],
    ...(stopReason ? { metadata: { stopReason } } : {}),
  } as ChatUIMessage);

describe("ChatMessageRow — harness stop reason", () => {
  beforeEach(() => {
    mockDetectTopicDrift.mockReset();
    mockDetectTopicDrift.mockResolvedValue({ driftDetected: false });
    cleanup();
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("labels a step cap", async () => {
    render(<ChatMessageRow {...baseProps} message={assistantMessage("step-cap")} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /step limit reached/i })
      ).toBeInTheDocument();
    });
  });

  it("labels a context wrap-up", async () => {
    render(
      <ChatMessageRow {...baseProps} message={assistantMessage("context-wrap-up")} />
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /context limit reached/i })
      ).toBeInTheDocument();
    });
  });

  it("labels an output cap", async () => {
    render(<ChatMessageRow {...baseProps} message={assistantMessage("output-cap")} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /output truncated/i })
      ).toBeInTheDocument();
    });
  });

  it("renders nothing extra for a natural stop", async () => {
    render(<ChatMessageRow {...baseProps} message={assistantMessage("natural")} />);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /step limit reached/i })
      ).toBeNull();
    });
    expect(
      screen.queryByRole("button", { name: /output truncated/i })
    ).toBeNull();
  });

  it("renders nothing extra when no stop reason is set (regular chat)", async () => {
    render(<ChatMessageRow {...baseProps} message={assistantMessage(undefined)} />);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /step limit reached/i })
      ).toBeNull();
    });
  });

  it("still labels the stop when the message has no visible content", async () => {
    render(
      <ChatMessageRow
        {...baseProps}
        message={assistantMessage("error", "")}
      />
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /run failed/i })
      ).toBeInTheDocument();
    });
  });
});
