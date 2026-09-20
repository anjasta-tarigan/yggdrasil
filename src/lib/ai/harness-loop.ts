// src/lib/ai/harness-loop.ts
/**
 * Thin orchestration layer around `streamText()` that extracts the
 * streamText call + lifecycle callbacks from the chat route handler into
 * a testable, reusable function.
 *
 * Responsibilities:
 * - Accept the full set of `streamText` options (model, tools, instructions,
 *   messages, callbacks, etc.) plus an optional `onTimeoutError` hook.
 * - Wire the `onError` callback so that AI-SDK timeout errors
 *   (`DOMException` with name `"TimeoutError"`) are detected, classified,
 *   logged, and forwarded to `onTimeoutError` *before* the caller's own
 *   `onError` runs.
 *
 * This module does NOT define tools, security primitives, or any
 * route-specific state. It is a pure pass-through to `streamText` with
 * timeout-error interception layered on top.
 */

import {
  streamText,
  type StreamTextOnErrorCallback,
} from "ai";
import { syslog } from "@/lib/observability/log-store";

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
