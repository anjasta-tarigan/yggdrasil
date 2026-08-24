"use client";

import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { useChat } from "@ai-sdk/react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
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
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
} from "@/components/ai-elements/task";
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
import {
  CheckCircleIcon,
  CircleIcon,
  GlobeIcon,
  LoaderCircleIcon,
  SearchIcon,
} from "lucide-react";
import { normalizeLatexDelimiters } from "@/lib/latex";

const MODEL_STORAGE_KEY = "yggdrasil:model";

type ChatAreaProps = {
  chatId: string;
  initialMessages: UIMessage[];
  model: string | null;
  onSelectModel: (id: string) => void;
  onSettled: (chatId: string, messages: UIMessage[]) => void;
};

/** Tools rendered as ChainOfThought research steps instead of Tool cards. */
const RESEARCH_TOOLS = new Set(["web_search", "fetch_page"]);

/** The tool whose invocations are rendered as a Task checklist. */
const TASK_TOOL = "manage_tasks";

type SearchOutput = {
  query?: string;
  results?: Array<{ title?: string; url?: string; snippet?: string }>;
};

type FetchOutput = {
  url?: string;
  title?: string;
  markdown?: string;
  truncated?: boolean;
};

type TaskItemData = {
  text: string;
  status: "pending" | "in_progress" | "completed";
};

type TasksListData = {
  title?: string;
  items?: TaskItemData[];
};

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Renders one message's parts:
 * - reasoning parts consolidated into a single collapsible <Reasoning> block
 *   that auto-opens while the last message is still streaming reasoning;
 * - web_search / fetch_page invocations synthesized into one ChainOfThought
 *   research trail;
 * - the latest manage_tasks invocation rendered as a Task checklist;
 * - any other tool invocations rendered as collapsible Tool cards;
 * - text parts with LaTeX delimiter normalization + Streamdown rendering.
 */
function MessageParts({
  message,
  isLastMessage,
  isStreaming,
}: {
  message: UIMessage;
  isLastMessage: boolean;
  isStreaming: boolean;
}) {
  const reasoningParts = message.parts.filter(
    (part) => part.type === "reasoning"
  );
  const reasoningText = reasoningParts.map((part) => part.text).join("\n\n");
  const hasReasoning = reasoningParts.length > 0;

  // Reasoning is "streaming" only while the last message's most recent part
  // is still a reasoning part and the chat is actively streaming.
  const lastPart = message.parts.at(-1);
  const isReasoningStreaming =
    isLastMessage && isStreaming && lastPart?.type === "reasoning";

  const toolParts = message.parts.filter(isToolUIPart);
  const researchParts = toolParts.filter((part) =>
    RESEARCH_TOOLS.has(getToolName(part))
  );
  const taskParts = toolParts.filter(
    (part) => getToolName(part) === TASK_TOOL
  );
  // Each manage_tasks call replaces the list, so only the latest matters.
  const latestTaskPart = taskParts.at(-1);

  return (
    <>
      {hasReasoning && (
        <Reasoning className="w-full" isStreaming={isReasoningStreaming}>
          <ReasoningTrigger />
          <ReasoningContent>{reasoningText}</ReasoningContent>
        </Reasoning>
      )}
      {researchParts.length > 0 && <ResearchTrail parts={researchParts} />}
      {latestTaskPart && <TaskList part={latestTaskPart} />}
      {message.parts.map((part, i) => {
        if (isToolUIPart(part)) {
          const name = getToolName(part);
          // Already rendered above as CoT steps / Task checklist.
          if (RESEARCH_TOOLS.has(name) || name === TASK_TOOL) return null;
          return <ToolInvocation key={`${message.id}-${i}`} part={part} />;
        }
        switch (part.type) {
          case "text":
            return (
              <MessageResponse key={`${message.id}-${i}`}>
                {normalizeLatexDelimiters(part.text)}
              </MessageResponse>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/**
 * Synthesizes a step-by-step research trail from web_search / fetch_page
 * tool invocations using the ChainOfThought component.
 */
function ResearchTrail({
  parts,
}: {
  parts: Array<ToolUIPart | DynamicToolUIPart>;
}) {
  return (
    <ChainOfThought className="mb-4" defaultOpen>
      <ChainOfThoughtHeader>
        {`Research — ${parts.length} step${parts.length === 1 ? "" : "s"}`}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {parts.map((part) => {
          const name = getToolName(part);
          const running =
            part.state === "input-streaming" ||
            part.state === "input-available";
          const status = running ? "active" : "complete";
          const input = (part.input ?? {}) as Record<string, unknown>;
          const output =
            part.state === "output-available" ? part.output : undefined;

          if (name === "web_search") {
            const query = String(input.query ?? "");
            const results = (output as SearchOutput | undefined)?.results;
            return (
              <ChainOfThoughtStep
                icon={SearchIcon}
                key={part.toolCallId}
                label={`${running ? "Searching" : "Searched"} for “${query}”`}
                status={status}
              >
                {results && results.length > 0 && (
                  <ChainOfThoughtSearchResults>
                    {results.slice(0, 5).map((result, i) => (
                      <ChainOfThoughtSearchResult key={result.url ?? i}>
                        {result.url ? safeHostname(result.url) : result.title}
                      </ChainOfThoughtSearchResult>
                    ))}
                  </ChainOfThoughtSearchResults>
                )}
              </ChainOfThoughtStep>
            );
          }

          // fetch_page
          const url = String(input.url ?? "");
          const title = (output as FetchOutput | undefined)?.title;
          return (
            <ChainOfThoughtStep
              description={title}
              icon={GlobeIcon}
              key={part.toolCallId}
              label={`${running ? "Fetching" : "Fetched"} ${url ? safeHostname(url) : "page"}`}
              status={status}
            />
          );
        })}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

const taskStatusIcon: Record<TaskItemData["status"], ReactNode> = {
  pending: <CircleIcon className="size-3.5 shrink-0" />,
  in_progress: (
    <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
  ),
  completed: <CheckCircleIcon className="size-3.5 shrink-0 text-green-600" />,
};

/**
 * Renders the latest manage_tasks invocation as a Task checklist.
 */
function TaskList({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const output =
    part.state === "output-available"
      ? (part.output as TasksListData | undefined)
      : undefined;
  const input = (part.input ?? {}) as TasksListData;
  const title = output?.title ?? input.title ?? "Task plan";
  const items = output?.items ?? input.items ?? [];
  const completed = items.filter((item) => item.status === "completed").length;

  return (
    <Task className="mb-4" defaultOpen>
      <TaskTrigger title={`${title} (${completed}/${items.length})`} />
      <TaskContent>
        {items.map((item, i) => (
          <TaskItem key={`${item.text}-${i}`}>
            <span className="inline-flex items-center gap-2">
              {taskStatusIcon[item.status] ?? taskStatusIcon.pending}
              {item.text}
            </span>
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}

/**
 * Renders a single tool invocation part (static `tool-*` or `dynamic-tool`)
 * using the collapsible Tool component. Completed and errored tools open by
 * default so their results are visible immediately.
 */
function ToolInvocation({
  part,
}: {
  part: ToolUIPart | DynamicToolUIPart;
}) {
  const showOpen =
    part.state === "output-available" || part.state === "output-error";

  return (
    <Tool defaultOpen={showOpen}>
      {part.type === "dynamic-tool" ? (
        <ToolHeader state={part.state} toolName={part.toolName} type={part.type} />
      ) : (
        <ToolHeader state={part.state} type={part.type} />
      )}
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput errorText={part.errorText} output={part.output} />
      </ToolContent>
    </Tool>
  );
}

function ChatArea({
  chatId,
  initialMessages,
  model,
  onSelectModel,
  onSettled,
}: ChatAreaProps) {
  const [input, setInput] = useState("");
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

  const handleSelectModel = useCallback(
    (id: string) => {
      onSelectModel(id);
      setSelectorOpen(false);
    },
    [onSelectModel]
  );

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
            messages.map((message, index) => (
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
                  <MessageParts
                    isLastMessage={index === messages.length - 1}
                    isStreaming={status === "streaming"}
                    message={message}
                  />
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
  // The selected model is lifted here so the header, footer, and the
  // prompt-input selector all stay in sync.
  const [model, setModel] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(MODEL_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const health = useSystemHealth();

  const handleSelectModel = useCallback((id: string) => {
    setModel(id);
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, id);
    } catch (error) {
      console.warn("Failed to persist selected model", error);
    }
  }, []);

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
            model={model}
            onToggleSidebar={() => setSidebarOpen(true)}
            sidebarOpen={sidebarOpen}
          />

          <div className="min-h-0 flex-1">
            {activeChatId && (
              <ChatArea
                chatId={activeChatId}
                initialMessages={activeChat?.messages ?? []}
                key={activeChatId}
                model={model}
                onSelectModel={handleSelectModel}
                onSettled={handleSettled}
              />
            )}
          </div>
        </div>
      </div>

      <StatusFooter health={health} model={model} />
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
