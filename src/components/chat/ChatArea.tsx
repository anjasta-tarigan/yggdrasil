"use client";

import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useChat } from "@ai-sdk/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageActions,
  MessageAction,
  MessageContent,
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
  PromptInputActionAddAttachments,
  PromptInputActionAddScreenshot,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ARTIFACT_PANEL_EXIT_MS, ArtifactPanel } from "@/components/artifact-panel";
import { MessageAttachments } from "./MessageAttachments";
import { MessageParts } from "./MessageParts";
import { QuestionModal } from "@/components/ai-elements/question-modal";
import type { QuestionCardAnswers } from "@/components/ai-elements/question-card";
import { PromptInputAttachmentsDisplay } from "./PromptInputAttachmentsDisplay";
import { BRAND } from "@/lib/brand";
import {
  FALLBACK_CONTEXT_TOKENS,
  estimateTokens,
  findLatestQuestionPart,
  formatTokenCount,
  getFeedback,
  messageChars,
  usageOf,
  type ChatAreaProps,
  type MessageFeedback,
} from "./chat-utils";
import { collectArtifacts, type ChatArtifact } from "@/lib/artifacts";
import { setMessageFeedback } from "@/lib/chat-storage";
import { chatRequestBody, decodeModelRef, encodeModelRef } from "@/lib/settings";
import { usePluginCommands } from "@/hooks/use-plugin-commands";
import { useRegisteredModels } from "@/hooks/use-registered-models";
import { CaretUpDown, Check, Copy, Cpu, Tree, ArrowsClockwise, ThumbsUp, ThumbsDown, Sparkle } from "@phosphor-icons/react";
import { analyzeAiSlop } from "@/lib/ai/slop-detector";
import { useInstalledSkills } from "@/hooks/use-installed-skills";
import type { LanguageModelUsage, UIMessage } from "ai";

export function ChatArea({
  chatId,
  initialMessages,
  model,
  onSelectModel,
  onSettled,
}: ChatAreaProps) {
  const [input, setInput] = useState("");
  const [selectorOpen, setSelectorOpen] = useState(false);
  const { groups, loading: modelsLoading } = useRegisteredModels();
  // Derived, not stateful: a registry is empty when no provider holds models.
  const noModelsConfigured = groups.every((g) => g.models.length === 0);

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    error,
    regenerate,
    addToolResult,
    addToolApprovalResponse,
  } = useChat({
    // The chat id IS the resume key: GET /api/chat/[id]/stream must
    // address the same chat the generation runs for. Without an
    // explicit id the SDK would generate one per hook instance and
    // resume lookups would 204 forever.
    id: chatId,
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    messages: initialMessages,
    // Resumable streams: on mount, GET /api/chat/[chatId]/stream to
    // re-attach to a still-running generation. Covers page reload,
    // tab restore, and the remount that happens when the user hops
    // between chats mid-stream — the model keeps generating server-
    // side (see consumeSseStream in the route) and this chat view
    // picks the stream back up instead of silently dropping it.
    resume: true,
    // Auto-continue when the last step finished executing tools OR when
    // the user answered a tool approval: the tool-calls predicate alone
    // sees an approval-responded part (no tool result yet) as incomplete
    // and stalls the conversation after every Accept/Deny click.
    sendAutomaticallyWhen: (chatState) =>
      lastAssistantMessageIsCompleteWithToolCalls(chatState) ||
      lastAssistantMessageIsCompleteWithApprovalResponses(chatState),
  });

  // Plugin slash-commands ("/name args" expand to the command template
  // before the message is sent; unknown /commands pass through as-is).
  const { expand: expandPluginCommand } = usePluginCommands();
  const { hasEnabledSkill } = useInstalledSkills();
  const hasAntiSlopSkill = hasEnabledSkill("anti-slop");

  // Auto-detected context limits for the active model. The qualified
  // ref "providerId::modelId" is resolved inside its provider group.
  const modelRef = decodeModelRef(model);
  const activeModelInfo = modelRef.modelId
    ? (groups
        .find((g) => g.providerId === modelRef.providerId)
        ?.models.find((m) => m.modelId === modelRef.modelId) ?? null)
    : null;
  const maxContextTokens =
    activeModelInfo?.capabilities?.contextWindow ?? FALLBACK_CONTEXT_TOKENS;
  const maxOutputTokens = activeModelInfo?.capabilities?.maxOutputTokens ?? null;

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

  // ---- Pending ask_user_question popup (spec: popup QnA) ----
  // The newest unanswered question part drives the modal. While it stays
  // pending the popup is open; addToolResult flips the part to
  // output-available, which unmounts the modal (and the
  // sendAutomaticallyWhen predicate auto-continues the turn).
  const pendingQuestion = useMemo(
    () => findLatestQuestionPart(messages),
    [messages]
  );
  const [questionModalDismissed, setQuestionModalDismissed] = useState<
    string | null
  >(null);
  const isQuestionModalOpen =
    pendingQuestion != null &&
    pendingQuestion.toolCallId !== questionModalDismissed;

  const handleAnswerQuestion = useCallback(
    (toolCallId: string, answers: QuestionCardAnswers) => {
      addToolResult({
        // addToolResult expects a tool name from the message's tool map
        // (default UIMessage has none), so this is typed locally and
        // asserted once.
        tool: "ask_user_question" as never,
        toolCallId,
        state: "output-available",
        output: { answers },
      });
      setQuestionModalDismissed(null);
    },
    [addToolResult]
  );

  const handleQuestionModalClose = useCallback(
    (open: boolean) => {
      // The QuestionModal already declines all questions when dismissed;
      // this callback only runs after an answer/decline resolved the part.
      if (!open && pendingQuestion) {
        setQuestionModalDismissed(pendingQuestion.toolCallId);
      }
    },
    [pendingQuestion]
  );

  // Track the initial messages reference so we don't re-save an unchanged
  // chat on mount (which would needlessly bump its updatedAt).
  const initialRef = useRef(initialMessages);
  // Track the last persisted messages reference so this effect re-running
  // never re-saves the same message set — that would loop back into the
  // parent's setState and exceed the maximum update depth.
  const settledRef = useRef<UIMessage[] | null>(null);
  // Latest-ref pattern: the settle effect must not re-run when the
  // parent's callback identity changes (a plain function is recreated on
  // every parent render), so it reads the freshest onSettled via a ref.
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  // Persist the conversation once a turn settles (ready or error).
  // This syncs with the chat database via the parent.
  useEffect(() => {
    if (status !== "ready" && status !== "error") return;
    if (messages === initialRef.current) return;
    if (messages === settledRef.current) return;
    settledRef.current = messages;
    onSettledRef.current(chatId, messages);
  }, [chatId, messages, status]);

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      const hasText = message.text.trim().length > 0;
      const hasFiles = message.files.length > 0;
      if (isGenerating || !(hasText || hasFiles)) return;
      if (hasFiles) {
        const parts: UIMessage["parts"] = [...message.files];
        if (hasText) {
          parts.push({ type: "text", text: expandPluginCommand(message.text) });
        }
        sendMessage(
          { role: "user", parts },
          { body: chatRequestBody(model, chatId) }
        );
      } else {
        sendMessage(
          { text: expandPluginCommand(message.text) },
          { body: chatRequestBody(model, chatId) }
        );
      }
      setInput("");
    },
    [chatId, expandPluginCommand, isGenerating, model, sendMessage]
  );

  const handleSelectModel = useCallback(
    (id: string) => {
      onSelectModel(id);
      setSelectorOpen(false);
    },
    [onSelectModel]
  );

  // Optimistically flip the feedback vote in local state, then persist
  // to the server (fire-and-forget — failures are warned but never block
  // the UI). Clicking the same vote again toggles it off (null = cleared).
  const handleFeedback = useCallback(
    (messageId: string, vote: MessageFeedback) => {
      let next: MessageFeedback | null = vote;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          next = getFeedback(m) === vote ? null : vote;
          return {
            ...m,
            metadata: {
              ...((m.metadata as Record<string, unknown>) ?? {}),
              feedback: next,
            },
          };
        })
      );
      void setMessageFeedback(chatId, messageId, next).catch((err) =>
        console.warn("[ChatArea] Failed to persist feedback:", err)
      );
    },
    [chatId, setMessages]
  );

  // Resumable-stream contract: `stop()` alone is only a disconnect —
  // the server would keep generating so the stream can be resumed
  // later. An explicit user stop must also POST the stop endpoint,
  // which persists the partial assistant message, cancels the server-
  // side generation, and clears the chat's active-stream pointer.
  const handleStop = useCallback(() => {
    const last = messages[messages.length - 1];
    const assistantMessage = last?.role === "assistant" ? last : undefined;
    void fetch(`/api/chat/${encodeURIComponent(chatId)}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(assistantMessage ? { assistantMessage } : {}),
    }).catch((err) => console.warn("Stop request failed:", err));
    void stop();
  }, [chatId, messages, stop]);

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
                title={BRAND.name}
                description={BRAND.tagline}
              />
            ) : (
              messages.map((message, index) => {
                const fileAttachments = message.parts.filter(
                  (part): part is import("ai").FileUIPart => part.type === "file"
                );
                return (
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
                    {fileAttachments.length > 0 && (
                      <MessageAttachments
                        attachments={fileAttachments}
                        className={message.role === "user" ? "ml-auto" : undefined}
                        messageId={message.id}
                      />
                    )}
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
                        // QnA answering is owned by the QuestionModal
                        // popup below; the transcript only keeps a
                        // read-only summary once a part is answered.
                        onApproveTool={(approvalId) => {
                          addToolApprovalResponse({
                            id: approvalId,
                            approved: true,
                          });
                        }}
                        onDenyTool={(approvalId, reason) => {
                          addToolApprovalResponse({
                            id: approvalId,
                            approved: false,
                            reason: reason ?? "User rejected",
                          });
                        }}
                        onOpenArtifact={handleOpenArtifact}
                      />
                    </MessageContent>
                    {message.role === "assistant" && (() => {
                    const feedback = getFeedback(message);
                    const messageText = message.parts
                      .filter((p) => p.type === "text")
                      .map((p) => p.text)
                      .join("\n\n");

                    // Only compute and display slop indicator if anti-slop skill is installed and enabled
                    let slopAction: React.ReactNode = null;
                    if (hasAntiSlopSkill && messageText.trim().length > 0) {
                      const slopResult = analyzeAiSlop(messageText);
                      const signalPercent = 100 - slopResult.score;

                      const flaggedList = [
                        ...slopResult.detections.tier1Matches,
                        ...slopResult.detections.structuralMatches,
                      ].slice(0, 3);

                      const slopTooltip = `AI Slop Analysis: ${slopResult.tier.toUpperCase()} (${signalPercent}% signal)\n` +
                        `• Verdict: ${slopResult.summary}\n` +
                        (flaggedList.length > 0
                          ? `• Detected patterns: ${flaggedList.join(", ")}`
                          : "• No formulaic or template patterns detected.");

                      slopAction = (
                        <MessageAction
                          label={`AI Slop rating: ${slopResult.tier} (${signalPercent}% signal)`}
                          tooltip={slopTooltip}
                          className={
                            slopResult.tier === "clean"
                              ? "text-emerald-500 hover:text-emerald-600 dark:text-emerald-400"
                              : slopResult.tier === "low"
                              ? "text-sky-500 hover:text-sky-600 dark:text-sky-400"
                              : slopResult.tier === "moderate"
                              ? "text-amber-500 hover:text-amber-600 dark:text-amber-400"
                              : "text-rose-500 hover:text-rose-600 dark:text-rose-400"
                          }
                        >
                          <Sparkle
                            className="size-3.5"
                            weight={slopResult.tier === "clean" ? "fill" : "regular"}
                          />
                        </MessageAction>
                      );
                    }

                    return (
                      <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100">
                        {slopAction}
                        <MessageAction
                          aria-pressed={feedback === "positive"}
                          className={feedback === "positive" ? "text-primary" : undefined}
                          label="Good response"
                          onClick={() => handleFeedback(message.id, "positive")}
                          tooltip={feedback === "positive" ? "Remove thumbs up" : "Thumbs up"}
                        >
                          <ThumbsUp
                            className="size-3.5"
                            weight={feedback === "positive" ? "fill" : "regular"}
                          />
                        </MessageAction>
                        <MessageAction
                          aria-pressed={feedback === "negative"}
                          className={feedback === "negative" ? "text-primary" : undefined}
                          label="Bad response"
                          onClick={() => handleFeedback(message.id, "negative")}
                          tooltip={feedback === "negative" ? "Remove thumbs down" : "Thumbs down"}
                        >
                          <ThumbsDown
                            className="size-3.5"
                            weight={feedback === "negative" ? "fill" : "regular"}
                          />
                        </MessageAction>
                        <MessageAction
                          label="Copy message"
                          onClick={() => {
                            const text = message.parts
                              .filter((p) => p.type === "text")
                              .map((p) => p.text)
                              .join("\n\n");
                            if (text && typeof navigator !== "undefined") {
                              void navigator.clipboard.writeText(text);
                            }
                          }}
                          tooltip="Copy"
                        >
                          <Copy className="size-3.5" />
                        </MessageAction>
                        {index === messages.length - 1 && (
                          <MessageAction
                            label="Regenerate response"
                            onClick={() =>
                              regenerate({ body: chatRequestBody(model, chatId) })
                            }
                            tooltip="Regenerate"
                          >
                            <ArrowsClockwise className="size-3.5" />
                          </MessageAction>
                        )}
                      </MessageActions>
                    );
                  })()}
                </Message>
                );
              })
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
                  regenerate({ body: chatRequestBody(model, chatId) })
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

        {/* Spec §6: an empty registry disables the composer with an
            explanatory message — there is no model to send to. */}
        {!modelsLoading && noModelsConfigured ? (
          <div className="mx-auto mb-4 w-full max-w-3xl px-4 md:px-6">
            <p className="rounded-md border border-border px-4 py-3 text-center text-muted-foreground text-sm">
              No models configured — add a provider and a model in
              Settings → Providers to start chatting.
            </p>
          </div>
        ) : (
        <PromptInput
          className="mx-auto mb-4 w-full max-w-3xl px-4 md:px-6"
          onSubmit={handleSubmit}
        >
          <PromptInputAttachmentsDisplay />
          <PromptInputBody>
            <PromptInputTextarea
              onChange={(e) => setInput(e.target.value)}
              placeholder={BRAND.promptPlaceholder}
              value={input}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                  <PromptInputActionAddScreenshot />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
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
                      {activeModelInfo?.displayName ??
                        modelRef.modelId ??
                        "Default model"}
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
                        {group.models.length === 0 ? (
                          <p className="px-2 py-1.5 text-muted-foreground text-xs">
                            No models added — add one in Settings → Providers.
                          </p>
                        ) : (
                          group.models.map((m) => {
                            const ref = encodeModelRef(
                              group.providerId,
                              m.modelId
                            );
                            return (
                              <ModelSelectorItem
                                key={ref}
                                onSelect={() => handleSelectModel(ref)}
                                value={`${group.providerName} ${m.displayName} ${m.modelId}`}
                              >
                                <ModelSelectorName>
                                  {m.displayName}
                                </ModelSelectorName>
                                {m.isDefault ? (
                                  <span className="text-muted-foreground text-xs">
                                    (default)
                                  </span>
                                ) : null}
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
                onStop={handleStop}
                status={status}
              />
            </div>
          </PromptInputFooter>
        </PromptInput>
        )}
      </div>

      <ArtifactPanel
        artifact={openArtifact ?? closingArtifact}
        artifactCount={artifactIndex.length}
        onClose={handleClosePanel}
        open={openArtifact != null}
      />

      {pendingQuestion && (
        <QuestionModal
          // Remount per tool call so the modal's internal answered
          // state resets between different questions.
          key={pendingQuestion.toolCallId}
          onAnswer={(answers) => {
            handleAnswerQuestion(pendingQuestion.toolCallId, answers);
          }}
          onOpenChange={handleQuestionModalClose}
          open={isQuestionModalOpen}
          part={pendingQuestion}
        />
      )}
    </div>
  );
}
