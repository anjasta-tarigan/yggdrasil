/**
 * Global server-side observability capture.
 *
 * Most subsystems log through raw `console.*` calls (112+ across the
 * codebase), which never reach the structured log store — that is why
 * the Statistics log viewer only showed the handful of explicit syslog
 * calls. This module patches the console methods and installs process
 * crash hooks so every log line — info, warn, error, debug — lands in
 * the ring buffer and the mirrored log file.
 *
 * Anchored on globalThis so dev-server HMR reloads patch exactly once.
 * Server-only: imports log-store, which touches node:fs.
 */

import { syslog, type LogLevel } from "./log-store";

type CaptureState = {
  originals: {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
    debug: typeof console.debug;
  };
  onUnhandledRejection: (reason: unknown) => void;
  onUncaughtException: (err: Error) => void;
};

const CAPTURE_KEY = "__yggdrasilLogCapture";

function captureState(): CaptureState | null {
  const g = globalThis as unknown as Record<string, CaptureState | undefined>;
  return g[CAPTURE_KEY] ?? null;
}

/** JSON.stringify with circular-reference protection. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    });
  } catch {
    // Non-serializable beyond circularity (e.g. BigInt) — String() is the
    // safe fallback.
    return String(value);
  }
}

/** Formats a console.* argument list into one flattenable string. */
function formatArgs(args: unknown[]): string {
  const parts: string[] = [];
  for (const arg of args) {
    if (typeof arg === "string") {
      parts.push(arg);
    } else if (arg instanceof Error) {
      // Message inline; the stack is appended separately for errors.
      parts.push(arg.message);
    } else {
      parts.push(safeStringify(arg));
    }
  }
  return parts.join(" ");
}

/** Stack traces are truncated so one pathological error can't eat the buffer. */
const MAX_STACK_CHARS = 2000;

function extractStack(args: unknown[]): string | null {
  const err = args.find((a): a is Error => a instanceof Error);
  if (!err?.stack) return null;
  return err.stack.length > MAX_STACK_CHARS
    ? `${err.stack.slice(0, MAX_STACK_CHARS)}…`
    : err.stack;
}

/** Parses `console.error("[QueueRunner] msg", err)` style prefixes. */
function parseScope(args: unknown[]): { scope: string; messageParts: unknown[] } {
  const first = args[0];
  if (typeof first === "string") {
    const match = first.match(/^\[([A-Za-z0-9 _-]{1,32})\]/);
    if (match) {
      return {
        scope: match[1],
        // Drop the "[Scope] " prefix from the message.
        messageParts: [first.slice(match[0].length).trimStart(), ...args.slice(1)],
      };
    }
  }
  return { scope: "console", messageParts: args };
}

/** Message cap: one runaway log line must not eat the buffer. */
const MAX_MESSAGE_CHARS = 2000;

function truncate(message: string): string {
  return message.length > MAX_MESSAGE_CHARS
    ? `${message.slice(0, MAX_MESSAGE_CHARS)}… (truncated)`
    : message;
}

/**
 * Installs the global capture layer. Idempotent: calling it twice (HMR,
 * bootstrap fallback) is a no-op. Never throws — a failed install must
 * degrade to plain console.
 */
export function installGlobalCapture(): void {
  const g = globalThis as unknown as Record<string, CaptureState | undefined>;
  if (g[CAPTURE_KEY]) return;

  const originals: CaptureState["originals"] = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  /**
   * Mirrors a console method: forward to syslog AND still call the
   * original so terminal output is unchanged.
   */
  const mirror = (original: (...args: unknown[]) => void, level: LogLevel) => (
    ...args: unknown[]
  ) => {
    try {
      const { scope, messageParts } = parseScope(args);
      let message = truncate(formatArgs(messageParts));
      const stack = level === "error" ? extractStack(args) : null;
      if (stack && !message.includes(stack)) {
        message = truncate(`${message}\n${stack}`);
      }
      syslog(level, scope, message);
    } catch {
      // Logging the log failure would recurse; drop silently here. The
      // original call below still happens.
    }
    original(...args);
  };

  console.log = mirror(originals.log, "info");
  console.info = mirror(originals.info, "info");
  console.warn = mirror(originals.warn, "warn");
  console.error = mirror(originals.error, "error");
  console.debug = mirror(originals.debug, "debug");

  const onUnhandledRejection = (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack =
      reason instanceof Error && reason.stack
        ? `\n${reason.stack.slice(0, MAX_STACK_CHARS)}`
        : "";
    syslog("error", "process", `Unhandled rejection: ${message}${stack}`);
    originals.error("[process] Unhandled rejection:", reason);
  };

  /**
   * Log first (syslog writes synchronously, so the file is flushed),
   * then preserve default crash semantics: an uncaught exception must
   * still terminate the process — swallowing it would leave the server
   * running in an unknown state. Skipped under Vitest, where exiting
   * would kill the test worker.
   */
  const onUncaughtException = (err: Error) => {
    const stack = err.stack ? `\n${err.stack.slice(0, MAX_STACK_CHARS)}` : "";
    syslog("error", "process", `Uncaught exception: ${err.message}${stack}`);
    originals.error("[process] Uncaught exception:", err);
    if (!process.env.VITEST) process.exit(1);
  };

  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);

  g[CAPTURE_KEY] = { originals, onUnhandledRejection, onUncaughtException };
}

/**
 * Removes the console patches and process listeners — cleanup mirrors
 * setup so repeated install/uninstall cycles (tests, HMR) never leak
 * duplicate handlers. Never throws.
 */
export function uninstallGlobalCapture(): void {
  const state = captureState();
  if (!state) return;
  console.log = state.originals.log;
  console.info = state.originals.info;
  console.warn = state.originals.warn;
  console.error = state.originals.error;
  console.debug = state.originals.debug;
  process.off("unhandledRejection", state.onUnhandledRejection);
  process.off("uncaughtException", state.onUncaughtException);
  const g = globalThis as unknown as Record<string, CaptureState | undefined>;
  delete g[CAPTURE_KEY];
}
