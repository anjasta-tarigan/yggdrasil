import type { LanguageModelUsage, ToolUIPart, UIMessage } from "ai";
import { getToolName, isToolUIPart } from "ai";
import type { DynamicToolUIPart } from "ai";

/**
 * Fallback context window when the server doesn't report one for the
 * selected model. Most models served here expose `context_length`, so this
 * only applies while the model list is unavailable.
 */
export const FALLBACK_CONTEXT_TOKENS = 128_000;

/** Rough client-side token estimate (~4 chars/token, English prose). */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

const compactTokenFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

/** "12K", "1M", ... matching the Context component's own formatting. */
export function formatTokenCount(tokens: number): string {
  return compactTokenFormat.format(tokens);
}

/**
 * Real usage reported by the server for a turn (attached to assistant
 * message metadata on every finish-step; the last step wins). Undefined
 * for messages that predate this feature or carry no numbers.
 */
export function usageOf(message: UIMessage): LanguageModelUsage | undefined {
  const meta = message.metadata as { usage?: LanguageModelUsage } | undefined;
  const usage = meta?.usage;
  if (!usage) return undefined;
  if (usage.inputTokens == null && usage.outputTokens == null) return undefined;
  return usage;
}

/** Approximate character count of everything a message contributes. */
export function messageChars(message: UIMessage): number {
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

export type ChatAreaProps = {
  chatId: string;
  initialMessages: UIMessage[];
  model: string | null;
  onSelectModel: (id: string) => void;
  onSettled: (chatId: string, messages: UIMessage[]) => void;
};

/**
 * Whether an ask_user_question part has finished its round trip. The
 * modal in ChatArea only opens for parts that are still waiting for a
 * human answer; answered (and errored) ones render inline as a summary.
 */
export function isQuestionAnswered(part: ToolUIPart | DynamicToolUIPart): boolean {
  return part.state === "output-available" || part.state === "output-error";
}

/**
 * Newest ask_user_question part still awaiting an answer, searched from
 * the end of the message list so multi-question turns surface the one
 * the modal should show. Returns null when every question has been
 * answered (or none was asked). The popup only opens for parts whose
 * input finished streaming — a half-streamed questions array would
 * render a broken form.
 */
export function findLatestQuestionPart(
  messages: UIMessage[]
): ToolUIPart | DynamicToolUIPart | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (!isToolUIPart(part)) continue;
      if (getToolName(part) !== "ask_user_question") continue;
      if (isQuestionAnswered(part)) continue;
      if (part.state !== "input-available") continue;
      return part;
    }
  }
  return null;
}

/**
 * User feedback on an assistant message — "positive" for thumbs-up,
 * "negative" for thumbs-down. Stored in message metadata and persisted
 * to chat_messages.metadata on every settle save.
 */
export type MessageFeedback = "positive" | "negative";

/** Read the feedback vote stored on a message, if any. */
export function getFeedback(message: UIMessage): MessageFeedback | undefined {
  const meta = message.metadata as { feedback?: unknown } | undefined;
  const v = meta?.feedback;
  return v === "positive" || v === "negative" ? v : undefined;
}

/** True when the message carries a non-null feedback vote. */
export function hasFeedback(message: UIMessage): boolean {
  return getFeedback(message) !== undefined;
}
