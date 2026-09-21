// src/lib/ai/harness-loop.ts
/**
 * Owns two things for the Project Harness (and only the Project Harness —
 * the main chat route has its own loop policy):
 *
 * 1. The harness loop policy: the step cap, the `prepareStep` policy and the
 *    stop conditions used by `POST /api/projects/chat`. This is the single
 *    source of truth for those constants (see {@link HARNESS_MAX_STEPS},
 *    {@link HARNESS_TIMEOUT}, {@link createHarnessPrepareStep},
 *    {@link createHarnessStopConditions}).
 * 2. A thin `streamText()` wrapper ({@link createHarnessLoop}) that
 *    intercepts AI-SDK timeout errors (`DOMException` with name
 *    `"TimeoutError"`), classifies and logs them, and forwards them to an
 *    optional `onTimeoutError` hook *before* the caller's own `onError` runs.
 *
 * This module does NOT define tools, security primitives, or any
 * route-specific state.
 */

import {
  isStepCount,
  streamText,
  type Instructions,
  type ModelMessage,
  type PrepareStepFunction,
  type StopCondition,
  type StreamTextOnErrorCallback,
  type SystemModelMessage,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { evaluateContextGuard } from "@/lib/ai/harness-context";
import { syslog } from "@/lib/observability/log-store";

// ── Harness loop policy (single source of truth) ────────────────────

/** Hard cap on agent steps per turn for the project harness. */
export const HARNESS_MAX_STEPS = 60;

/**
 * Inner `bash` timeout, enforced by the tool's own process-group kill so the
 * model receives a structured result. Must stay strictly below the outer
 * SDK `bash` timeout in {@link HARNESS_TIMEOUT}.
 */
export const HARNESS_BASH_TIMEOUT_MS = 240_000;

/**
 * Timeouts for the coding harness. Deliberately far looser than the chat
 * route: builds/tests take minutes and reasoning models at high effort can
 * think for minutes with no output at all.
 *
 * The `chunkMs` watchdog is a *per-gap* timeout, not a cumulative one: the SDK
 * re-arms it on every output chunk (see `resetChunkTimeout` in
 * node_modules/ai/dist/index.js), so it only fires when the stream genuinely
 * stalls. It is deliberately set well above any reasoning pause and below
 * `stepMs`; an earlier value of 60s killed reasoning runs after ~6 steps with
 * no error, because the SDK reports a timeout as an *abort*, which does not
 * fire `onError`.
 *
 * Invariants (asserted in harness-loop.test.ts):
 *   totalMs > stepMs > chunkMs > firstChunkMs
 *   tools.bashMs > HARNESS_BASH_TIMEOUT_MS > 60_000
 */
export const HARNESS_TIMEOUT = {
  totalMs: 60 * 60_000,
  stepMs: 10 * 60_000,
  // Gap between consecutive output chunks. A reasoning model emits no output
  // while thinking, so this must sit far above any plausible thinking pause —
  // but strictly below stepMs, or the watchdog can never fire first and a dead
  // socket burns the whole step. Reasoning deltas reset it; five minutes of
  // silence means the connection is dead.
  chunkMs: 5 * 60_000,
  firstChunkMs: 3 * 60_000,
  toolMs: 2 * 60_000,
  tools: { bashMs: 5 * 60_000 },
} as const;

/** Stop only on the step cap. The harness has no `ask_user_question` tool. */
export function createHarnessStopConditions(): Array<StopCondition<ToolSet>> {
  return [isStepCount(HARNESS_MAX_STEPS)];
}

/** Inputs for {@link formatHarnessRunEndLog}. */
export interface HarnessRunEndLogInput {
  steps: number;
  finishReason: string;
  contextElisions: number;
  contextWrapUp: boolean;
}

/**
 * The single-line run-end summary. Owned here (not inline in the route) so
 * the format is one source of truth and testable without a Next.js route.
 *
 * `contextWrapUp` is the field that distinguishes a context-forced stop from
 * a natural one: both finish with `finishReason=stop` and fewer than
 * `HARNESS_MAX_STEPS` steps.
 */
export function formatHarnessRunEndLog(input: HarnessRunEndLogInput): string {
  return (
    `Harness run ended: steps=${input.steps}` +
    ` finishReason=${input.finishReason}` +
    ` reachedStepCap=${input.steps >= HARNESS_MAX_STEPS}` +
    ` contextElisions=${input.contextElisions}` +
    ` contextWrapUp=${input.contextWrapUp}`
  );
}

const HARNESS_WRAP_UP_INSTRUCTION =
  "You have reached the maximum number of steps for this turn. Do not call any more tools. Write a brief status report: what is done, what remains, and the exact next step the user should request.";

const HARNESS_CONTEXT_WRAP_UP_INSTRUCTION =
  "The context window is nearly full. Do not call any more tools. Write a brief status report: what is done, what remains, and the exact next step the user should request so the work can continue in a fresh turn.";

function appendInstruction(
  base: Instructions | undefined,
  addition: string
): Instructions {
  const extra: SystemModelMessage = { role: "system", content: addition };
  if (base === undefined) return extra;
  if (typeof base === "string") return `${base}\n\n${addition}`;
  return Array.isArray(base) ? [...base, extra] : [base, extra];
}

/** Options for {@link createHarnessPrepareStep}. */
export interface HarnessPrepareStepOptions {
  /**
   * Ratio-adjusted token budget for the run's prompt (the Projects route's
   * `budgetTokens`). When omitted the policy is exactly the step-cap policy
   * and never touches the prompt.
   */
  contextBudgetTokens?: number;

  /**
   * Called whenever the context guard acts, so the caller can attribute the
   * run's end (a context wrap-up finishes with `finishReason=stop` and fewer
   * than `HARNESS_MAX_STEPS` steps, otherwise indistinguishable from a
   * natural stop).
   */
  onContextGuard?: (event: {
    action: "elide" | "wrap-up";
    elidedCount?: number;
    prunedReasoning?: boolean;
    tokensBefore?: number;
    tokensAfter: number;
  }) => void;
}

/**
 * Prepare-step policy for the harness. It changes nothing (no temperature
 * drop, no model swap, no tool withholding; `bash` must stay available for
 * the Verification Gate) except:
 *
 * - On the final permitted step it forces a text wrap-up so a capped run
 *   never ends silently mid-task.
 * - When `contextBudgetTokens` is set, it runs the in-run context guard
 *   (see `@/lib/ai/harness-context`): stale tool output is elided once the
 *   prompt passes 80% of the budget, and if eliding cannot bring it back
 *   under 95% the run is forced to wrap up with a status report.
 *
 * A returned `messages` override carries forward to later steps, so elision
 * is cumulative; `elideStaleToolOutputs` is idempotent, so already-stubbed
 * outputs are never re-processed.
 */
export function createHarnessPrepareStep(
  options?: HarnessPrepareStepOptions
): PrepareStepFunction<ToolSet> {
  const contextBudgetTokens = options?.contextBudgetTokens;
  const onContextGuard = options?.onContextGuard;

  return ({ stepNumber, instructions, messages }) => {
    if (stepNumber >= HARNESS_MAX_STEPS - 1) {
      // Step-cap wrap-up wins. Carry any elision that is still warranted so
      // the final prompt also benefits from the guard.
      const capWrapUp: {
        toolChoice: "none";
        instructions: Instructions;
        messages?: ModelMessage[];
      } = {
        toolChoice: "none",
        instructions: appendInstruction(
          instructions,
          HARNESS_WRAP_UP_INSTRUCTION
        ),
      };
      if (contextBudgetTokens !== undefined) {
        const decision = evaluateContextGuard({
          messages,
          budgetTokens: contextBudgetTokens,
          stepNumber,
        });
        if (decision.action === "elide") {
          capWrapUp.messages = decision.messages;
          onContextGuard?.({
            action: "elide",
            elidedCount: decision.elidedCount,
            prunedReasoning: decision.prunedReasoning,
            tokensBefore: decision.tokensBefore,
            tokensAfter: decision.tokensAfter,
          });
        } else if (decision.action === "wrap-up") {
          if (decision.messages) capWrapUp.messages = decision.messages;
          onContextGuard?.({
            action: "wrap-up",
            tokensAfter: decision.tokensAfter,
          });
        }
      }
      return capWrapUp;
    }

    if (contextBudgetTokens === undefined) return {};

    const decision = evaluateContextGuard({
      messages,
      budgetTokens: contextBudgetTokens,
      stepNumber,
    });

    if (decision.action === "none") return {};

    if (decision.action === "elide") {
      const reasoningSuffix = decision.prunedReasoning
        ? " and pruned stale reasoning"
        : "";
      syslog(
        "info",
        "agent",
        `Context guard: elided ${decision.elidedCount} tool outputs${reasoningSuffix} (~${decision.tokensBefore} → ~${decision.tokensAfter} tokens, budget ${contextBudgetTokens})`
      );
      onContextGuard?.({
        action: "elide",
        elidedCount: decision.elidedCount,
        prunedReasoning: decision.prunedReasoning,
        tokensBefore: decision.tokensBefore,
        tokensAfter: decision.tokensAfter,
      });
      // Only `messages`: never activeTools, temperature or model.
      return { messages: decision.messages };
    }

    syslog(
      "warn",
      "agent",
      `Context guard: prompt still ~${decision.tokensAfter} tokens at step ${stepNumber} (budget ${contextBudgetTokens}); forcing a wrap-up.`
    );
    onContextGuard?.({
      action: "wrap-up",
      tokensAfter: decision.tokensAfter,
    });
    const contextWrapUp: {
      toolChoice: "none";
      instructions: Instructions;
      messages?: ModelMessage[];
    } = {
      toolChoice: "none",
      instructions: appendInstruction(
        instructions,
        HARNESS_CONTEXT_WRAP_UP_INSTRUCTION
      ),
    };
    if (decision.messages) {
      contextWrapUp.messages = decision.messages;
    }
    return contextWrapUp;
  };
}

// ── Timeout error detection ─────────────────────────────────────────

/**
 * The AI SDK creates timeout errors using:
 *   `new DOMException("${label} timeout of ${timeoutMs}ms exceeded", "TimeoutError")`
 * (see `node_modules/ai/dist/index.js`).
 *
 * `label` is one of: "total", "step", "first chunk", "chunk", "tool",
 * or `tool:${toolName}`.
 *
 * @returns `true` when the error is an AI-SDK timeout `DOMException`.
 */
export function isTimeoutError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/**
 * Parses an AI-SDK timeout error message and returns a human-readable
 * classification string such as `"step timeout (30000ms)"`.
 *
 * @returns a classification string; `"unknown timeout"` for non-timeout
 * errors or messages that don't match the expected pattern.
 */
export function classifyTimeoutError(error: unknown): string {
  if (!isTimeoutError(error)) {
    return "unknown timeout";
  }
  const match = error.message.match(/^(.+?) timeout of (\d+)ms exceeded$/);
  if (match) {
    const [, label, ms] = match;
    return `${label} timeout (${ms}ms)`;
  }
  return error.message;
}

/**
 * Builds the user-facing message for a timeout error.
 *
 * Derives the classification from the error itself rather than from shared
 * state set by `streamText`'s `onError`: the UI-stream error mapper can run
 * *before* `onError` fires, so a variable populated by `onTimeoutError` may
 * still be `undefined` when the mapper reads it (the client would then see
 * the raw `TimeoutError: …` text). Passing the error in removes that race.
 *
 * @returns the message for a timeout error; `undefined` for anything else
 * (callers fall back to their own error formatting).
 */
export function formatTimeoutForClient(error: unknown): string | undefined {
  if (!isTimeoutError(error)) return undefined;
  return `The agent timed out (${classifyTimeoutError(error)}). Send a follow-up message to continue.`;
}

/**
 * Matches the AI SDK's timeout abort reason. The SDK aborts the in-flight
 * operation with `new DOMException("${label} timeout of ${timeoutMs}ms exceeded",
 * "TimeoutError")` and serialises `abortSignal.reason` into the `abort` stream
 * part as a string (see `node_modules/ai/dist/index.js`). Accepts the raw
 * `DOMException` too, for callers that pass the reason object directly.
 */
function isTimeoutAbortReason(reason: unknown): boolean {
  if (reason instanceof DOMException) return reason.name === "TimeoutError";
  if (typeof reason !== "string") return false;
  return /timeout of \d+ms exceeded/i.test(reason);
}

/**
 * Converts a *timeout* `abort` part into an `error` part, so the failure
 * reaches the client instead of vanishing.
 *
 * Why this exists: when the AI SDK's `timeout` fires it aborts the operation
 * and emits `{ type: "abort", reason }` — it does NOT call `onError`. That
 * part passes straight through `toUIMessageStream`, and `@ai-sdk/react`
 * ignores abort parts entirely, so `useChat` returned to `ready` with
 * `error === undefined` and the user saw the run stop for no stated reason.
 * Rewriting it as an `error` part routes it through the existing error path:
 * the route's `onError` clears the stale stream pointer, `onEnd` still
 * persists the transcript, and the client renders the message.
 *
 * Non-timeout aborts (e.g. a future user-cancel path) pass through unchanged,
 * so this cannot mask a deliberate cancellation as a failure.
 */
export function timeoutAbortToErrorPart(
  stream: ReadableStream<TextStreamPart<ToolSet>>
): ReadableStream<TextStreamPart<ToolSet>> {
  return stream.pipeThrough(
    new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
      transform(part, controller) {
        if (part.type === "abort" && isTimeoutAbortReason(part.reason)) {
          controller.enqueue({
            type: "error",
            error: new Error(
              `The agent timed out (${part.reason ?? "unknown timeout"}). Send a follow-up message to continue.`
            ),
          });
          return;
        }
        controller.enqueue(part);
      },
    })
  );
}

// ── Harness loop ────────────────────────────────────────────────────

/**
 * Options for {@link createHarnessLoop}.
 *
 * This is a superset of the `streamText` options — it inherits every field
 * (model, tools, instructions, messages, callbacks, etc.) and adds an
 * optional `onTimeoutError` hook that fires *before* the caller's `onError`.
 */
export interface HarnessLoopOptions
  extends Omit<Parameters<typeof streamText>[0], "onError"> {
  /**
   * Invoked when a timeout error is detected by the harness loop's
   * built-in `onError` interceptor. Receives the raw `DOMException`
   * and a classification string (e.g. `"step timeout (30000ms)"`).
   *
   * The caller's `onError` callback is still invoked afterwards.
   */
  onTimeoutError?: (error: DOMException, classification: string) => void;

  /**
   * The caller's `onError` callback. This is invoked *after* the
   * timeout-error interceptor has run, so the caller can still perform
   * cleanup (e.g. closing MCP connections) regardless of whether the
   * error was a timeout.
   */
  onError?: StreamTextOnErrorCallback;
}

/**
 * Creates and executes a harness loop — a thin wrapper around
 * `streamText()` that intercepts timeout errors.
 *
 * The function passes all options through to `streamText` unchanged,
 * except for `onError`, which is wrapped to:
 * 1. Detect AI-SDK timeout errors via {@link isTimeoutError}.
 * 2. Classify them via {@link classifyTimeoutError}.
 * 3. Log a warning via `syslog`.
 * 4. Invoke the optional `onTimeoutError` hook.
 * 5. Delegate to the caller's `onError` callback.
 *
 * @returns the `StreamTextResult` from `streamText`, identical to what
 * the caller would get by calling `streamText` directly.
 */
export function createHarnessLoop(options: HarnessLoopOptions) {
  const { onError, onTimeoutError, ...rest } = options;

  return streamText({
    ...rest,
    onError: ({ error }) => {
      if (isTimeoutError(error)) {
        const classification = classifyTimeoutError(error);
        syslog("warn", "agent", `Timeout error detected: ${classification}`);
        onTimeoutError?.(error, classification);
      }
      onError?.({ error });
    },
  } as Parameters<typeof streamText>[0]);
}
