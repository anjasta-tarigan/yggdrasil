"use client";

import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useChat } from "@ai-sdk/react";
import type { ChatUIMessage } from "@/app/api/chat/route";
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
import type { StickToBottomContext } from "use-stick-to-bottom";
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
import { ChatMessageRow } from "./ChatMessageRow";
import { ReasoningEffortBadge } from "./ReasoningEffortBadge";
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
import {
  applyCompactionSafetyMargin,
  compactForModelSend,
  defaultClientCompactionBudget,
} from "@/lib/ai/context-budget";
import { processIncomingMessageAttachments } from "@/lib/ai/attachments";
import { inferKnownModelCapabilities } from "@/lib/ai/model-heuristics";
import { classifyTaskReasoningEffort } from "@/lib/ai/reasoning";
import { chatRequestBody, decodeModelRef, encodeModelRef } from "@/lib/settings";
import { usePluginCommands } from "@/hooks/use-plugin-commands";
import { useRegisteredModels } from "@/hooks/use-registered-models";
import { useDeviceLocation } from "@/hooks/use-device-location";
import { CaretUpDown, Check, Cpu, Tree } from "@phosphor-icons/react";
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

  // Live reasoning effort: predicted immediately on submit and confirmed
  // by x-reasoning-effort header at stream start so the badge updates
  // in real time while processing instead of waiting until the stream
  // ends.
  const [liveEffort, setLiveEffort] = useState<string | null>(null);

  // ── Model-context compaction convergence ──────────────────────────────
  // The server reports the exact token budget its guard enforces for the
  // active model in the `x-context-budget` response header. We cache it
  // per model and re-compact the sent history (`modelContextMessages`) to
  // at or under that number, so the server guard drops nothing and the
  // per-turn "[chat/route] Context guard compacted..." log goes quiet. The
  // transport is built once (memoized) so it reads live values through refs.
  const serverBudgetsRef = useRef<Map<string, number>>(new Map());
  // Cache the server-reported effective context window per model so the
  // display percentage matches the server's actual budget denominator.
  const serverWindowsRef = useRef<Map<string, number>>(new Map());
  const modelForSendRef = useRef<string | null>(model);
  const maxContextTokensForSendRef = useRef(FALLBACK_CONTEXT_TOKENS);
  useEffect(() => {
    modelForSendRef.current = model;
  }, [model]);

  const deviceLoc = useDeviceLocation(chatId);
  const deviceLocRef = useRef(deviceLoc);
  useEffect(() => {
    deviceLocRef.current = deviceLoc;
  });

  const customTransport = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- ref reads are inside deferred callbacks (prepareSendMessagesRequest/fetch), not during render
      new DefaultChatTransport({
        api: "/api/chat",
        // Bounds the payload the model receives without touching the full
        // transcript: `messages` stays complete for server-side persistence
        // and title derivation, while `modelContextMessages` carries the
        // already-compacted copy the route feeds to the model.
        prepareSendMessagesRequest: async ({ body, messages }) => {
          const modelRef = modelForSendRef.current;
          const cachedBudget = modelRef
            ? serverBudgetsRef.current.get(modelRef)
            : undefined;
          const budget =
            cachedBudget != null
              ? applyCompactionSafetyMargin(cachedBudget)
              : defaultClientCompactionBudget(
                  maxContextTokensForSendRef.current
                );
          // Run the exact same pipeline as the server guard: decode text
          // attachments, then compact to the budget. compactForModelSend
          // reserves room for the summary block, so the served list fits
          // the budget even after summary injection — identical estimators
          // on both sides mean the server guard converges instead of
          // re-dropping.
          const processed = await processIncomingMessageAttachments(messages);
          const { messages: modelContextMessages } = compactForModelSend(
            processed,
            budget
          );

          const loc = deviceLocRef.current;
          const clientLocation =
            loc.enabled && loc.coordinates
              ? {
                  latitude: loc.coordinates.latitude,
                  longitude: loc.coordinates.longitude,
                  accuracy: loc.coordinates.accuracyMeters,
                  altitude: loc.coordinates.altitudeMeters,
                  heading: loc.coordinates.headingDegrees,
                  speed: loc.coordinates.speedMps,
                }
              : undefined;

          return {
            body: {
              ...(body ?? {}),
              messages,
              modelContextMessages,
              clientLocation,
              clientTimezone: loc.timezone,
            },
          };
        },
        fetch: async (input, init) => {
          const res = await fetch(input, init);
          const effortHeader = res.headers.get("x-reasoning-effort");
          if (effortHeader) {
            setLiveEffort(effortHeader);
          }
          // Remember the exact budget the server just enforced so the next
          // request pre-compacts to the same target (with a safety margin).
          const budgetHeader = res.headers.get("x-context-budget");
          const budget = Number(budgetHeader);
          const modelRef = modelForSendRef.current;
          if (Number.isFinite(budget) && budget > 0 && modelRef) {
            serverBudgetsRef.current.set(modelRef, budget);
          }
          // Cache the server-reported effective context window so the
          // display percentage and the compaction budget share the same
          // denominator (eliminating the 128K-display vs 24K-server gap).
          const windowHeader = res.headers.get("x-context-window");
          const windowTokens = Number(windowHeader);
          if (Number.isFinite(windowTokens) && windowTokens > 0 && modelRef) {
            serverWindowsRef.current.set(modelRef, windowTokens);
          }
          // If the server dropped messages that we sent, our local
          // budget cache was too generous. Tighten it so the next turn's
          // pre-compaction lands exactly under the server's budget instead
          // of fighting the guard every round.
          const droppedHeader = res.headers.get("x-context-dropped");
          const dropped = Number(droppedHeader);
          if (dropped > 0 && modelRef) {
            const tightenedBudget = Math.max(
              1_000,
              Math.floor(budget * 0.9)
            );
            serverBudgetsRef.current.set(modelRef, tightenedBudget);
          }
          return res;
        },
      }),
    []
  );

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
  } = useChat<ChatUIMessage>({
    // The chat id IS the resume key: GET /api/chat/[id]/stream must
    // address the same chat the generation runs for. Without an
    // explicit id the SDK would generate one per hook instance and
    // resume lookups would 204 forever.
    id: chatId,
    transport: customTransport,
    messages: initialMessages as ChatUIMessage[],
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

  // Synchronize when initialMessages arrives or changes from parent database load
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0 && messages.length === 0) {
      setMessages(initialMessages as ChatUIMessage[]);
    }
  }, [initialMessages, messages.length, setMessages]);

  // Plugin slash-commands ("/name args" expand to the command template
  // before the message is sent; unknown /commands pass through as-is).
  const { expand: expandPluginCommand } = usePluginCommands();

  // Auto-detected context limits for the active model. The qualified
  // ref "providerId::modelId" is resolved inside its provider group.
  const modelRef = decodeModelRef(model);
  const activeModelInfo = modelRef.modelId
    ? (groups
        .find((g) => g.providerId === modelRef.providerId)
        ?.models.find((m) => m.modelId === modelRef.modelId) ?? null)
    : null;
  const inferredCaps = modelRef.modelId
    ? inferKnownModelCapabilities(modelRef.modelId)
    : null;
  const maxContextTokens = (() => {
    const modelRefStr = model ?? null;
    const serverWindow = modelRefStr
      // eslint-disable-next-line react-hooks/refs -- cached server-reported value; ref is empty on first render, populated from response effects
      ? serverWindowsRef.current.get(modelRefStr)
      : undefined;
    // Prefer the server-reported effective window (includes fallback logic),
    // then the locally-known model capabilities, then the safe default.
    return (
      serverWindow ??
      activeModelInfo?.capabilities?.contextWindow ??
      inferredCaps?.contextWindow ??
      FALLBACK_CONTEXT_TOKENS
    );
  })();
  // Keep the transport's pre-send compaction default in step with the
  // active model window (the server-reported header overrides it after the
  // first response for that model).
  useEffect(() => {
    maxContextTokensForSendRef.current = maxContextTokens;
  }, [maxContextTokens]);
  const maxOutputTokens =
    activeModelInfo?.capabilities?.maxOutputTokens ??
    inferredCaps?.maxOutputTokens ??
    null;
  const supportsReasoning =
    activeModelInfo?.capabilities?.supportsReasoning ??
    inferredCaps?.supportsReasoning ??
    false;

  const isGenerating = status === "submitted" || status === "streaming";

  // Real-time active reasoning effort derivation from latest message metadata
  const latestMessageEffort = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const meta = messages[i].metadata as
        | { reasoningEffort?: string }
        | undefined;
      if (meta?.reasoningEffort) return meta.reasoningEffort;
    }
    return null;
  }, [messages]);

  // While generating, active effort prioritizes the live/predicted effort;
  // once settled, it falls back to the latest assistant message metadata.
  const activeReasoningEffort =
    (isGenerating ? liveEffort : null) ?? latestMessageEffort ?? liveEffort;

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

  const isThinking =
    isGenerating &&
    messages.at(-1)?.role === "assistant" &&
    messages.at(-1)?.parts.at(-1)?.type === "reasoning";

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
        // addToolResult is inferred from ChatUIMessage via
        // InferAgentUIMessage<ChatAgentT>, so the tool name and output
        // shape are checked against the ask_user_question tool's schema
        // from src/lib/ai/tools/core.ts — no casts needed.
        tool: "ask_user_question",
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

  // Handle to the stick-to-bottom context, so sending a message can pin the
  // feed to the newest one. The library only follows content that grows while
  // it already believes it is at the bottom, so without this an outbound
  // message can land off-screen when the view had scrolled away from the end.
  const conversationRef = useRef<StickToBottomContext | null>(null);

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

  // Ensure the feed snaps to the bottom whenever switching conversations
  useEffect(() => {
    conversationRef.current?.scrollToBottom({ animation: "instant" });
  }, [chatId]);

  // When a new turn is submitted, ensure the feed is pinned to the bottom
  useEffect(() => {
    if (status === "submitted") {
      conversationRef.current?.scrollToBottom({ animation: "instant" });
    }
  }, [status]);

  // Speculative pre-warming: when the user interacts with or focuses the input,
  // warm up the reranker in the background so cold start is eliminated.
  const hasPrewarmedRef = useRef(false);
  const handlePrewarm = useCallback(() => {
    if (hasPrewarmedRef.current) return;
    hasPrewarmedRef.current = true;
    void fetch("/api/models/reranker/warm", { method: "POST" }).catch(() => {});
  }, []);

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      hasPrewarmedRef.current = false;
      const hasText = message.text.trim().length > 0;
      const hasFiles = message.files.length > 0;
      if (isGenerating || !(hasText || hasFiles)) return;

      // Predict reasoning effort immediately upon submit so badge flips in real time
      const predictedEffort = classifyTaskReasoningEffort(message.text);
      setLiveEffort(predictedEffort);

      // Pin the feed to the bottom before the new turn arrives, so the sent
      // message is visible even if the user had scrolled away from the end.
      conversationRef.current?.scrollToBottom();

      if (hasFiles) {
        const parts: ChatUIMessage["parts"] = [...message.files];
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

  const handleApproveTool = useCallback(
    (approvalId: string) => {
      addToolApprovalResponse({ id: approvalId, approved: true });
    },
    [addToolApprovalResponse]
  );

  const handleDenyTool = useCallback(
    (approvalId: string, reason?: string) => {
      addToolApprovalResponse({ id: approvalId, approved: false, reason: reason ?? "User rejected" });
    },
    [addToolApprovalResponse]
  );

  const handleRegenerate = useCallback(() => {
    // Same intent as sending: the regenerated reply streams into the newest
    // message, so re-pin the feed before it starts growing.
    conversationRef.current?.scrollToBottom();
    regenerate({ body: chatRequestBody(model, chatId) });
  }, [chatId, model, regenerate]);

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
        <Conversation contextRef={conversationRef}>
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
              <>
                {messages.map((message, index) => (
                  <ChatMessageRow
                    isLastMessage={
                      index === messages.length - 1 &&
                      (!isGenerating || message.role === "assistant")
                    }
                    isStreaming={isGenerating && index === messages.length - 1}
                    key={message.id}
                    message={message}
                    onApproveTool={handleApproveTool}
                    onDenyTool={handleDenyTool}
                    onFeedback={handleFeedback}
                    onOpenArtifact={handleOpenArtifact}
                    onRegenerate={handleRegenerate}
                  />
                ))}
                {isGenerating &&
                  messages.length > 0 &&
                  messages[messages.length - 1].role === "user" && (
                    <ChatMessageRow
                      isLastMessage={true}
                      isStreaming={true}
                      key="pending-assistant-warming-up"
                      message={{
                        id: "pending-assistant-warming-up",
                        role: "assistant",
                        parts: [],
                      }}
                      onApproveTool={handleApproveTool}
                      onDenyTool={handleDenyTool}
                      onFeedback={handleFeedback}
                      onOpenArtifact={handleOpenArtifact}
                      onRegenerate={handleRegenerate}
                    />
                  )}
              </>
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
              onChange={(e) => {
                handlePrewarm();
                setInput(e.target.value);
              }}
              onFocus={handlePrewarm}
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
              {supportsReasoning && (
                <ReasoningEffortBadge
                  activeEffort={activeReasoningEffort}
                  isStreaming={isGenerating}
                  isThinking={isThinking}
                />
              )}
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
