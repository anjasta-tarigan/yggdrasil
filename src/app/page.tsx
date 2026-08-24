"use client";

import { DefaultChatTransport, type UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Header } from "@/components/header";
import { Sidebar } from "@/components/sidebar";
import { StatusFooter } from "@/components/status-footer";
import { useModels } from "@/hooks/use-models";
import { useSystemHealth } from "@/hooks/use-system-health";
import {
  createChatId,
  deleteChat,
  deriveTitle,
  loadChats,
  saveChat,
  type StoredChat,
} from "@/lib/chat-storage";
import { CaretUpDown, Check, Cpu, Tree } from "@phosphor-icons/react";

const MODEL_STORAGE_KEY = "yggdrasil:model";

type ChatAreaProps = {
  chatId: string;
  initialMessages: UIMessage[];
  onSettled: (chatId: string, messages: UIMessage[]) => void;
};

function ChatArea({ chatId, initialMessages, onSettled }: ChatAreaProps) {
  const [input, setInput] = useState("");
  const [model, setModel] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(MODEL_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [selectorOpen, setSelectorOpen] = useState(false);
  const { models, loading: modelsLoading } = useModels();

  const { messages, sendMessage, status, stop, error, regenerate } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    messages: initialMessages,
  });

  const isGenerating = status === "submitted" || status === "streaming";

  // Track the initial messages reference so we don't re-save an unchanged
  // chat on mount (which would needlessly bump its updatedAt).
  const initialRef = useRef(initialMessages);

  // Persist the conversation once a turn settles (ready or error).
  // This syncs with localStorage, an external system.
  useEffect(() => {
    if (status !== "ready" && status !== "error") return;
    if (messages === initialRef.current) return;
    onSettled(chatId, messages);
  }, [chatId, messages, status, onSettled]);

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      if (isGenerating || !message.text.trim()) return;
      sendMessage(
        { text: message.text },
        { body: model ? { model } : undefined }
      );
      setInput("");
    },
    [isGenerating, model, sendMessage]
  );

  const handleSelectModel = useCallback((id: string) => {
    setModel(id);
    setSelectorOpen(false);
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, id);
    } catch (error) {
      console.warn("Failed to persist selected model", error);
    }
  }, []);

  return (
    <div className="flex h-full w-full flex-col">
      <Conversation>
        <ConversationContent
          scrollClassName="conversation-scroll"
          className="px-4 md:px-6"
        >
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<Tree className="size-12" weight="thin" />}
              title="Yggdrasil"
              description="Your personal AI assistant. Ask anything to begin."
            />
          ) : (
            messages.map((message) => (
              <Message
                className={
                  // Cap the assistant block at 65% of the content area so its
                  // text never reaches the opposite (user) side. User messages
                  // stay full width and right-align their fit-content bubble.
                  message.role === "assistant" ? "max-w-[65%]" : "max-w-full"
                }
                from={message.role}
                key={message.id}
              >
                <MessageContent
                  className={
                    // Justify assistant prose; text-align inherits into the
                    // rendered markdown paragraphs.
                    message.role === "assistant" ? "text-justify" : undefined
                  }
                >
                  {message.parts.map((part, i) => {
                    switch (part.type) {
                      case "text":
                        return (
                          <MessageResponse key={`${message.id}-${i}`}>
                            {part.text}
                          </MessageResponse>
                        );
                      default:
                        return null;
                    }
                  })}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {error && (
        <div className="mx-auto mb-2 w-full max-w-3xl px-4 md:px-6">
          <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
            <span className="min-w-0 break-words">
              {error?.message || "Something went wrong."}
            </span>
            <Button
              className="shrink-0"
              onClick={() =>
                regenerate({ body: model ? { model } : undefined })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        </div>
      )}

      <PromptInput
        className="mx-auto mb-4 w-full max-w-3xl px-4 md:px-6"
        onSubmit={handleSubmit}
      >
        <PromptInputBody>
          <PromptInputTextarea
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message Yggdrasil..."
            value={input}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <ModelSelector onOpenChange={setSelectorOpen} open={selectorOpen}>
              <ModelSelectorTrigger asChild>
                <Button
                  aria-label="Select model"
                  className="max-w-[220px] gap-1.5 px-2 text-muted-foreground"
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Cpu className="size-3.5 shrink-0" />
                  <ModelSelectorName>
                    {model ?? "Default model"}
                  </ModelSelectorName>
                  <CaretUpDown className="size-3 shrink-0" />
                </Button>
              </ModelSelectorTrigger>
              <ModelSelectorContent title="Select a model">
                <ModelSelectorInput placeholder="Search models..." />
                <ModelSelectorList>
                  <ModelSelectorEmpty>
                    {modelsLoading ? "Loading models..." : "No models found."}
                  </ModelSelectorEmpty>
                  {[...new Set(models.map((id) => id.split("/")[0]))].map(
                    (group) => (
                      <ModelSelectorGroup heading={group} key={group}>
                        {models
                          .filter((id) => id.split("/")[0] === group)
                          .map((id) => (
                            <ModelSelectorItem
                              key={id}
                              onSelect={() => handleSelectModel(id)}
                              value={id}
                            >
                              <ModelSelectorName>{id}</ModelSelectorName>
                              {model === id ? (
                                <Check className="ml-auto size-4 shrink-0" />
                              ) : (
                                <div className="ml-auto size-4 shrink-0" />
                              )}
                            </ModelSelectorItem>
                          ))}
                      </ModelSelectorGroup>
                    )
                  )}
                </ModelSelectorList>
              </ModelSelectorContent>
            </ModelSelector>
            {isGenerating && (
              <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                <Spinner className="size-3" />
                {status === "submitted" ? "Thinking..." : "Responding..."}
              </span>
            )}
          </PromptInputTools>
          <div className="flex items-center gap-1">
            <PromptInputSubmit
              disabled={!input.trim() && !isGenerating}
              onStop={stop}
              status={status}
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

function AppShell() {
  // Initialized lazily on the client only (AppShell mounts after the
  // hydration gate), so localStorage reads never run during SSR.
  const [chats, setChats] = useState<StoredChat[]>(loadChats);
  const [activeChatId, setActiveChatId] = useState<string | null>(
    () => loadChats()[0]?.id ?? createChatId()
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const health = useSystemHealth();

  const refreshChats = useCallback(() => setChats(loadChats()), []);

  const handleSettled = useCallback(
    (chatId: string, messages: UIMessage[]) => {
      if (messages.length === 0) return;
      saveChat({
        id: chatId,
        title: deriveTitle(messages),
        updatedAt: Date.now(),
        messages,
      });
      refreshChats();
    },
    [refreshChats]
  );

  const handleNewChat = useCallback(() => {
    setActiveChatId(createChatId());
  }, []);

  const handleDeleteChat = useCallback(
    (id: string) => {
      deleteChat(id);
      const remaining = loadChats();
      setChats(remaining);
      setActiveChatId((current) =>
        current === id ? remaining[0]?.id ?? createChatId() : current
      );
    },
    []
  );

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar
          activeChatId={activeChatId}
          chats={chats}
          onDeleteChat={handleDeleteChat}
          onNewChat={handleNewChat}
          onSelect={setActiveChatId}
          onToggle={() => setSidebarOpen(false)}
          open={sidebarOpen}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <Header
            chatTitle={activeChat?.title ?? null}
            health={health}
            onToggleSidebar={() => setSidebarOpen(true)}
            sidebarOpen={sidebarOpen}
          />

          <div className="min-h-0 flex-1">
            {activeChatId && (
              <ChatArea
                chatId={activeChatId}
                initialMessages={activeChat?.messages ?? []}
                key={activeChatId}
                onSettled={handleSettled}
              />
            )}
          </div>
        </div>
      </div>

      <StatusFooter health={health} />
    </div>
  );
}

export default function Home() {
  // Gate on mount so localStorage is only touched client-side,
  // avoiding SSR hydration mismatches. useSyncExternalStore is the
  // lint-clean way to detect hydration completion (no setState in effect).
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  if (!mounted) {
    return (
      <main className="flex h-dvh items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </main>
    );
  }

  return <AppShell />;
}
