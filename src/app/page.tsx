"use client";

import { DefaultChatTransport, type UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { useCallback, useEffect, useState } from "react";
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
import { Sparkle, Trash, Tree } from "@phosphor-icons/react";

const STORAGE_KEY = "yggdrasil:chat:v1";

function loadStoredMessages(): UIMessage[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Keep only entries that look like UIMessages (id, role, parts).
    return parsed.filter(
      (m): m is UIMessage =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as UIMessage).id === "string" &&
        typeof (m as UIMessage).role === "string" &&
        Array.isArray((m as UIMessage).parts)
    );
  } catch (error) {
    console.warn("Failed to load stored chat messages", error);
    return [];
  }
}

function persistMessages(messages: UIMessage[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch (error) {
    console.warn("Failed to persist chat messages", error);
  }
}

function Chat() {
  const [input, setInput] = useState("");
  const [initialMessages] = useState<UIMessage[]>(loadStoredMessages);

  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
    regenerate,
    setMessages,
  } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    messages: initialMessages,
  });

  const isGenerating = status === "submitted" || status === "streaming";

  // Persist the conversation once a turn settles (ready or error).
  useEffect(() => {
    if (status === "ready" || status === "error") {
      persistMessages(messages);
    }
  }, [messages, status]);

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      if (isGenerating || !message.text.trim()) return;
      sendMessage({ text: message.text });
      setInput("");
    },
    [isGenerating, sendMessage]
  );

  const handleClear = useCallback(() => {
    setMessages([]);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.warn("Failed to clear stored chat messages", error);
    }
  }, [setMessages]);

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4">
      <Conversation>
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<Tree className="size-12" weight="thin" />}
              title="Yggdrasil"
              description="Your personal AI assistant. Ask anything to begin."
            />
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
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
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
          <span>Something went wrong.</span>
          <Button
            onClick={() => regenerate()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      )}

      <PromptInput className="mb-4" onSubmit={handleSubmit}>
        <PromptInputBody>
          <PromptInputTextarea
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message Yggdrasil..."
            value={input}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            {isGenerating && (
              <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                <Spinner className="size-3" />
                {status === "submitted" ? "Thinking..." : "Responding..."}
              </span>
            )}
          </PromptInputTools>
          <div className="flex items-center gap-1">
            <Button
              aria-label="Clear conversation"
              disabled={messages.length === 0 || isGenerating}
              onClick={handleClear}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Trash className="size-4" />
            </Button>
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

export default function Home() {
  // Gate on mount so localStorage is only touched client-side,
  // avoiding SSR hydration mismatches.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <main className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkle className="size-4 text-primary" weight="fill" />
          <h1 className="text-sm font-semibold">Yggdrasil</h1>
          <span className="text-muted-foreground text-xs">
            Personal AI Assistant
          </span>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {mounted ? (
          <Chat />
        ) : (
          <div className="flex size-full items-center justify-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        )}
      </div>
    </main>
  );
}
