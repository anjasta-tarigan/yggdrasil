import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { UIMessage } from "ai";

// ---- Mocks ----
const addToolResult = vi.fn();
const addToolApprovalResponse = vi.fn();

vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn(() => ({
    messages: [] as UIMessage[],
    sendMessage: vi.fn(),
    setMessages: vi.fn(),
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
import { useChat } from "@ai-sdk/react";

const mockUseChat = vi.mocked(useChat);

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});
afterEach(() => cleanup());

const baseChatState = {
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
  status: "ready" as const,
  stop: vi.fn(),
  error: null,
  regenerate: vi.fn(),
  addToolResult,
  addToolApprovalResponse,
};

function createMockMessages(count: number): UIMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i + 1}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    parts: [{ type: "text" as const, text: `Message content number ${i + 1}` }],
  }));
}

function mockMessages(messages: UIMessage[]) {
  mockUseChat.mockImplementation(
    () =>
      ({
        ...baseChatState,
        messages,
      }) as unknown as ReturnType<typeof useChat>
  );
}

describe("ChatArea — Message Pagination & Load Previous", () => {
  it("does not render Load Previous button on a new/empty chat session", () => {
    mockMessages([]);

    render(
      <ChatArea
        chatId="chat-empty"
        initialMessages={[]}
        model={null}
        onSelectModel={() => {}}
        onSettled={() => {}}
      />
    );

    expect(
      screen.queryByRole("button", { name: /load previous messages/i })
    ).toBeNull();
  });

  it("does not render Load Previous button when message count is within DEFAULT_MESSAGES_PAGE_SIZE", () => {
    const messages = createMockMessages(5);
    mockMessages(messages);

    render(
      <ChatArea
        chatId="chat-small"
        initialMessages={messages}
        model={null}
        onSelectModel={() => {}}
        onSettled={() => {}}
      />
    );

    // All 5 messages should be visible
    for (let i = 1; i <= 5; i++) {
      expect(screen.getByText(`Message content number ${i}`)).toBeDefined();
    }

    // Load previous button must NOT appear
    expect(
      screen.queryByRole("button", { name: /load previous messages/i })
    ).toBeNull();
  });

  it("limits visible messages to DEFAULT_MESSAGES_PAGE_SIZE and shows Load Previous button when count exceeds limit", () => {
    // 25 messages total
    const messages = createMockMessages(25);
    mockMessages(messages);

    render(
      <ChatArea
        chatId="chat-large"
        initialMessages={messages}
        model={null}
        onSelectModel={() => {}}
        onSettled={() => {}}
      />
    );

    // Button should be visible, stating 10 older messages remain
    const loadBtn = screen.getByRole("button", { name: /load previous messages/i });
    expect(loadBtn).toBeDefined();
    expect(loadBtn.textContent).toContain("10 older");

    // The first 10 messages (1-10) should NOT be rendered in DOM
    expect(screen.queryByText("Message content number 1")).toBeNull();
    expect(screen.queryByText("Message content number 10")).toBeNull();

    // The last 15 messages (11-25) should be rendered in DOM
    expect(screen.getByText("Message content number 11")).toBeDefined();
    expect(screen.getByText("Message content number 25")).toBeDefined();
  });

  it("loads older messages on clicking Load Previous button and hides button when all messages are loaded", () => {
    // 25 messages total: 10 older + 15 initial visible
    const messages = createMockMessages(25);
    mockMessages(messages);

    render(
      <ChatArea
        chatId="chat-large"
        initialMessages={messages}
        model={null}
        onSelectModel={() => {}}
        onSettled={() => {}}
      />
    );

    const loadBtn = screen.getByRole("button", { name: /load previous messages/i });
    expect(loadBtn).toBeDefined();

    // Click to load previous batch
    fireEvent.click(loadBtn);

    // Now all 25 messages should be visible
    expect(screen.getByText("Message content number 1")).toBeDefined();
    expect(screen.getByText("Message content number 10")).toBeDefined();
    expect(screen.getByText("Message content number 25")).toBeDefined();

    // All messages loaded; button should no longer exist
    expect(
      screen.queryByRole("button", { name: /load previous messages/i })
    ).toBeNull();
  });
});
