import type { UIMessage } from "ai";
import { estimateTokens as estimateTokensFromString } from "@/lib/skills/token-estimator";
// Note: syslog not imported here — log-store.ts pulls in node:fs, which
// Turbopack cannot bundle for the client side (ChatArea imports this module).

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

/** Maximum allowed summary tokens (~6,000 characters). */
export const MAX_SUMMARY_TOKENS = 1_500;
export const MAX_SUMMARY_CHARS = MAX_SUMMARY_TOKENS * 4;

/**
 * Conservative client-side compaction budget used BEFORE the server has
 * reported the exact per-model budget (the `x-context-budget` response
 * header). Stays at or below the typical server budget for un-clamped
 * windows so the server-side guard is not forced to re-drop on the first
 * compacting turn; the next response's header replaces this estimate with
 * the exact number so the guard converges to silence.
 */
export function defaultClientCompactionBudget(
  contextWindowTokens: number
): number {
  const window =
    Number.isFinite(contextWindowTokens) && contextWindowTokens > 0
      ? contextWindowTokens
      : DEFAULT_CONTEXT_TOKEN_BUDGET;
  return Math.max(8_000, Math.floor(window * 0.8));
}

/**
 * Margin the client applies to the budget the server reported, so small
 * request-to-request drift in the server's own math (MCP tool availability
 * changing the measured system+tools footprint, newly decoded attachments)
 * never forces the guard to drop a turn after it already converged.
 */
export function applyCompactionSafetyMargin(budgetTokens: number): number {
  return Math.max(1_000, Math.floor(budgetTokens * 0.95));
}

/**
 * Client-side compact-to-budget that reserves room for the summary block
 * `compactAndPruneMessages` injects when it drops, so the returned list
 * (summary included) is guaranteed to fit `budgetTokens`. Called with the
 * server-reported budget (minus safety margin): the server guard then
 * re-checks the same list against its exact budget and drops nothing —
 * the converged, non-thrashing fixed point.
 */
export function compactForModelSend(
  messages: UIMessage[],
  budgetTokens: number
): PruneResult {
  // Proportional summary reservation: when the budget is tight, shrink the
  // summary slot so keepBudget + summaryTokens never exceeds budgetTokens.
  // This prevents the anti-thrash breakdown where a fixed 1,500-token
  // summary reservation caused the client's output to always exceed a
  // sub-2,632-token server budget, triggering recompaction every turn.
  const summaryReservation = Math.min(
    MAX_SUMMARY_TOKENS,
    Math.max(0, budgetTokens - 1_000)
  );
  const keepBudget = Math.max(1_000, budgetTokens - summaryReservation);
  const maxSummaryChars = summaryReservation * CHARS_PER_TOKEN;
  return compactAndPruneMessages(messages, keepBudget, maxSummaryChars);
}

/** ~4 characters per token: English/Latin-script baseline. */
const CHARS_PER_TOKEN = 4;

/** Rough token estimator for context-budget.ts.
 * Accepts a char count (legacy callers) or a full string (language-aware).
 * For string input, delegates to the canonical estimator in catalog.ts to
 * ensure CJK/Indonesian/English heuristics are consistent across all callers.
 */
export function estimateTokens(input: string | number): number {
  if (typeof input === "number") {
    return Math.ceil(input / CHARS_PER_TOKEN);
  }
  if (input.length === 0) return 0;
  return estimateTokensFromString(input);
}

/**
 * Serialize a JSON-like value to measure its real replayed size. Tool
 * outputs (a delegate tool's accumulated UIMessage can be tens of KB) must
 * count at their actual serialized length, not a flat allowance —
 * otherwise the budget guard passes while the provider overflows.
 */
function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch (err) {
    console.debug(`[context-budget] estimateTokensFromMessages failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

export function estimateMessageTokens(message: UIMessage): number {
  let chars = 0;
  let textBuf = "";
  for (const part of message.parts) {
    if ("text" in part && typeof part.text === "string") {
      chars += part.text.length;
      textBuf += part.text;
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
  // Use language-aware estimator when we have text (Phase 2):
  // Indonesian ~6 chars/token, CJK ~2.5, English ~4.
  // Falls back to char-based estimate for non-text content.
  if (textBuf.length > 0) {
    return estimateTokensFromString(textBuf);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface PruneResult {
  messages: UIMessage[];
  droppedCount: number;
  estimatedTokens: number;
}

/**
 * Estimator self-calibration: the ~4 chars/token heuristic undercounts
 * some payloads (Indonesian/CJK prose, dense JSON) by 30-40%, which made
 * the guard pass prompts that the provider then rejected for exceeding
 * the real context limit. Providers report the true input token count on
 * every finish-step; comparing it to what we estimated for the same
 * prompt yields a model-specific correction factor. The guard divides
 * its budget by the factor, so the first over-budget turn teaches the
 * guard and every later turn compacts correctly.
 *
 * The ratio is monotonically non-increasing: the first observation sets
 * the initial value; subsequent observations can only shrink it (decayed
 * by RATIO_DECAY_RATE each turn). A single atypical step never loosens
 * the budget. Ratios below 1 (the estimator overcounted) are still honored
 * so the budget grows back — at the decay rate, not instantly.
 */
const observedRatios = new Map<string, number>();

/** Persisted across restarts (best-effort) so calibration survives reboots. */
const RATIO_CACHE_FILE = "data/cache/token-ratios.json";
const RATIO_CACHE_MAX_ENTRIES = 100; // Rule 02 §2.3: bounded cache
const RATIO_MAX = 10; // hard ceiling: a 10x undercount means a broken estimate
const RATIO_MIN = 0.5; // floor: never let the budget balloon beyond 2x
// non-increasing (a single spike sets the initial value; subsequent lower
// observations only shrink it). A 0.7 rate means a 4× spike recovers to 1.0
// in ~4 turns instead of ~15, so the budget doesn't stay artificially
// tight after a one-off atypical prompt (e.g. a system prompt with dense JSON).
const RATIO_DECAY_RATE = 0.7;

let ratioCacheLoaded = false;
async function loadRatioCache(): Promise<void> {
  if (ratioCacheLoaded) return;
  ratioCacheLoaded = true;
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(RATIO_CACHE_FILE, "utf-8"));
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          observedRatios.set(k, clampRatio(v));
        }
      }
    }
  } catch (err) {
    // No cache yet or unreadable — start from the neutral ratio of 1.
    console.debug(`[context-budget] loadRatioCache failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Rule 02 §2.3: evict oldest entries when cache exceeds max size
function evictStaleRatios(): void {
  if (observedRatios.size < RATIO_CACHE_MAX_ENTRIES) return;
  // Sort by insertion order (Map preserves it); first entries are oldest cache
  // loads, not fresh observations. Evict oldest first to keep recent calibrations.
  const entries = [...observedRatios.entries()];
  observedRatios.clear();
  const keepCount = RATIO_CACHE_MAX_ENTRIES - 1;
  for (let i = Math.max(0, entries.length - keepCount); i < entries.length; i++) {
    observedRatios.set(entries[i][0], entries[i][1]);
  }
}

let ratioCacheTimer: ReturnType<typeof setTimeout> | null = null;
async function persistRatioCache(): Promise<void> {
  // Debounced, fire-and-forget: calibration is advisory, never blocking.
  if (ratioCacheTimer) clearTimeout(ratioCacheTimer);
  ratioCacheTimer = setTimeout(async () => {
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir("data/cache", { recursive: true });
      await writeFile(
        RATIO_CACHE_FILE,
        JSON.stringify(Object.fromEntries(observedRatios)),
        "utf-8"
      );
    } catch (err) {
      // Disk write failure must never break the chat path.
      console.debug(`[context-budget] persistRatioCache failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 1000);
}

// Rule 02 §2.2: cleanup for HMR / SSR module teardown.
export function disposeRatioCache(): void {
  if (ratioCacheTimer) {
    clearTimeout(ratioCacheTimer);
    ratioCacheTimer = null;
  }
}

function clampRatio(value: number): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, value));
}

/**
 * Records what the provider actually counted for a prompt we estimated at
 * `estimatedTokens`. The ratio is monotonically non-increasing: the first
 * observation sets the initial value, and subsequent lower observations
 * only shrink it (at RATIO_DECAY_RATE per turn). This means a one-off
 * spike in token count temporarily tightens the budget, but it recovers
 * quickly once normal turns resume.
 */
export function recordTokenRatio(
  modelId: string,
  estimatedTokens: number,
  actualInputTokens: number
): void {
  if (
    !modelId ||
    !Number.isFinite(estimatedTokens) ||
    !Number.isFinite(actualInputTokens) ||
    estimatedTokens < 1000 || // tiny prompts carry heavy fixed overhead skew
    actualInputTokens <= 0
  ) {
    return;
  }
  const ratio = clampRatio(actualInputTokens / estimatedTokens);
  const current = observedRatios.get(modelId);
  const next =
    current == null
      ? ratio
      : Math.max(
          current * RATIO_DECAY_RATE,
          Math.min(current, ratio)
        );
  // Decay lets a stale conservative ratio relax gradually if the newer
  // observations are consistently lower; Math.min keeps the tightest of
  // the two for this turn.
  if (next !== current) {
    evictStaleRatios();
    observedRatios.set(modelId, next);
    void persistRatioCache();
  }
}

/** The calibration factor for a model (1 = estimator believed exact). */
export function getTokenRatio(modelId: string): number {
  void loadRatioCache();
  return observedRatios.get(modelId) ?? 1;
}

export function calculateContextTokenBudget(options: {
  contextWindow: number | null | undefined;
  requestedOutputTokens: number;
  systemAndToolsTokens?: number;
}): {
  budgetTokens: number;
  effectiveMaxOutputTokens: number;
  effectiveSystemTokens: number;
  isFallback: boolean;
  effectiveWindow: number;
} {
  const isFallback =
    options.contextWindow == null || options.contextWindow <= 0;
  const effectiveWindow = isFallback ? 24_000 : options.contextWindow!;

  if (isFallback) {
    console.warn(
      "[context-budget] contextWindow unknown for model; defaulting to safe 24k window"
    );
  }

  const systemAndTools = options.systemAndToolsTokens ?? 4_000;
  const shouldClamp =
    effectiveWindow <= 32_000 ||
    options.requestedOutputTokens + systemAndTools > effectiveWindow * 0.5;

  if (shouldClamp) {
    const effectiveMaxOutputTokens = Math.min(
      options.requestedOutputTokens,
      Math.max(1_000, Math.floor(effectiveWindow * 0.35))
    );
    const effectiveSystem = Math.min(
      systemAndTools,
      Math.floor(effectiveWindow * 0.20)
    );
    const budgetTokens = Math.max(
      1_000,
      effectiveWindow - effectiveMaxOutputTokens - effectiveSystem
    );
    return {
      budgetTokens,
      effectiveMaxOutputTokens,
      effectiveSystemTokens: effectiveSystem,
      isFallback,
      effectiveWindow,
    };
  }

  const effectiveMaxOutputTokens = options.requestedOutputTokens;
  const effectiveSystem = systemAndTools;
  const budgetTokens =
    effectiveWindow - effectiveMaxOutputTokens - effectiveSystem;

  return {
    budgetTokens,
    effectiveMaxOutputTokens,
    effectiveSystemTokens: effectiveSystem,
    isFallback,
    effectiveWindow,
  };
}

/**
 * Helper to extract tool call IDs referenced in a message part.
 */
function getMessageToolCallIds(message: UIMessage): {
  calls: Set<string>;
  results: Set<string>;
} {
  const calls = new Set<string>();
  const results = new Set<string>();

  for (const part of message.parts) {
    if ("toolCallId" in part && typeof part.toolCallId === "string") {
      const type = (part as { type?: string }).type ?? "";
      // In AI SDK UIMessage, a tool-result or dynamic-tool with output/result is a result.
      // In the test mock, { type: "tool-call", toolCallId: "c1" } vs { type: "tool-result", toolCallId: "c1" }.
      if (type === "tool-call") {
        calls.add(part.toolCallId);
      } else if (type === "tool-result") {
        results.add(part.toolCallId);
      } else if (type === "dynamic-tool" || type.startsWith("tool-")) {
        // dynamic-tool or typed tool: ONE unified part carries both the
        // call and (once state reaches a terminal output) the result —
        // it is self-paired, never dangling. Registering it in BOTH sets
        // keeps the atomicity check from classifying an answered client
        // tool (e.g. ask_user_question, state "output-available") as an
        // orphan result and dropping the assistant turn that holds the
        // user's answers — the root cause of the infinite re-ask loop.
        const state = (part as { state?: string }).state;
        if (state === "output-available" || state === "output-denied" || "output" in part) {
          results.add(part.toolCallId);
          calls.add(part.toolCallId);
        } else {
          calls.add(part.toolCallId);
        }
      }
    }
  }

  return { calls, results };
}

/**
 * Extracts plain text from a message.
 */
function extractMessageText(message: UIMessage): string {
  const texts: string[] = [];
  for (const part of message.parts) {
    if ("text" in part && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.join(" ").trim();
}

/**
 * Generates an extractive summary from dropped messages, respecting hierarchical
 * rollup and capping summary text length to MAX_SUMMARY_CHARS (1,500 tokens).
 */
function generateExtractiveSummary(
  droppedMessages: UIMessage[],
  maxChars: number = MAX_SUMMARY_CHARS
): string {
  let priorSummary = "";
  const newIntents: string[] = [];
  const keyFiles: Set<string> = new Set();
  const keyDecisions: string[] = [];

  for (const msg of droppedMessages) {
    const text = extractMessageText(msg);
    if (!text) continue;

    // Check for existing conversation summary. The closing "]" is on its
    // own line (see generateExtractiveSummary's suffix), so the regex
    // matches up to "\n]" — robust against "]" characters in the content.
    const summaryMatch = text.match(/\[Conversation Summary:\s*([\s\S]*?)\n\]/i);
    if (summaryMatch) {
      priorSummary = summaryMatch[1].trim();
      // Remove the summary block to process the remaining text
      const remainingText = text.replace(/\[Conversation Summary:\s*[\s\S]*?\n\]/i, "").trim();
      if (remainingText && msg.role === "user") {
        newIntents.push(remainingText.slice(0, 150));
      }
      continue;
    }

    if (msg.role === "user") {
      // Look for user intents / questions
      const firstLine = text.split("\n")[0].trim();
      if (firstLine.length > 0) {
        newIntents.push(firstLine.slice(0, 150));
      }
    } else if (msg.role === "assistant") {
      // Look for key decisions or actions mentioned
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith("- ") ||
          trimmed.startsWith("* ") ||
          trimmed.includes("decided") ||
          trimmed.includes("created") ||
          trimmed.includes("updated")
        ) {
          if (trimmed.length > 5 && trimmed.length < 150) {
            keyDecisions.push(trimmed);
            if (keyDecisions.length >= 5) break;
          }
        }
      }
    }

    // Extract mentioned file paths (e.g., src/... or .ts/.tsx/.md files)
    const fileMatches = text.match(/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9_-]+/g);
    if (fileMatches) {
      for (const f of fileMatches) {
        if (f.includes("/") || f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".md") || f.endsWith(".json")) {
          keyFiles.add(f);
        }
      }
    }
  }

  const lines: string[] = [];

  if (priorSummary) {
    // Preserve prior summary points
    lines.push(priorSummary);
  }

  if (newIntents.length > 0) {
    const uniqueIntents = Array.from(new Set(newIntents)).slice(-5);
    for (const intent of uniqueIntents) {
      lines.push(`- User query: ${intent}`);
    }
  }

  if (keyDecisions.length > 0) {
    const uniqueDecisions = Array.from(new Set(keyDecisions)).slice(-5);
    for (const dec of uniqueDecisions) {
      lines.push(`- Decision: ${dec.replace(/^[-*]\s*/, "")}`);
    }
  }

  if (keyFiles.size > 0) {
    const fileList = Array.from(keyFiles).slice(0, 5).join(", ");
    lines.push(`- Files referenced: ${fileList}`);
  }

  let combined = lines.join("\n");
  const prefix = "[Conversation Summary:\n";
  // Closing bracket on its own line so the regex in the prior-summary
  // extraction doesn't terminate early on "]" characters inside the
  // summary content (e.g. file refs like src/foo.ts] or array notation).
  const suffix = "\n]";

  // Max characters available for the inside of the summary block
  const maxInnerChars = maxChars - prefix.length - suffix.length;

  if (combined.length > maxInnerChars) {
    // Hierarchical truncation: keep the latest points
    combined = combined.slice(combined.length - maxInnerChars);
    // Align to the next line break if possible
    const firstNl = combined.indexOf("\n");
    if (firstNl !== -1 && firstNl < 100) {
      combined = "..." + combined.slice(firstNl);
    }
  }

  return `${prefix}${combined}${suffix}`;
}

/**
 * Compacts and prunes messages within `budgetTokens`.
 *
 * Invariants:
 * 1. Tool-call and tool-result pairs are treated as an atomic unit and never
 *    split across the pruning boundary.
 * 2. Kept messages always start on a clean user-turn boundary.
 * 3. Dropped history is compacted into a fast synchronous summary injected
 *    into the first kept user message.
 * 4. Summary is hierarchically rolled up and capped to <= 1,500 tokens (~6,000 chars).
 */
export function compactAndPruneMessages(
  messages: UIMessage[],
  budgetTokens: number = DEFAULT_CONTEXT_TOKEN_BUDGET,
  maxSummaryChars?: number
): PruneResult {
  if (messages.length === 0) {
    return { messages: [], droppedCount: 0, estimatedTokens: 0 };
  }

  // Fast path: if all messages fit within the budget, return immediately
  // without the backward scan or summary generation. Keeping all messages
  // means there are no tool-call/result splits to worry about.
  {
    let totalTokens = 0;
    for (const msg of messages) {
      totalTokens += estimateMessageTokens(msg);
      if (totalTokens > budgetTokens) break;
    }
    if (totalTokens <= budgetTokens) {
      return { messages, droppedCount: 0, estimatedTokens: totalTokens };
    }
  }

  const kept: UIMessage[] = [];
  let used = 0;

  // Track tool IDs in the kept slice to ensure atomic tool pairs
  const keptToolCalls = new Set<string>();
  const keptToolResults = new Set<string>();

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const cost = estimateMessageTokens(msg);

    // If adding this message exceeds budget (and we already have at least 1 message), stop
    if (kept.length > 0 && used + cost > budgetTokens) {
      break;
    }

    kept.unshift(msg);
    used += cost;

    const { calls, results } = getMessageToolCallIds(msg);
    for (const c of calls) keptToolCalls.add(c);
    for (const r of results) keptToolResults.add(r);
  }

  // Slide forward to a clean user-turn boundary
  while (kept.length > 0 && kept[0].role !== "user") {
    const removed = kept.shift()!;
    used -= estimateMessageTokens(removed);
    const { calls, results } = getMessageToolCallIds(removed);
    for (const c of calls) keptToolCalls.delete(c);
    for (const r of results) keptToolResults.delete(r);
  }

  // Enforce tool atomicity:
  // If a toolCall is kept without its toolResult, or toolResult without its toolCall,
  // we must either drop the dangling message(s) from kept or ensure both are dropped.
  // Since kept is a suffix of messages, if kept has a toolResult whose toolCall was in
  // dropped messages (i.e. keptToolResults has id not in keptToolCalls), we must slide
  // forward past the toolResult until tool atomicity is restored.
  let hasDanglingTool = true;
  while (hasDanglingTool && kept.length > 0) {
    hasDanglingTool = false;

    // Recalculate kept calls and results
    keptToolCalls.clear();
    keptToolResults.clear();
    for (const m of kept) {
      const { calls, results } = getMessageToolCallIds(m);
      for (const c of calls) keptToolCalls.add(c);
      for (const r of results) keptToolResults.add(r);
    }

    // Check for asymmetric tool pairs
    for (const callId of keptToolCalls) {
      if (!keptToolResults.has(callId)) {
        // toolCall exists in kept, but toolResult is missing from kept
        // To maintain atomicity, drop from front until clean
        hasDanglingTool = true;
        break;
      }
    }
    if (!hasDanglingTool) {
      for (const resultId of keptToolResults) {
        if (!keptToolCalls.has(resultId)) {
          // toolResult exists in kept, but toolCall was dropped
          hasDanglingTool = true;
          break;
        }
      }
    }

    if (hasDanglingTool) {
      // Drop the oldest kept message and ensure user-turn boundary
      const removed = kept.shift()!;
      used -= estimateMessageTokens(removed);

      // Slide forward to next user message
      while (kept.length > 0 && kept[0].role !== "user") {
        const rem = kept.shift()!;
        used -= estimateMessageTokens(rem);
      }
    }
  }

  // If stripping left kept empty, fall back to the last user message (or last message)
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

  const droppedMessages = messages.slice(0, droppedCount);
  const summaryBlock = generateExtractiveSummary(
    droppedMessages,
    maxSummaryChars
  );

  const [first, ...rest] = kept;
  const annotated: UIMessage = {
    ...first,
    parts: [
      { type: "text", text: summaryBlock },
      ...first.parts,
    ],
  };

  return {
    messages: [annotated, ...rest],
    droppedCount,
    estimatedTokens: used + estimateTokensFromString(summaryBlock),
  };
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

  // AI SDK v7 rejects role:"system" UIMessages inside the messages array
  // ("System messages are not allowed in the prompt or messages fields").
  // The truncation notice is therefore prepended as TEXT inside the first
  // kept user message — visible to the model, valid for every provider.
  const note = `[Context note: ${droppedCount} earlier messages were truncated to fit the context window. Ask the user to restate anything you need from them.]`;
  const [first, ...rest] = kept;
  const annotated: UIMessage = {
    ...first,
    parts: [
      { type: "text", text: note },
      ...first.parts,
    ],
  };

  return {
    messages: [annotated, ...rest],
    droppedCount,
    estimatedTokens: used,
  };
}
