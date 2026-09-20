import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";

// ---- Mocks (installed before imports below) ----

const addToolResult = vi.fn();
const addToolApprovalResponse = vi.fn();

vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn(() => ({
    messages: [] as UIMessage[],
    sendMessage: vi.fn(),
    status: "ready",
    stop: vi.fn(),
    error: null,
    regenerate: vi.fn(),
    addToolResult,
    addToolApprovalResponse,
  })),
  experimental_MCPAppRenderer: vi.fn(() => null),
}));

vi.mock("@/hooks/use-registered-models", () => ({
  useRegisteredModels: () => ({ groups: [], loading: false, refresh: vi.fn() }),
}));

vi.mock("@/hooks/use-plugin-commands", () => ({
  usePluginCommands: () => ({ expand: (t: string) => t }),
}));

import { ChatArea } from "@/components/chat/ChatArea";

// Allows per-test control of the mocked useChat state.
import { useChat } from "@ai-sdk/react";
const mockUseChat = vi.mocked(useChat);

// RTL auto-cleanup never registers in this setup (globals not enabled).
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});
afterEach(() => cleanup());

const pendingQuestionPart = {
  type: "tool-ask_user_question",
  toolCallId: "call-q-1",
  state: "input-available",
  input: {
    questions: [
      {
        question: "Which database?",
        header: "Database",
        multiSelect: false,
        options: [
          { label: "PostgreSQL", description: "relational" },
          { label: "SQLite", description: "embedded" },
        ],
      },
    ],
  },
} as unknown as UIMessage["parts"][number];

const assistantMessageWith = (parts: UIMessage["parts"]): UIMessage =>
  ({ id: "msg-a", role: "assistant", parts }) as UIMessage;

const baseChatState = {
  sendMessage: vi.fn(),
  status: "ready" as const,
  stop: vi.fn(),
  error: null,
  regenerate: vi.fn(),
  addToolResult,
  addToolApprovalResponse,
};

function mockMessages(messages: UIMessage[]) {
  mockUseChat.mockImplementation(
    () => ({ ...baseChatState, messages }) as unknown as ReturnType<
      typeof useChat
    >
  );
}

const renderChatArea = () =>
  render(
    <ChatArea
      chatId="chat-1"
      initialMessages={[]}
      model={null}
      onSelectModel={() => {}}
      onSettled={() => {}}
    />
  );

describe("ChatArea: ask_user_question popup wiring", () => {
  it("opens the QuestionModal popup when a question is pending", () => {
    mockMessages([assistantMessageWith([pendingQuestionPart])]);
    renderChatArea();

    // The popup dialog renders the question — not inline in the feed.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Which database?")).toBeInTheDocument();
  });

  it("resolves the tool call via addToolResult when the user answers", async () => {
    mockMessages([assistantMessageWith([pendingQuestionPart])]);
    renderChatArea();

    fireEvent.click(screen.getByRole("button", { name: /PostgreSQL/i }));

    await waitFor(() => {
      expect(addToolResult).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: "ask_user_question",
          toolCallId: "call-q-1",
          state: "output-available",
          output: {
            answers: { "Which database?": "PostgreSQL" },
          },
        })
      );
    });
  });

  it("does not open the popup when no question is pending", () => {
    mockMessages([]);
    renderChatArea();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("declines via addToolResult when the popup is dismissed", async () => {
    mockMessages([assistantMessageWith([pendingQuestionPart])]);
    renderChatArea();

    // Dismiss with Escape (dialog content handles Escape → onOpenChange(false) → decline).
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => {
      expect(addToolResult).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallId: "call-q-1",
          state: "output-available",
          output: {
            answers: { "Which database?": "User declined to answer the question." },
          },
        })
      );
    });
  });
});
