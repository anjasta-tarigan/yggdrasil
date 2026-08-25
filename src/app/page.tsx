"use client";

import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type LanguageModelUsage,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { useChat } from "@ai-sdk/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
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
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from "@/components/ai-elements/context";
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
import { SettingsView } from "@/components/settings-view";
import {
  ARTIFACT_PANEL_EXIT_MS,
  ArtifactPanel,
} from "@/components/artifact-panel";
import { StatusFooter } from "@/components/status-footer";
import { cn } from "@/lib/utils";
import { useProviderModels } from "@/hooks/use-provider-models";
import { useSystemHealth } from "@/hooks/use-system-health";
import {
  ARTIFACT_TOOL,
  buildArtifactFromToolOutput,
  collectArtifacts,
  type ChatArtifact,
} from "@/lib/artifacts";
import {
  createChatId,
  deleteChat,
  deriveTitle,
  loadChats,
  saveChat,
  updateChatMeta,
  type StoredChat,
} from "@/lib/chat-storage";
import { chatRequestBody, decodeModelRef, encodeModelRef } from "@/lib/settings";
import { CaretUpDown, Check, Cpu, Tree } from "@phosphor-icons/react";
import {
  CheckCircleIcon,
  CircleIcon,
  FileCodeIcon,
  FileTextIcon,
  GlobeIcon,
  LoaderCircleIcon,
  SearchIcon,
} from "lucide-react";
import { normalizeLatexDelimiters } from "@/lib/latex";

const MODEL_STORAGE_KEY = "yggdrasil:model";

/**
 * Fallback context window when the server doesn't report one for the
 * selected model. Most models served here expose `context_length`, so this
 * only applies while the model list is unavailable.
 */
const FALLBACK_CONTEXT_TOKENS = 128_000;

/** Rough client-side token estimate (~4 chars/token, English prose). */
const CHARS_PER_TOKEN = 4;

function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

const compactTokenFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

/** "12K", "1M", ... matching the Context component's own formatting. */
function formatTokenCount(tokens: number): string {
  return compactTokenFormat.format(tokens);
}

/**
 * Real usage reported by the server for a turn (attached to assistant
 * message metadata on every finish-step; the last step wins). Undefined
 * for messages that predate this feature or carry no numbers.
 */
function usageOf(message: UIMessage): LanguageModelUsage | undefined {
  const meta = message.metadata as { usage?: LanguageModelUsage } | undefined;
  const usage = meta?.usage;
  if (!usage) return undefined;
  if (usage.inputTokens == null && usage.outputTokens == null) return undefined;
  return usage;
}

/** Approximate character count of everything a message contributes. */
function messageChars(message: UIMessage): number {
  let chars = 0;
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "reasoning") {
      chars += part.text.length;
    } else if (isToolUIPart(part)) {
      chars += JSON.stringify(part.input ?? {}).length;
      if (part.state === "output-available") {
        chars += JSON.stringify(part.output ?? {}).length;
      }
    }
  }
  return chars;
}

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
 * Compact inline reference to a created artifact; clicking opens the
 * side panel on it. Semantic button per spec accessibility requirements.
 */
function ArtifactChip({
  artifact,
  errorText,
  onOpen,
}: {
  artifact?: ChatArtifact;
  /** When set, renders the error variant instead of opening a panel. */
  errorText?: string;
  onOpen: (artifact: ChatArtifact) => void;
}) {
  if (errorText) {
    return (
      <span className="flex max-w-xs items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-2 pr-3 text-xs text-destructive">
        <FileCodeIcon className="size-4 shrink-0" />
        Artifact failed: {errorText}
      </span>
    );
  }

  const current = artifact!;
  const Icon = current.kind === "document" ? FileTextIcon : FileCodeIcon;
  return (
    <button
      aria-label={`${current.title} — ${current.kind}. ${current.description}`}
      className="flex max-w-xs items-center gap-2.5 rounded-xl border bg-muted/40 p-2 pr-3 text-left transition-colors hover:bg-muted"
      onClick={() => onOpen(current)}
      type="button"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground text-xs">
          {current.title}
        </span>
        <span className="block truncate text-muted-foreground text-[11px]">
          {current.description}
        </span>
      </span>
    </button>
  );
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
  onOpenArtifact,
}: {
  message: UIMessage;
  isLastMessage: boolean;
  isStreaming: boolean;
  onOpenArtifact: (artifact: ChatArtifact) => void;
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

  // create_artifact chips (output-available) and error chips
  // (output-error); these parts never fall through to Tool cards.
  const artifactChips: ReactNode[] = [];
  if (message.role === "assistant") {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      if (getToolName(part) !== ARTIFACT_TOOL) continue;
      if (part.state === "output-available") {
        const built = buildArtifactFromToolOutput(part.toolCallId, part.output);
        if (built) {
          artifactChips.push(
            <ArtifactChip
              artifact={built}
              key={`chip-${part.toolCallId}`}
              onOpen={onOpenArtifact}
            />
          );
        }
      } else if (part.state === "output-error") {
        artifactChips.push(
          <ArtifactChip
            errorText={part.errorText}
            key={`chip-${part.toolCallId}`}
            onOpen={onOpenArtifact}
          />
        );
      }
    }
  }

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
      {artifactChips.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">{artifactChips}</div>
      )}
      {message.parts.map((part, i) => {
        if (isToolUIPart(part)) {
          const name = getToolName(part);
          // Already rendered above as CoT steps / Task checklist / chips.
          if (
            RESEARCH_TOOLS.has(name) ||
            name === TASK_TOOL ||
            name === ARTIFACT_TOOL
          ) {
            return null;
          }
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
  const { groups, loading: modelsLoading } = useProviderModels();

  const { messages, sendMessage, status, stop, error, regenerate } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    messages: initialMessages,
  });

  // Auto-detected context limits for the active model. The qualified
  // ref "providerId::modelId" is resolved inside its provider group
  // (only the server group reports real context windows).
  const modelRef = decodeModelRef(model);
  const activeModelInfo = modelRef.modelId
    ? (groups
        .find((g) => g.providerId === modelRef.providerId)
        ?.models.find((m) => m.id === modelRef.modelId) ?? null)
    : null;
  const maxContextTokens =
    activeModelInfo?.contextLength ?? FALLBACK_CONTEXT_TOKENS;
  const maxOutputTokens = activeModelInfo?.maxOutputTokens ?? null;

  // Real-time context usage. The latest server-reported usage anchors the
  // count (its inputTokens is the final request's whole prompt, outputTokens
  // its completion); anything after it — a streaming in-flight answer, a new
  // user message — plus the draft being typed is estimated at ~4 chars/token
  // and self-corrects every time the next finish-step reports real numbers.
  const usedTokens = useMemo(() => {
    let anchorIndex = -1;
    let anchorUsage: LanguageModelUsage | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const usage = usageOf(messages[i]);
      if (usage) {
        anchorIndex = i;
        anchorUsage = usage;
        break;
      }
    }

    let used = 0;
    if (anchorUsage) {
      used +=
        (anchorUsage.inputTokens ?? 0) + (anchorUsage.outputTokens ?? 0);
    }
    // Without an anchor (fresh chat / pre-feature history) estimate it all.
    const tail = anchorIndex >= 0 ? messages.slice(anchorIndex + 1) : messages;
    for (const message of tail) {
      used += estimateTokens(messageChars(message));
    }
    used += estimateTokens(input.length);
    return used;
  }, [messages, input]);

  // ---- Artifact panel state (spec §3.5) ----
  const [openArtifact, setOpenArtifact] = useState<ChatArtifact | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [closingArtifact, setClosingArtifact] = useState<ChatArtifact | null>(
    null
  );
  // Track the newest artifact ID present when the chat mounted so that
  // historical artifacts are NOT auto-opened on page reload/refresh or chat switch.
  // Only genuinely new artifacts arriving during the active session will auto-open.
  const initialArtifactId = useMemo(
    () => collectArtifacts(initialMessages).at(-1)?.id ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [seenArtifactId, setSeenArtifactId] = useState<string | null>(
    initialArtifactId
  );

  const artifactIndex = useMemo(() => collectArtifacts(messages), [messages]);
  // Newest artifact is the tail of the same index — no second scan.
  const latestArtifactItem = artifactIndex.at(-1) ?? null;

  // Auto-open newest only if it arrived dynamically during the active session
  // (its id is distinct from seenArtifactId and initial mount state).
  if (latestArtifactItem && latestArtifactItem.id !== seenArtifactId) {
    setSeenArtifactId(latestArtifactItem.id);
    if (!pinnedId) {
      if (closingArtifact) setClosingArtifact(null);
      setOpenArtifact(latestArtifactItem);
    }
  }

  // Release the exit-animation hold once the slide-out (duration-300)
  // finishes so the stale artifact unmounts and the panel stays closed.
  useEffect(() => {
    if (!closingArtifact) return;
    const timer = window.setTimeout(
      () => setClosingArtifact(null),
      ARTIFACT_PANEL_EXIT_MS
    );
    return () => window.clearTimeout(timer);
  }, [closingArtifact]);

  const handleOpenArtifact = useCallback((artifact: ChatArtifact) => {
    setOpenArtifact(artifact);
    setPinnedId(artifact.id);
  }, []);

  const handleClosePanel = useCallback(() => {
    setClosingArtifact(openArtifact);
    setOpenArtifact(null);
    setPinnedId(null);
  }, [openArtifact]);

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
        // Model selection + any Settings-page provider overrides.
        { body: chatRequestBody(model) }
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
    <div className="flex h-full w-full min-h-0">
      <div className="flex h-full min-w-0 flex-1 flex-col">
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
                      onOpenArtifact={handleOpenArtifact}
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
                  regenerate({ body: chatRequestBody(model) })
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
                      {modelRef.modelId ?? "Default model"}
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
                    {/* Tree view: one group per active provider. */}
                    {groups.map((group) => (
                      <ModelSelectorGroup
                        heading={group.providerName}
                        key={group.providerId}
                      >
                        {group.error && group.models.length === 0 ? (
                          <p className="px-2 py-1.5 text-muted-foreground text-xs">
                            Unreachable — check the provider in Settings.
                          </p>
                        ) : (
                          group.models.map((m) => {
                            const ref = encodeModelRef(group.providerId, m.id);
                            return (
                              <ModelSelectorItem
                                key={ref}
                                onSelect={() => handleSelectModel(ref)}
                                value={`${group.providerName} ${m.id}`}
                              >
                                <ModelSelectorName>{m.id}</ModelSelectorName>
                                {model === ref ? (
                                  <Check className="ml-auto size-4 shrink-0" />
                                ) : (
                                  <div className="ml-auto size-4 shrink-0" />
                                )}
                              </ModelSelectorItem>
                            );
                          })
                        )}
                      </ModelSelectorGroup>
                    ))}
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
            <div className="flex items-center gap-2">
              {/* Context-window indicator: ring + % in the trigger, full
                  token breakdown on hover. Updates live while typing and
                  while the model streams. */}
              <Context maxTokens={maxContextTokens} usedTokens={usedTokens}>
                <ContextTrigger />
                <ContextContent align="end">
                  <ContextContentHeader />
                  <ContextContentBody>
                    <ContextInputUsage />
                    <ContextOutputUsage />
                    <ContextReasoningUsage />
                    <ContextCacheUsage />
                  </ContextContentBody>
                  {/* Custom footer: self-hosted models have no tokenlens
                      entry, so show real window limits instead of a $0 cost. */}
                  <ContextContentFooter className="flex-col items-start gap-0.5">
                    <span className="w-full truncate font-medium">
                      {model ?? "Default model"}
                    </span>
                    <span className="text-muted-foreground">
                      Window {formatTokenCount(maxContextTokens)}
                      {maxOutputTokens != null &&
                        ` · Output cap ${formatTokenCount(maxOutputTokens)}`}
                    </span>
                    <span className="text-muted-foreground">
                      Self-hosted · no API cost
                    </span>
                  </ContextContentFooter>
                </ContextContent>
              </Context>
              <PromptInputSubmit
                disabled={!input.trim() && !isGenerating}
                onStop={stop}
                status={status}
              />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>

      <ArtifactPanel
        artifact={openArtifact ?? closingArtifact}
        artifactCount={artifactIndex.length}
        onClose={handleClosePanel}
        open={openArtifact != null}
      />
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

  // Content-area view: conversation or the in-shell Settings panel.
  // ChatArea stays mounted (hidden) while Settings is shown so an
  // in-flight stream is not interrupted by opening settings. Declared
  // before the handlers below that switch back to the chat view.
  const [view, setView] = useState<"chat" | "settings">("chat");

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
    setView("chat");
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

  const handleRenameChat = useCallback(
    (id: string, title: string) => {
      updateChatMeta(id, { title });
      refreshChats();
    },
    [refreshChats]
  );

  const handleTogglePinChat = useCallback(
    (id: string) => {
      const chat = loadChats().find((c) => c.id === id);
      if (!chat) return;
      updateChatMeta(id, { pinned: !chat.pinned });
      refreshChats();
    },
    [refreshChats]
  );

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;

  // Plain functions (not useCallback): trivial wrappers the React
  // Compiler memoizes itself; manual memoization here is rejected by
  // react-hooks/preserve-manual-memoization.
  const handleSelectChat = (id: string) => {
    setActiveChatId(id);
    setView("chat");
  };

  const handleOpenSettings = () => setView("settings");
  const handleCloseSettings = () => setView("chat");

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar
          activeChatId={activeChatId}
          chats={chats}
          onDeleteChat={handleDeleteChat}
          onNewChat={handleNewChat}
          onOpenSettings={handleOpenSettings}
          onRenameChat={handleRenameChat}
          onSelect={handleSelectChat}
          onToggle={() => setSidebarOpen(false)}
          onTogglePinChat={handleTogglePinChat}
          open={sidebarOpen}
          settingsActive={view === "settings"}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <Header
            chatTitle={
              view === "settings" ? "Settings" : (activeChat?.title ?? null)
            }
            onToggleSidebar={() => setSidebarOpen(true)}
            sidebarOpen={sidebarOpen}
          />

          <div className="min-h-0 flex-1">
            {activeChatId && (
              <div className={cn("h-full", view !== "chat" && "hidden")}>
                <ChatArea
                  chatId={activeChatId}
                  initialMessages={activeChat?.messages ?? []}
                  key={activeChatId}
                  model={model}
                  onSelectModel={handleSelectModel}
                  onSettled={handleSettled}
                />
              </div>
            )}
            {view === "settings" && <SettingsView onBack={handleCloseSettings} />}
          </div>
        </div>
      </div>

      <StatusFooter health={health} model={decodeModelRef(model).modelId} />
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
