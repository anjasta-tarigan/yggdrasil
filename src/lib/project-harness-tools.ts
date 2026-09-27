// src/lib/project-harness-tools.ts
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { assertSafeCommand } from "@/lib/sandbox/host-sandbox";
import { executeFileOperations } from "@/lib/ai/tools/file-operations-core";
import type { FileOperationsResult } from "@/lib/ai/tools/file-operations-core";
import { fileOperationsInputSchema } from "@/lib/ai/tools/file-operations-schema";
import type { FileOperationsInput } from "@/lib/ai/tools/file-operations-schema";
import { task_list_manager } from "@/lib/ai/tools/task";
import { artifact_publish } from "@/lib/ai/tools/artifact";
import { web_search, web_fetch } from "@/lib/ai/tools/web";
import {
  bashToolNeedsApproval,
  fileOperationsNeedsApproval,
} from "@/lib/project-harness-approval";

export interface ProjectHarnessToolsOptions {
  projectDirectory: string;
  canonicalRoot: string;
  trusted: boolean;
  timeoutMs?: number;
  /**
   * Window-aware cap (in characters) on a single tool result. The effective
   * cap is `Math.min(<static default>, resolved value)`, so with no option the
   * behavior is unchanged and a large window keeps the static defaults.
   *
   * Accepts a thunk because the Projects route creates the tools BEFORE it
   * computes `budgetTokens` (the combined tool set feeds the `effort: "auto"`
   * classification, which feeds the budget). The thunk is called at
   * tool-execution time, after `budgetTokens` is initialized.
   */
  maxOutputChars?: number | (() => number);
}

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB
const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5MB per Spec §4.2
/**
 * Bash output keeps its head and tail. Test/build/lint summaries and error
 * messages live at the END of the output, so a head-only cut hides exactly
 * what the model needs; the tail is weighted higher for that reason. The two
 * ratios must sum to 1 so the split exactly fills the cap.
 */
export const BASH_HEAD_RATIO = 0.4;
export const BASH_TAIL_RATIO = 0.6;

// FileOperationsResult / FileOperationsInput are re-exported from the shared
// modules so existing importers (project-harness-approval) keep working while
// the single implementation lives in file-operations-core.ts.
export type { FileOperationsResult, FileOperationsInput };

export interface ProjectHarnessTools {
  bash: Tool & {
    execute: (
      input: { command?: string; cmd?: string },
      options?: unknown
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  file_operations: Tool & {
    execute: (
      input: FileOperationsInput,
      options?: unknown
    ) => Promise<FileOperationsResult>;
  };
  manage_tasks: typeof task_list_manager;
  create_artifact: typeof artifact_publish;
  web_search: typeof web_search;
  web_fetch: typeof web_fetch;
}

/**
 * Truncate a bash stream to `maxChars`, preferring a line boundary, and tell
 * the model how to get the rest without re-running the whole command.
 *
 * Head-only: used by the `find`/`grep` probes, whose output is parsed as a
 * line list (a mid-output marker would be read as a match).
 */
function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  const preserved = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
  return `${preserved}\n…[output truncated at ${maxChars} chars; narrow it with head/tail/grep or redirect to a file]`;
}

/**
 * Format a head+tail view of a stream.
 *
 * `head` is the first `headCap` characters, `tail` the last `tailCap`, and
 * `total` everything the process emitted. When the whole output fits within
 * `headCap + tailCap` it is returned unchanged (no marker — the exact
 * boundary must not add one). Otherwise both sides are aligned to line
 * boundaries and the omitted middle is summarised, so the model sees the
 * opening context AND the trailing summary/error.
 */
function formatHeadTail(
  head: string,
  tail: string,
  total: number,
  headCap: number,
  tailCap: number
): string {
  if (total <= headCap + tailCap) return head + tail;

  // Align to line boundaries where possible: a partial first line in the tail
  // and a partial last line in the head are worse than useless. If a side has
  // no newline at all (one huge line), keep it as is.
  const headNewline = head.lastIndexOf("\n");
  const alignedHead = headNewline > 0 ? head.slice(0, headNewline) : head;
  const tailNewline = tail.indexOf("\n");
  const alignedTail =
    tailNewline >= 0 && tailNewline < tail.length - 1
      ? tail.slice(tailNewline + 1)
      : tail;

  const omitted = total - alignedHead.length - alignedTail.length;
  return (
    alignedHead +
    `\n…[${omitted} chars omitted from the middle; showing the first ${alignedHead.length} and last ${alignedTail.length} chars. Redirect the output to a file and use head/tail/grep to read a specific part]…\n` +
    alignedTail
  );
}

/** How a stream's buffered output should be shaped when it settles. */
type OutputMode = "head" | "head-tail";

/**
 * Bounded per-stream collector shared by stdout and stderr.
 *
 * `"head"` accumulates everything it is given (the caller's overflow guard
 * stops feeding it past 2x the cap) and returns the first `headCap` chars —
 * byte-identical to the historical head-only truncation.
 *
 * `"head-tail"` never discards input: it keeps the first `headCap` chars, a
 * rolling window of the last `tailCap`, and the running total, so `finish()`
 * can report the END of the output. Memory stays bounded by roughly
 * `headCap + 2 * tailCap` per stream.
 */
function createStreamCollector(
  mode: OutputMode,
  headCap: number,
  tailCap: number
): { push: (text: string) => void; finish: () => string; size: () => number } {
  let head = "";
  let tail = "";
  let total = 0;

  return {
    push(text: string) {
      if (text.length === 0) return;
      total += text.length;
      if (mode === "head") {
        head += text;
        return;
      }
      // Fill the head first; everything after that rolls through the tail.
      if (head.length < headCap) {
        const take = Math.min(headCap - head.length, text.length);
        head += text.slice(0, take);
        text = text.slice(take);
        if (text.length === 0) return;
      }
      tail += text;
      // Amortized trim: only pay for the slice when the buffer has doubled.
      if (tail.length > tailCap * 2) tail = tail.slice(-tailCap);
    },
    finish() {
      if (mode === "head") {
        return truncateOutput(head, headCap);
      }
      if (tail.length > tailCap) tail = tail.slice(-tailCap);
      return formatHeadTail(head, tail, total, headCap, tailCap);
    },
    size() {
      return total;
    },
  };
}

const RUNTIME_PROCESS_TIMEOUT_MS = 30_000;
const FORCE_KILL_GRACE_MS = 2000;

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Single spawn path shared by `bash` and the file-operation CLI probes.
 *
 * Spec §3.3: the child env is a minimal allowlist (PATH/HOME/USER/SHELL/LANG/
 * TERM/NODE_ENV) — server secrets never cross the boundary.
 * Spec §3.6: detached process group with SIGTERM → SIGKILL escalation on
 * timeout or abort.
 */
function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  options: {
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    maxOutputChars?: number;
    outputMode?: OutputMode;
  } = {}
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? RUNTIME_PROCESS_TIMEOUT_MS;
  // Bash streams are capped at the static default unless a window-aware cap
  // is tighter; the overflow guard below keeps buffering bounded by 2x.
  const maxOutputChars = Math.min(
    MAX_OUTPUT_CHARS,
    options.maxOutputChars ?? MAX_OUTPUT_CHARS
  );
  const outputMode = options.outputMode ?? "head";
  // Split per the ratios; the tail is the exact remainder so
  // headCap + tailCap === maxOutputChars on any cap (the no-marker boundary
  // must be predictable).
  const headCap =
    outputMode === "head-tail"
      ? Math.floor(maxOutputChars * BASH_HEAD_RATIO)
      : maxOutputChars;
  const tailCap = maxOutputChars - headCap;
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: cwd,
    USER: "project-agent",
    SHELL: "/bin/bash",
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    NODE_ENV: process.env.NODE_ENV || "development",
  };

  const { promise, resolve } = Promise.withResolvers<ProcessResult>();

  let child: ChildProcess;
  try {
    child = spawn(cmd, args, {
      cwd,
      env: safeEnv,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    resolve({
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 127,
    });
    return promise;
  }

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  const stdoutCollector = createStreamCollector(outputMode, headCap, tailCap);
  const stderrCollector = createStreamCollector(outputMode, headCap, tailCap);

  let stdoutOverflow = false;
  let stderrOverflow = false;
  let settled = false;
  let timedOut = false;
  let aborted = false;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let forceKillTimer: NodeJS.Timeout | null = null;

  const cleanup = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    options.abortSignal?.removeEventListener("abort", onAbort);
  };

  const killGroup = (signal: "SIGTERM" | "SIGKILL") => {
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch (outerErr) {
      console.debug("[project-harness-tools] Process group kill failed, falling back to child.kill:", outerErr);
      try {
        child.kill(signal);
      } catch (innerErr) {
        console.debug("[project-harness-tools] Process already exited during kill:", innerErr);
      }
    }
  };

  const settle = (exitCode: number, extra?: string) => {
    if (settled) return;
    settled = true;
    cleanup();

    // Flush the decoders through the same collector path so multi-byte
    // characters split across chunks are never corrupted.
    const stdoutFlush = stdoutDecoder.end();
    const stderrFlush = stderrDecoder.end();

    if (outputMode === "head-tail") {
      stdoutCollector.push(stdoutFlush);
      stderrCollector.push(stderrFlush);
      // Truncate FIRST, then append `extra`: a large stderr must never push
      // the timeout/abort reason out of the visible output.
      const stdout = stdoutCollector.finish();
      const stderr = stderrCollector.finish();
      resolve({
        stdout,
        stderr: extra ? `${stderr}${stderr ? "\n" : ""}${extra}` : stderr,
        code: exitCode,
      });
      return;
    }

    // Head mode: `extra` participates in truncation (historical behavior).
    stdoutCollector.push(stdoutFlush);
    stderrCollector.push(
      extra ? `${stderrFlush}${stderrFlush ? "\n" : ""}${extra}` : stderrFlush
    );
    resolve({
      stdout: stdoutCollector.finish(),
      stderr: stderrCollector.finish(),
      code: exitCode,
    });
  };

  // Spec §3.6: timeout, or user abort (stop()), sends SIGTERM to the process
  // group, then SIGKILL after a grace period if it has not exited.
  const terminate = (exitCode: number, reason: string) => {
    killGroup("SIGTERM");
    settle(exitCode, reason);
    forceKillTimer = setTimeout(() => killGroup("SIGKILL"), FORCE_KILL_GRACE_MS);
    forceKillTimer.unref?.();
  };

  const onAbort = () => {
    if (settled) return;
    aborted = true;
    terminate(130, "Command aborted by the user.");
  };

  timeoutTimer = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    terminate(124, `Command timed out after ${timeoutMs / 1000}s.`);
  }, timeoutMs);
  timeoutTimer.unref?.();

  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      onAbort();
      return promise;
    }
    options.abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    // Head-tail never drains: it must see every byte to know the true end.
    if (outputMode === "head") {
      if (stdoutOverflow) {
        child.stdout?.resume();
        return;
      }
      stdoutCollector.push(stdoutDecoder.write(chunk));
      if (stdoutCollector.size() > maxOutputChars * 2) {
        stdoutOverflow = true;
        child.stdout?.resume();
      }
      return;
    }
    stdoutCollector.push(stdoutDecoder.write(chunk));
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (outputMode === "head") {
      if (stderrOverflow) {
        child.stderr?.resume();
        return;
      }
      stderrCollector.push(stderrDecoder.write(chunk));
      if (stderrCollector.size() > maxOutputChars * 2) {
        stderrOverflow = true;
        child.stderr?.resume();
      }
      return;
    }
    stderrCollector.push(stderrDecoder.write(chunk));
  });

  child.on("error", (err) => settle(127, err.message));
  child.on("close", (code, signal) => {
    if (timedOut) {
      settle(124, `Command timed out after ${timeoutMs / 1000}s.`);
    } else if (aborted) {
      settle(130, "Command aborted by the user.");
    } else if (signal) {
      settle(128 + 15, `Command terminated by ${signal}.`);
    } else {
      settle(code ?? 1);
    }
  });

  return promise;
}

export function executeBashCommand(
  command: string,
  canonicalRoot: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
  abortSignal?: AbortSignal,
  maxOutputChars?: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runProcess("bash", ["-c", command], canonicalRoot, {
    timeoutMs,
    abortSignal,
    maxOutputChars,
    // Bash output is summarized head+tail so the model sees the trailing
    // summary/error; the find/grep probes stay head-only because their output
    // is parsed line-by-line.
    outputMode: "head-tail",
  }).then(({ stdout, stderr, code }) => ({ stdout, stderr, exitCode: code }));
}

export function createProjectHarnessTools(
  options: ProjectHarnessToolsOptions
): ProjectHarnessTools {
  const { canonicalRoot, trusted, timeoutMs = COMMAND_TIMEOUT_MS } = options;

  // Resolved lazily at execution time: the Projects route builds the tools
  // before `budgetTokens` exists (see ProjectHarnessToolsOptions).
  const resolveMaxOutputChars = (): number => {
    const requested =
      typeof options.maxOutputChars === "function"
        ? options.maxOutputChars()
        : options.maxOutputChars;
    if (requested === undefined) return MAX_OUTPUT_CHARS;
    // Large windows keep the static defaults; only a tighter cap applies.
    return Math.min(MAX_OUTPUT_CHARS, requested);
  };
  // File read/list cap. The static default is a byte count; the window-aware
  // cap is a character count. Only apply the window-aware value when the
  // caller actually supplied one, so the no-option path stays byte-identical
  // to the static default (a plain `Math.min` against the bash cap would
  // silently lower the file cap from 50 KB to 30 000).
  const resolveMaxOutputBytes = (): number => {
    const requested =
      typeof options.maxOutputChars === "function"
        ? options.maxOutputChars()
        : options.maxOutputChars;
    if (requested === undefined) return MAX_OUTPUT_BYTES;
    return Math.min(MAX_OUTPUT_BYTES, requested);
  };

  const bashTool = tool({
    description:
      "Run a bash or shell command inside the project workspace directory. Commands run in the canonical project root with safe environment settings. Blocked: sudo, device writes, recursive delete of /, piping remote scripts to shell. Execution requires approved project directory trust. Very long output is summarized as head+tail (the middle is replaced by a marker), so the beginning and the trailing summary or error are always visible.",
    inputSchema: z.object({
      command: z
        .string()
        .max(4000)
        .optional()
        .describe("The bash command to execute"),
      cmd: z
        .string()
        .max(4000)
        .optional()
        .describe("Alternative argument for the command to execute"),
    }),
    needsApproval: bashToolNeedsApproval,
    execute: async ({ command, cmd }, options) => {
      const abortSignal = options?.abortSignal;
      const rawCmd = (command ?? cmd ?? "").trim();
      if (!rawCmd) {
        return {
          stdout: "",
          stderr: "No command provided",
          exitCode: 1,
        };
      }

      if (!trusted) {
        return {
          stdout: "",
          stderr:
            "Directory trust required to execute shell commands. Please approve directory trust in the project view before running terminal commands.",
          exitCode: 126,
        };
      }

      try {
        assertSafeCommand(rawCmd);
      } catch (err) {
        return {
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 126,
        };
      }

      return executeBashCommand(
        rawCmd,
        canonicalRoot,
        timeoutMs,
        abortSignal,
        resolveMaxOutputChars()
      );
    },
  });

  const fileOpsTool = tool({
    description:
      "High-performance filesystem operations tool scoped strictly to the project workspace directory. Provides actions: 'list', 'find', 'grep', 'read', 'write', and 'edit'. Enforces workspace containment and Pre-Trust permission matrix (modifications require directory trust).",
    inputSchema: fileOperationsInputSchema,
    needsApproval: fileOperationsNeedsApproval,
    execute: (input) =>
      executeFileOperations(input, {
        canonicalRoot,
        trusted,
        maxOutputBytes: resolveMaxOutputBytes(),
        // Project harness permits larger writes than the chat tool (Spec §4.2).
        maxWriteBytes: MAX_WRITE_BYTES,
      }),
  });

  return {
    bash: bashTool as unknown as ProjectHarnessTools["bash"],
    file_operations: fileOpsTool as unknown as ProjectHarnessTools["file_operations"],
    manage_tasks: task_list_manager,
    create_artifact: artifact_publish,
    web_search,
    web_fetch,
  };
}
