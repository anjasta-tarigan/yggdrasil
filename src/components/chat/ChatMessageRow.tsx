"use client";

import { memo, useState, useEffect } from "react";
import type { ChatUIMessage } from "@/app/api/chat/route";
import type { MCPAppInfo } from "@/lib/ai/mcp/manager";
import { Message, MessageContent, MessageActions, MessageAction } from "@/components/ai-elements/message";
import { MessageAttachments } from "./MessageAttachments";
import { MessageParts } from "./MessageParts";
import { getFeedback, stopReasonOf, type MessageFeedback } from "./chat-utils";
import { evaluateMessageQuality } from "@/lib/ai/pipeline/quality-scanner";
import { detectTopicDrift } from "@/lib/ai/pipeline/topic-drift-client";
import type { TopicDriftReport } from "@/lib/ai/pipeline/topic-drift-detector";
import type { ChatArtifact } from "@/lib/artifacts";
import type { HarnessStopReason } from "@/lib/ai/harness-loop";
import {
  ArrowsClockwise,
  Copy,
  FlagCheckered,
  Hourglass,
  Prohibit,
  Scissors,
  Sparkle,
  ThumbsDown,
  ThumbsUp,
  WarningCircle,
  type Icon,
} from "@phosphor-icons/react";

/**
 * Presentation for the harness stop reasons that need explaining. A `natural`
 * stop is the normal case and has no entry — it renders nothing.
 */
const STOP_REASON_PRESENTATION: Record<
  Exclude<HarnessStopReason, "natural">,
  { label: string; Icon: Icon }
> = {
  "step-cap": { label: "Step limit reached", Icon: FlagCheckered },
  "context-wrap-up": { label: "Context limit reached", Icon: Hourglass },
  "output-cap": { label: "Output truncated", Icon: Scissors },
  "content-filter": { label: "Blocked by provider", Icon: Prohibit },
  error: { label: "Run failed", Icon: WarningCircle },
};

export type ChatMessageRowProps = {
  message: ChatUIMessage;
  isLastMessage: boolean;
  isStreaming: boolean;
  onOpenArtifact: (artifact: ChatArtifact) => void;
  onApproveTool: (approvalId: string) => void;
  onDenyTool: (approvalId: string, reason?: string) => void;
  onFeedback: (messageId: string, vote: MessageFeedback) => void;
  onRegenerate: () => void;
  apps?: MCPAppInfo[];
};

export const ChatMessageRow = memo(function ChatMessageRow({
  message,
  isLastMessage,
  isStreaming,
  onOpenArtifact,
  onApproveTool,
  onDenyTool,
  onFeedback,
  onRegenerate,
  apps,
}: ChatMessageRowProps) {
  const fileAttachments = message.parts.filter(
    (part): part is import("ai").FileUIPart => part.type === "file"
  );

  const feedback = getFeedback(message);

  // Topic drift ("kabur") detection — async because it uses embeddings.
  // Only fired for completed assistant messages that are long enough to
  // warrant the quality scan, preventing redundant embedding calls.
  const [drift, setDrift] = useState<TopicDriftReport | null>(null);
  const messageText =
    message.role === "assistant"
      ? message.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n\n")
      : "";

  useEffect(() => {
    if (
      message.role === "assistant" &&
      !isStreaming &&
      messageText.trim().length > 0
    ) {
      // AbortController cancels in-flight embedding calls if the component
      // unmounts or the message text changes — prevents stale results
      // overwriting newer state (race condition on streaming updates).
      const controller = new AbortController();
      void detectTopicDrift(messageText, { signal: controller.signal })
        .then((report) => {
          if (!controller.signal.aborted) setDrift(report);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return; // Expected on unmount/text change
          console.error("[anti-slop] topic drift detection failed:", err);
        });
      return () => controller.abort();
    } else {
      setDrift(null);
    }
  }, [messageText, message.role, isStreaming]);

  return (
    <Message
      className={
        message.role === "assistant"
          ? "max-w-[85%] md:max-w-[75%]"
          : "max-w-[85%] sm:max-w-[80%] md:max-w-[70%]"
      }
      from={message.role}
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
          message.role === "assistant" ? "text-justify" : undefined
        }
      >
        <MessageParts
          isLastMessage={isLastMessage}
          isStreaming={isStreaming}
          message={message}
          onApproveTool={onApproveTool}
          onDenyTool={onDenyTool}
          onOpenArtifact={onOpenArtifact}
          apps={apps}
        />
      </MessageContent>
      {message.role === "assistant" && (() => {
        const hasVisibleContent =
          messageText.trim().length > 0 ||
          message.parts.some(
            (p) =>
              p.type === "reasoning" ||
              p.type === "dynamic-tool" ||
              p.type === "source-document" ||
              (p.type !== "text" && "toolCallId" in p)
          );

        // A non-natural stop is worth showing even with no content: an empty
        // message that stopped for a reason is exactly the silent stop this
        // exists to label.
        const stopReason = stopReasonOf(message);
        const stopPresentation =
          stopReason && stopReason !== "natural"
            ? STOP_REASON_PRESENTATION[stopReason]
            : undefined;

        if (!hasVisibleContent && !stopPresentation) {
          return null;
        }

        const quality = evaluateMessageQuality(messageText);
        const isDrift = drift?.driftDetected;
        let qualityAction: React.ReactNode = null;

        if (quality.shouldDisplay || isDrift) {
          const flaggedList = [
            ...quality.flaggedPatterns,
            ...quality.codeIssues,
          ];
          if (isDrift) {
            flaggedList.push("topic drift");
          }
          const displayFlagged = flaggedList.slice(0, 3);

          const effectiveTier =
            isDrift && quality.tier === "clean" ? "low" : quality.tier;

          let headline =
            effectiveTier === "clean"
              ? `Clean ${quality.signalPercent}% (No AI Slop)`
              : effectiveTier === "low"
              ? `Mostly Clean ${quality.signalPercent}% (${isDrift ? "Possible Topic Drift" : "Slight AI Fluff"})`
              : effectiveTier === "moderate"
              ? `AI Slop Detected (${quality.signalPercent}% signal)`
              : `Heavy AI Slop Detected (${quality.signalPercent}% signal)`;

          if (isDrift && effectiveTier !== "low") {
            headline += " · Topic Drift Detected";
          }

          let qualityTooltip =
            effectiveTier === "clean"
              ? `${headline} — Direct, natural, and free of generic AI fillers.`
              : `${headline} — ${quality.summary}. Detected: ${displayFlagged.join(", ")}`;

          if (isDrift) {
            qualityTooltip += ` (Response may have wandered off-topic, coherence: ${Math.round((drift.minSimilarity ?? 0) * 100)}%)`;
          }

          const effectiveColor = isDrift
            ? "text-warning hover:text-warning"
            : effectiveTier === "clean"
            ? "text-success hover:text-success"
            : effectiveTier === "low"
            ? "text-primary hover:text-primary"
            : effectiveTier === "moderate"
            ? "text-warning hover:text-warning"
            : "text-destructive hover:text-destructive";

          qualityAction = (
            <MessageAction
              className={effectiveColor}
              label={headline}
              tooltip={qualityTooltip}
            >
              <Sparkle
                className="size-3.5"
                weight={!isDrift && effectiveTier === "clean" ? "fill" : "regular"}
              />
            </MessageAction>
          );
        }

        return (
          <div className="flex items-center gap-1">
            {stopPresentation && (
              <MessageAction
                className="text-warning hover:text-warning"
                label={stopPresentation.label}
                tooltip={stopPresentation.label}
              >
                <stopPresentation.Icon className="size-3.5" />
              </MessageAction>
            )}
            <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {qualityAction}
              <MessageAction
                aria-pressed={feedback === "positive"}
                className={feedback === "positive" ? "text-primary" : undefined}
                label="Good response"
                onClick={() => onFeedback(message.id, "positive")}
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
                onClick={() => onFeedback(message.id, "negative")}
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
              {isLastMessage && (
                <MessageAction
                  label="Regenerate response"
                  onClick={onRegenerate}
                  tooltip="Regenerate"
                >
                  <ArrowsClockwise className="size-3.5" />
                </MessageAction>
              )}
            </MessageActions>
          </div>
        );
      })()}
    </Message>
  );
});
