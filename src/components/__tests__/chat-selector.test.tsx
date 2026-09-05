import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { UIMessage } from "ai";
import { ChatArea } from "@/components/chat/ChatArea";

vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn(() => ({
    messages: [] as UIMessage[],
    sendMessage: vi.fn(),
    status: "ready",
    stop: vi.fn(),
    error: null,
    regenerate: vi.fn(),
    addToolResult: vi.fn(),
    addToolApprovalResponse: vi.fn(),
  })),
}));

vi.mock("@/hooks/use-plugin-commands", () => ({
  usePluginCommands: () => ({ expand: (t: string) => t }),
}));

const mockGroups = [
  {
    providerId: "server",
    providerName: "This server",
    kind: "openai-compatible" as const,
    models: [
      {
        modelId: "ps/poolside/laguna-s-2.1",
        displayName: "Laguna 2.1",
        isDefault: true,
        capabilities: {
          contextWindow: 128000,
          maxOutputTokens: 8192,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsToolCalls: true,
          supportsReasoning: false,
        },
        capabilitySources: {},
      },
    ],
  },
  {
    providerId: "empty-provider",
    providerName: "Empty Provider",
    kind: "ollama" as const,
    models: [],
  },
];

vi.mock("@/hooks/use-registered-models", () => ({
  useRegisteredModels: () => ({
    groups: mockGroups,
    loading: false,
    refresh: vi.fn(),
  }),
}));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("ChatArea curated model selector", () => {
  it("shows displayName rather than raw modelId in the trigger", () => {
    render(
      <ChatArea
        chatId="chat-1"
        initialMessages={[]}
        model="server::ps/poolside/laguna-s-2.1"
        onSelectModel={() => {}}
        onSettled={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: "Select model" })).toHaveTextContent(
      "Laguna 2.1"
    );
  });

  it("shows displayName in selector items and selects with encodeModelRef", () => {
    const onSelectModel = vi.fn();
    render(
      <ChatArea
        chatId="chat-1"
        initialMessages={[]}
        model="server::ps/poolside/laguna-s-2.1"
        onSelectModel={onSelectModel}
        onSettled={() => {}}
      />
    );

    // Open selector dialog / popover
    fireEvent.click(screen.getByRole("button", { name: "Select model" }));

    const matching = screen.getAllByText("Laguna 2.1");
    expect(matching.length).toBeGreaterThanOrEqual(2); // In trigger AND in menu item

    // Click on the menu item (the second one)
    fireEvent.click(matching[1]);
    expect(onSelectModel).toHaveBeenCalledWith("server::ps/poolside/laguna-s-2.1");
  });

  it("shows empty state when a provider has no models", () => {
    render(
      <ChatArea
        chatId="chat-1"
        initialMessages={[]}
        model="server::ps/poolside/laguna-s-2.1"
        onSelectModel={() => {}}
        onSettled={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Select model" }));

    expect(
      screen.getByText("No models added — add one in Settings → Providers.")
    ).toBeInTheDocument();
  });
});
