// src/lib/ai/harness-context.ts
/**
 * In-run context guard for the Project Harness (see
 * `src/lib/ai/harness-loop.ts` for the loop policy it plugs into).
 *
 * Why this exists: compaction (`compactAndPruneMessages`) runs only at
 * request start, and history alone cannot bound what happens afterwards.
 * Inside one `streamText` run — up to `HARNESS_MAX_STEPS` steps — every tool
 * result is appended to the prompt on every step and nothing prunes it, so a
 * few large results per step will overflow the model's window. (The route
 * also compacts request-start history to
 * `HARNESS_HISTORY_BUDGET_RATIO` of the budget to reserve headroom, but that
 * is a static measure; growth inside the run still needs a guard.) This
 * module decides, per step, whether to elide stale tool output and, if that
 * is not enough, whether to force a status-report wrap-up instead of letting
 * the provider reject the request.
 *
 * The module is pure: no I/O, no network, no provider calls. It operates on
 * `ModelMessage[]` (the type `streamText` actually sends) and is unit
 * tested in isolation.
 */

import { pruneMessages, type ModelMessage, type ToolResultPart } from "ai";
import { estimateTokens } from "@/lib/ai/context-budget";

/** Request-start history may use at most this share of the budget, leaving headroom for the run. */
export const HARNESS_HISTORY_BUDGET_RATIO = 0.6;
/** Start eliding stale tool output above this share of the budget. */
export const HARNESS_ELIDE_TRIGGER_RATIO = 0.8;
/** Elide until at or below this share (hysteresis: do not fire every step, limit prompt-cache churn). */
export const HARNESS_ELIDE_TARGET_RATIO = 0.55;
/** If still above this share after eliding, force a wrap-up. */
export const HARNESS_CONTEXT_WRAPUP_RATIO = 0.95;
/** The most recent tool rounds are never touched. */
export const HARNESS_KEEP_RECENT_TOOL_ROUNDS = 4;
/** Do not bother eliding tiny outputs. */
export const HARNESS_MIN_ELIDE_TOKENS = 200;

/**
 * The history budget the harness route compacts request-start messages to.
 *
 * Single source of truth for the `HARNESS_HISTORY_BUDGET_RATIO` arithmetic so
 * the route and its tests cannot drift. Never returns less than 1,000 tokens
 * (a tiny window would otherwise starve the prompt entirely).
 */
export function harnessHistoryBudget(budgetTokens: number): number {
  return Math.max(1_000, Math.floor(budgetTokens * HARNESS_HISTORY_BUDGET_RATIO));
}

/**
 * Text substituted for an elided tool result. Kept short and self-describing
 * so the model understands why the content is gone and what to do about it.
 */
export function elidedToolOutputText(tokens: number): string {
  return `[tool output elided to save context: ~${tokens} tokens. Re-run the tool if you still need it.]`;
}

/**
 * Estimate the token footprint of `messages`.
 *
 * Delegates to the shared `estimateTokens` so the units match the route's
 * calibrated `budgetTokens` (the route divides its window math by the
 * per-model `tokenRatio` before passing it in). Each message is measured
 * from its serialized form, since tool results are JSON payloads whose real
 * replayed size is what the provider counts.
 */
export function estimateModelMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(JSON.stringify(message) ?? "");
  }
  return total;
}

/** Estimated tokens for a single tool-result output. */
function toolOutputTokens(part: ToolResultPart): number {
  return estimateTokens(JSON.stringify(part.output) ?? "");
}

/**
 * A tool round is one assistant message carrying tool-call parts plus the
 * tool message(s) that hold the matching results. Returns the start index of
 * each round, oldest first.
 */
function findToolRoundStarts(messages: ModelMessage[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "assistant" || typeof message.content === "string") {
      continue;
    }
    if (message.content.some((part) => part.type === "tool-call")) {
      starts.push(i);
    }
  }
  return starts;
}

/**
 * Whether a tool-result part may be elided: it must be a completed result
 * with a text/json/error output large enough to matter. Approval parts,
 * `execution-denied` outputs (the user's refusal is meaningful context),
 * pending calls and small outputs are never touched.
 */
function isElidableResult(part: ToolResultPart): boolean {
  if (part.output.type === "execution-denied") return false;
  return toolOutputTokens(part) >= HARNESS_MIN_ELIDE_TOKENS;
}

/**
 * Replace the output of stale tool results with a short stub, oldest rounds
 * first, until the estimate is at or below `targetTokens` (or nothing
 * eligible remains).
 *
 * Invariants:
 * - Only `output` is replaced. Tool-call and tool-result parts are never
 *   removed, so every call id keeps a matching result and no provider sees
 *   an orphaned pair.
 * - The last `keepRecentRounds` rounds are left byte-for-byte intact.
 * - Idempotent: a stubbed output is below `HARNESS_MIN_ELIDE_TOKENS`, so a
 *   second pass makes no further change.
 * - Non-tool messages, assistant text, approval request/response parts and
 *   `execution-denied` outputs are untouched.
 */
export function elideStaleToolOutputs(
  messages: ModelMessage[],
  options: { keepRecentRounds: number; targetTokens: number }
): {
  messages: ModelMessage[];
  elidedCount: number;
  tokensBefore: number;
  tokensAfter: number;
} {
  const { keepRecentRounds, targetTokens } = options;
  const tokensBefore = estimateModelMessagesTokens(messages);

  const roundStarts = findToolRoundStarts(messages);
  // Rounds before this index may be elided; the newest `keepRecentRounds`
  // are left byte-for-byte intact.
  const elidableRoundCount = Math.max(
    0,
    roundStarts.length - Math.max(0, keepRecentRounds)
  );

  // Oldest rounds first. A round spans [start, nextStart) so its tool
  // results (in the following tool message) are covered.
  const result: ModelMessage[] = [...messages];
  let elidedCount = 0;
  let currentTokens = tokensBefore;

  for (let r = 0; r < elidableRoundCount; r++) {
    if (currentTokens <= targetTokens) break;
    const start = roundStarts[r];
    const end = r + 1 < roundStarts.length ? roundStarts[r + 1] : messages.length;

    for (let i = start; i < end; i++) {
      if (currentTokens <= targetTokens) break;
      const message = result[i];
      if (typeof message.content === "string") continue;
      if (message.role !== "tool" && message.role !== "assistant") continue;

      const content = message.content;
      let mutated = false;
      const nextContent = content.map((part) => {
        if (part.type !== "tool-result") return part;
        if (!isElidableResult(part)) return part;
        const tokens = toolOutputTokens(part);
        mutated = true;
        elidedCount++;
        return {
          ...part,
          output: { type: "text" as const, value: elidedToolOutputText(tokens) },
        };
      });

      if (mutated) {
        result[i] = { ...message, content: nextContent } as ModelMessage;
        currentTokens = estimateModelMessagesTokens(result);
      }
    }
    if (currentTokens <= targetTokens) break;
  }

  return {
    messages: elidedCount > 0 ? result : messages,
    elidedCount,
    tokensBefore,
    tokensAfter: elidedCount > 0 ? currentTokens : tokensBefore,
  };
}

/** What the harness should do to the prompt before the next step. */
export type ContextGuardDecision =
  | { action: "none" }
  | {
      action: "elide";
      messages: ModelMessage[];
      elidedCount: number;
      prunedReasoning: boolean;
      tokensBefore: number;
      tokensAfter: number;
    }
  | { action: "wrap-up"; messages?: ModelMessage[]; tokensAfter: number };

/**
 * Decide what to do about context growth before a step.
 *
 * Ladder:
 * 1. At or below `budgetTokens * HARNESS_ELIDE_TRIGGER_RATIO` → `none`.
 * 2. Above it → prune stale reasoning, then elide stale tool output toward
 *    `budgetTokens * HARNESS_ELIDE_TARGET_RATIO`. Either prune counts as a
 *    real change: reasoning pruning alone is a valid `elide` (when stale
 *    reasoning is the bulk of the prompt, pruning it is what keeps the
 *    request inside the window).
 * 3. Still above `budgetTokens * HARNESS_CONTEXT_WRAPUP_RATIO` → `wrap-up`
 *    (never at step 0: the first step has no history to prune, so forcing a
 *    wrap-up there would abandon the task before it starts).
 * 4. Otherwise → `elide` when something changed, else `none`.
 */
export function evaluateContextGuard(args: {
  messages: ModelMessage[];
  budgetTokens: number;
  stepNumber: number;
}): ContextGuardDecision {
  const { messages, budgetTokens, stepNumber } = args;
  const estimated = estimateModelMessagesTokens(messages);

  if (estimated <= budgetTokens * HARNESS_ELIDE_TRIGGER_RATIO) {
    return { action: "none" };
  }

  // Cheap win first: drop old reasoning parts. `toolCalls: "none"` leaves
  // tool calls/results alone, and `reasoning: "before-last-message"` keeps
  // the last message's reasoning (some providers require it for tool
  // continuity).
  const pruned = pruneMessages({
    messages,
    reasoning: "before-last-message",
    toolCalls: "none",
    emptyMessages: "keep",
  });
  const prunedReasoning = estimateModelMessagesTokens(pruned) < estimated;

  const wrapUpLimit = budgetTokens * HARNESS_CONTEXT_WRAPUP_RATIO;

  const elision = elideStaleToolOutputs(pruned, {
    keepRecentRounds: HARNESS_KEEP_RECENT_TOOL_ROUNDS,
    targetTokens: budgetTokens * HARNESS_ELIDE_TARGET_RATIO,
  });

  const tokensAfter = elision.tokensAfter;
  const changed = elision.elidedCount > 0 || prunedReasoning;

  if (stepNumber > 0 && tokensAfter > wrapUpLimit) {
    return changed
      ? { action: "wrap-up", messages: elision.messages, tokensAfter }
      : { action: "wrap-up", tokensAfter };
  }

  if (changed) {
    return {
      action: "elide",
      messages: elision.messages,
      elidedCount: elision.elidedCount,
      prunedReasoning,
      // Measured BEFORE reasoning pruning, so the log shows the true drop.
      tokensBefore: estimated,
      tokensAfter,
    };
  }

  return { action: "none" };
}
