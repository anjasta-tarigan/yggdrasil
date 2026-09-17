"use client";

import { memo, useState, useEffect } from "react";
import type { ChatUIMessage } from "@/app/api/chat/route";
import { Message, MessageContent, MessageActions, MessageAction } from "@/components/ai-elements/message";
import { MessageAttachments } from "./MessageAttachments";
import { MessageParts } from "./MessageParts";
import { getFeedback, type MessageFeedback } from "./chat-utils";
import { evaluateMessageQuality } from "@/lib/ai/pipeline/quality-scanner";
import { detectTopicDrift } from "@/lib/ai/pipeline/topic-drift-client";
import type { TopicDriftReport } from "@/lib/ai/pipeline/topic-drift-detector";
import type { ChatArtifact } from "@/lib/artifacts";
import {
  ArrowsClockwise,
  Copy,
  Sparkle,
  ThumbsDown,
  ThumbsUp,
} from "@phosphor-icons/react";

export type ChatMessageRowProps = {
  message: ChatUIMessage;
  isLastMessage: boolean;
  isStreaming: boolean;
  onOpenArtifact: (artifact: ChatArtifact) => void;
  onApproveTool: (approvalId: string) => void;
  onDenyTool: (approvalId: string, reason?: string) => void;
  onFeedback: (messageId: string, vote: MessageFeedback) => void;
  onRegenerate: () => void;
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

        if (!hasVisibleContent) {
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
            ? "text-amber-500 hover:text-amber-600 dark:text-amber-400"
            : effectiveTier === "clean"
            ? "text-emerald-500 hover:text-emerald-600 dark:text-emerald-400"
            : effectiveTier === "low"
            ? "text-sky-500 hover:text-sky-600 dark:text-sky-400"
            : effectiveTier === "moderate"
            ? "text-amber-500 hover:text-amber-600 dark:text-amber-400"
            : "text-rose-500 hover:text-rose-600 dark:text-rose-400";

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
          <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100">
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
        );
      })()}
    </Message>
  );
});
