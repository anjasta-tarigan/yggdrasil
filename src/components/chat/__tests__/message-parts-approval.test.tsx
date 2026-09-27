import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MessageParts } from "@/components/chat/MessageParts";
import type { ChatUIMessage } from "@/app/api/chat/route";

// RTL auto-cleanup never registers in this setup (globals not enabled).
beforeEach(() => cleanup());
afterEach(() => cleanup());

const approvalRequested = {
  type: "tool-manage_subagent",
  toolCallId: "call-sub-1",
  state: "approval-requested",
  input: { action: "update", id: "sub_1", enabled: false },
  approval: { id: "approval-sub-1" },
} as unknown as ChatUIMessage["parts"][number];

const assistantMessage = (parts: ChatUIMessage["parts"]): ChatUIMessage =>
  ({ id: "msg-1", role: "assistant", parts }) as ChatUIMessage;

describe("MessageParts: tool approval rendering", () => {
  it("renders clickable Accept/Deny controls for a manage_subagent approval", () => {
    const onApproveTool = vi.fn();
    const onDenyTool = vi.fn();

    render(
      <MessageParts
        isLastMessage
        isStreaming={false}
        message={assistantMessage([approvalRequested])}
        onApproveTool={onApproveTool}
        onDenyTool={onDenyTool}
        onOpenArtifact={() => {}}
      />
    );

    // The user must have a way to answer the approval inline.
    const accept = screen.getByRole("button", { name: /accept/i });
    const deny = screen.getByRole("button", { name: /deny/i });

    fireEvent.click(accept);
    expect(onApproveTool).toHaveBeenCalledWith("approval-sub-1");

    fireEvent.click(deny);
    expect(onDenyTool).toHaveBeenCalledWith("approval-sub-1", expect.any(String));
  });

  it("renders clickable controls for any generic tool awaiting approval", () => {
    const genericApproval = {
      type: "tool-manage_cron_schedule",
      toolCallId: "call-cron-1",
      state: "approval-requested",
      input: { action: "delete", id: "cron_1" },
      approval: { id: "approval-cron-1" },
    } as unknown as ChatUIMessage["parts"][number];

    const onApproveTool = vi.fn();

    render(
      <MessageParts
        isLastMessage
        isStreaming={false}
        message={assistantMessage([genericApproval])}
        onApproveTool={onApproveTool}
        onDenyTool={() => {}}
        onOpenArtifact={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    expect(onApproveTool).toHaveBeenCalledWith("approval-cron-1");
  });

  it("renders controls for a research tool (web_search) awaiting approval", () => {
    // web_search normally folds into the research ChainOfThought trail, which
    // has no buttons — an approval there must still render its own card.
    const researchApproval = {
      type: "tool-web_search",
      toolCallId: "call-search-1",
      state: "approval-requested",
      input: { query: "gold price" },
      approval: { id: "approval-search-1" },
    } as unknown as ChatUIMessage["parts"][number];

    const onApproveTool = vi.fn();

    render(
      <MessageParts
        isLastMessage
        isStreaming={false}
        message={assistantMessage([researchApproval])}
        onApproveTool={onApproveTool}
        onDenyTool={() => {}}
        onOpenArtifact={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    expect(onApproveTool).toHaveBeenCalledWith("approval-search-1");
  });
});
