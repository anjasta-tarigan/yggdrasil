import type { LanguageModelUsage, UIMessage } from "ai";
import { isToolUIPart } from "ai";

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
