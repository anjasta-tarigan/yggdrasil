import type { UIMessage } from "ai";

/**
 * Server-side context-window guard.
 *
 * The client resends the whole conversation on every request; long chats
 * would eventually overflow the model's context window and fail opaquely.
 * This module estimates the conversation size and, when it exceeds the
 * budget, keeps the most recent messages that fit — starting on a clean
 * user-turn boundary so tool-call/tool-result pairs are never split.
 */

/**
 * Conservative token budget for the incoming conversation. Self-hosted
 * models have widely varying context sizes; this stays well under common
 * 32k windows and leaves headroom for the system prompt, tools and the
 * model's own reply.
 */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 24_000;

/** ~4 characters per token: model-agnostic, offline, slightly pessimistic. */
const CHARS_PER_TOKEN = 4;

/**
 * Serialize a JSON-like value to measure its real replayed size. Tool
 * outputs (a delegate tool's accumulated UIMessage can be tens of KB) must
 * count at their actual serialized length, not a flat allowance —
 * otherwise the budget guard passes while the provider overflows.
 */
function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function estimateMessageTokens(message: UIMessage): number {
  let chars = 0;
  for (const part of message.parts) {
    if ("text" in part && typeof part.text === "string") {
      chars += part.text.length;
    } else if ("output" in part && part.output != null) {
      // Tool results: measure the real payload (nested subagent messages,
      // search results, file reads) so the estimator tracks what the
      // provider actually receives.
      chars += serializedLength(part.output);
    } else if ("input" in part && part.input != null) {
      chars += serializedLength(part.input);
    } else {
      // Pure state parts (files, tool lifecycle markers) get a flat
      // allowance so a media-heavy history cannot sneak past uncounted.
      chars += 200;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface PruneResult {
  messages: UIMessage[];
  droppedCount: number;
  estimatedTokens: number;
}

/**
 * Returns the newest messages that fit within `budgetTokens`. When anything
 * is dropped, a short system note is prepended so the model knows earlier
 * context was truncated. The kept slice always starts at a user message
 * (a clean turn boundary) to avoid orphaning tool invocations.
 */
export function pruneMessagesToTokenBudget(
  messages: UIMessage[],
  budgetTokens: number = DEFAULT_CONTEXT_TOKEN_BUDGET
): PruneResult {
  const kept: UIMessage[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateMessageTokens(messages[i]);
    if (kept.length > 0 && used + cost > budgetTokens) break;
    kept.unshift(messages[i]);
    used += cost;
  }

  // Slide forward to a clean user-turn boundary.
  while (kept.length > 0 && kept[0].role !== "user") {
    used -= estimateMessageTokens(kept[0]);
    kept.shift();
  }

  // If stripping leading non-user messages emptied the kept list, fall back to the
  // most recent user message (or the last message if no user message exists).
  if (kept.length === 0 && messages.length > 0) {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const fallbackMsg = lastUserMsg ?? messages[messages.length - 1];
    kept.push(fallbackMsg);
    used = estimateMessageTokens(fallbackMsg);
  }

  const droppedCount = messages.length - kept.length;
  if (droppedCount <= 0) {
    return { messages, droppedCount: 0, estimatedTokens: used };
  }

  const marker: UIMessage = {
    id: `ctx-prune-${Date.now()}`,
    role: "system",
    parts: [
      {
        type: "text",
        text: `[Context note: ${droppedCount} earlier messages were truncated to fit the context window. Ask the user to restate anything you need from them.]`,
      },
    ],
  };

  return {
    messages: [marker, ...kept],
    droppedCount,
    estimatedTokens: used,
  };
}
