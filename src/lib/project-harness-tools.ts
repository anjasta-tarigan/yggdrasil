// src/lib/project-harness-tools.ts
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { assertSafeCommand } from "@/lib/sandbox/host-sandbox";
import {
  assertSafePath,
  isSensitivePath,
  isDefaultIgnoredPath,
  filterSafePaths,
} from "@/lib/ai/tools/file-security";
import { probeCliCapabilities } from "@/lib/ai/tools/file-capabilities";
import { task_list_manager } from "@/lib/ai/tools/task";
import { artifact_publish } from "@/lib/ai/tools/artifact";
import { web_search, web_fetch } from "@/lib/ai/tools/web";

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
const MAX_LINES = 1000;
const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5MB per Spec §4.2

export interface FileOperationsResult {
  path?: string;
  error?: string;
  status?: string;
  listing?: string;
  matches?: string[];
  resolvedPath?: string;
  content?: string;
  linesCount?: number;
  truncated?: boolean;
  isBinary?: boolean;
  bytes?: number;
  bytesWritten?: number;
  replaced?: boolean;
}

const fileOperationsInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    path: z.string().optional().describe("Directory path to list"),
    depth: z.number().min(1).max(5).optional().describe("Traversal depth"),
    showHidden: z.boolean().optional().describe("Include dotfiles"),
  }),
  z.object({
    action: z.literal("find"),
    pattern: z.string().describe("Filename or pattern to find"),
    path: z.string().optional().describe("Search root directory"),
  }),
  z.object({
    action: z.literal("grep"),
    query: z.string().describe("Text or regex to search inside files"),
    path: z.string().optional().describe("Search root directory or file"),
    caseSensitive: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("read"),
    path: z.string().describe("File path to read"),
    offset: z.number().optional().describe("Starting line number (1-based)"),
    limit: z.number().optional().describe("Line count limit"),
  }),
  z.object({
    action: z.literal("write"),
    path: z.string().describe("File path to write"),
    content: z.string().max(MAX_WRITE_BYTES).describe("File contents"),
  }),
  z.object({
    action: z.literal("edit"),
    path: z.string().describe("File path to edit"),
    oldString: z.string().describe("Exact substring to replace (must be unique)"),
    newString: z.string().describe("New replacement string"),
  }),
]);

export type FileOperationsInput = z.infer<typeof fileOperationsInputSchema>;

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
 */
function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  const preserved = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
  return `${preserved}\n…[output truncated at ${maxChars} chars; narrow it with head/tail/grep or redirect to a file]`;
}

/**
 * Truncate file `read` content to `maxChars`, cutting at the last complete
 * line and appending the offset the model must pass to continue. `startLine`
 * is the 1-based line number of the first included line.
 *
 * When even the first line exceeds the cap, the partial first line is kept
 * and the offset still advances by one, so the model can never loop forever
 * on a single over-long line.
 */
function truncateReadContent(
  formatted: string,
  maxChars: number,
  startLine: number
): string {
  const slice = formatted.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  const atLineBoundary = lastNewline > 0;
  const preserved = atLineBoundary ? slice.slice(0, lastNewline) : slice;
  // Lines actually included; the next read resumes at the following line.
  const includedLines = preserved.split("\n").length;
  const nextLine = startLine + includedLines;
  return `${preserved}\n…[truncated at ${maxChars} chars; call read again with offset=${nextLine} (and a smaller limit) to continue]`;
}

/** Truncate a directory listing to `maxChars` with a narrowing hint. */
function truncateListing(listing: string, maxChars: number): string {
  return `${listing.slice(0, maxChars)}\n…[truncated at ${maxChars} chars; narrow the path or use find/grep to target entries]`;
}

export async function resolveProjectSafePath(
  inputPath: string,
  canonicalRoot: string
): Promise<string> {
  const lexical = path.resolve(canonicalRoot, inputPath);
  if (lexical !== canonicalRoot && !lexical.startsWith(canonicalRoot + path.sep)) {
    throw new Error(`Security Violation: Path escapes workspace root: ${inputPath}`);
  }
  return await assertSafePath(inputPath, canonicalRoot);
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
  } = {}
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? RUNTIME_PROCESS_TIMEOUT_MS;
  // Bash streams are capped at the static default unless a window-aware cap
  // is tighter; the overflow guard below keeps buffering bounded by 2x.
  const maxOutputChars = Math.min(
    MAX_OUTPUT_CHARS,
    options.maxOutputChars ?? MAX_OUTPUT_CHARS
  );
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

  let stdout = "";
  let stderr = "";
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

    stdout += stdoutDecoder.end();
    stderr += stderrDecoder.end();

    resolve({
      stdout: truncateOutput(stdout, maxOutputChars),
      stderr: truncateOutput(
        extra ? `${stderr}${stderr ? "\n" : ""}${extra}` : stderr,
        maxOutputChars
      ),
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
    if (stdoutOverflow) {
      child.stdout?.resume();
      return;
    }
    stdout += stdoutDecoder.write(chunk);
    if (stdout.length > maxOutputChars * 2) {
      stdoutOverflow = true;
      child.stdout?.resume();
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrOverflow) {
      child.stderr?.resume();
      return;
    }
    stderr += stderrDecoder.write(chunk);
    if (stderr.length > maxOutputChars * 2) {
      stderrOverflow = true;
      child.stderr?.resume();
    }
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

function executeBashCommand(
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
  // cap is a character count. ASCII is the common case, so compare directly
  // and let the byte-vs-char difference only ever make the effective cap
  // tighter (never looser) than intended.
  const resolveMaxOutputBytes = (): number =>
    Math.min(MAX_OUTPUT_BYTES, resolveMaxOutputChars());

  const bashTool = tool({
    description:
      "Run a bash or shell command inside the project workspace directory. Commands run in the canonical project root with safe environment settings. Blocked: sudo, device writes, recursive delete of /, piping remote scripts to shell. Execution requires approved project directory trust.",
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
    execute: async (input) => {
      try {
        if (!trusted && (input.action === "write" || input.action === "edit")) {
          return {
            error:
              "Directory trust required to modify files. Please approve directory trust in the project view before modifying files.",
          };
        }

        const caps = await probeCliCapabilities();

        if (input.action === "list") {
          const targetPath = input.path ?? ".";
          const depth = input.depth ?? 2;
          const showHidden = input.showHidden ?? false;
          const safePath = await resolveProjectSafePath(targetPath, canonicalRoot);

          if (caps.hasEza) {
            const args = [
              "--tree",
              `--level=${depth}`,
              "--color=never",
              "--ignore-glob",
              "node_modules|.git|.next|dist|build|.turbo|.cache",
            ];
            if (showHidden) args.push("-a");
            args.push(safePath);
            const res = await runProcess("eza", args, canonicalRoot);
            const listing = res.stdout || res.stderr;
            const cap = resolveMaxOutputBytes();
            return {
              path: targetPath,
              listing:
                listing.length > cap ? truncateListing(listing, cap) : listing,
              truncated: listing.length > cap,
            };
          }

          // Fallback: Node.js recursive read
          const formatTree = async (
            dir: string,
            currentDepth: number
          ): Promise<string[]> => {
            if (currentDepth > depth) return [];
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const lines: string[] = [];
            for (const e of entries) {
              if (!showHidden && e.name.startsWith(".")) continue;
              if (isDefaultIgnoredPath(e.name) || isSensitivePath(e.name)) continue;
              const indent = "  ".repeat(currentDepth - 1);
              lines.push(`${indent}${e.isDirectory() ? e.name + "/" : e.name}`);
              if (e.isDirectory()) {
                lines.push(
                  ...(await formatTree(path.join(dir, e.name), currentDepth + 1))
                );
              }
            }
            return lines;
          };

          const lines = await formatTree(safePath, 1);
          const listing = lines.join("\n");
          const cap = resolveMaxOutputBytes();
          return {
            path: targetPath,
            listing:
              listing.length > cap ? truncateListing(listing, cap) : listing,
            truncated: listing.length > cap,
          };
        }

        if (input.action === "find") {
          const targetPath = input.path ?? ".";
          const safePath = await resolveProjectSafePath(targetPath, canonicalRoot);

          if (caps.hasFd) {
            const res = await runProcess(
              "fd",
              [
                "--color=never",
                "--max-results",
                "50",
                "--exclude",
                "node_modules",
                "--exclude",
                ".git",
                "--exclude",
                ".next",
                "--exclude",
                "dist",
                "--exclude",
                "build",
                "--exclude",
                ".env*",
                "--exclude",
                "*.pem",
                "--exclude",
                "*.key",
                "--exclude",
                "id_*",
                "--",
                input.pattern,
                safePath,
              ],
              canonicalRoot
            );
            const raw = res.stdout.trim().split("\n").filter(Boolean);
            const filtered = raw.filter(
              (m) =>
                !isSensitivePath(m.split(":")[0]) && !isDefaultIgnoredPath(m)
            );
            return { matches: filtered.slice(0, 50) };
          }

          // Fallback: find
          const res = await runProcess(
            "find",
            [safePath, "-name", `*${input.pattern}*`],
            canonicalRoot
          );
          const allMatches = res.stdout.trim().split("\n").filter(Boolean);
          const filtered = await filterSafePaths(allMatches, canonicalRoot);
          return { matches: filtered.slice(0, 50) };
        }

        if (input.action === "grep") {
          const targetPath = input.path ?? ".";
          const safePath = await resolveProjectSafePath(targetPath, canonicalRoot);

          if (caps.hasRipgrep) {
            const args = [
              "--no-heading",
              "--line-number",
              "--color=never",
              "--max-count",
              "50",
              "--glob",
              "!node_modules",
              "--glob",
              "!.git",
              "--glob",
              "!.next",
              "--glob",
              "!dist",
              "--glob",
              "!build",
              "--glob",
              "!.env*",
              "--glob",
              "!*.pem",
              "--glob",
              "!*.key",
              "--glob",
              "!id_*",
              "--glob",
              "!.aws/**",
              "--glob",
              "!.ssh/**",
            ];
            if (!input.caseSensitive) args.push("-i");
            args.push("--", input.query, safePath);
            const res = await runProcess("rg", args, canonicalRoot);
            const rawLines = res.stdout.trim().split("\n").filter(Boolean);
            const safeLines = rawLines.filter(
              (l) =>
                !isSensitivePath(l.split(":")[0]) &&
                !isDefaultIgnoredPath(l.split(":")[0])
            );
            return { matches: safeLines.slice(0, 50) };
          }

          // Fallback: grep
          const args = [
            "-rnI",
            "--max-count=50",
            "--exclude-dir=node_modules",
            "--exclude-dir=.git",
            "--exclude-dir=.next",
            "--exclude-dir=dist",
            "--exclude-dir=build",
            "--exclude-dir=.turbo",
            "--exclude-dir=.cache",
          ];
          if (!input.caseSensitive) args.push("-i");
          args.push("--", input.query, safePath);
          const res = await runProcess("grep", args, canonicalRoot);
          const rawLines = res.stdout.trim().split("\n").filter(Boolean);
          const safeLines = rawLines.filter(
            (l) =>
              !isSensitivePath(l.split(":")[0]) &&
              !isDefaultIgnoredPath(l.split(":")[0])
          );
          return { matches: safeLines.slice(0, 50) };
        }

        if (input.action === "read") {
          const safePath = await resolveProjectSafePath(input.path, canonicalRoot);
          // Rule 17: open-then-stat avoids stat-then-open TOCTOU race.
          let handle: fs.FileHandle;
          try {
            handle = await fs.open(safePath, "r");
          } catch (openErr) {
            return {
              error: `Failed to read file: ${openErr instanceof Error ? openErr.message : String(openErr)}`,
            };
          }
          const stat = await handle.stat();
          let bytesRead = 0;
          const buf = Buffer.alloc(512);
          try {
            ({ bytesRead } = await handle.read(buf, 0, 512, 0));
          } finally {
            await handle.close().catch((err) =>
              console.debug("[project-harness-tools] Failed to close file handle:", err)
            );
          }

          for (let i = 0; i < bytesRead; i++) {
            if (buf[i] === 0x00) {
              return { path: input.path, isBinary: true, bytes: stat.size };
            }
          }

          const raw = await fs.readFile(safePath, "utf8");
          const lines = raw.split("\n");
          const start = Math.max(1, input.offset ?? 1);
          const limit = input.limit ?? MAX_LINES;
          const selected = lines.slice(start - 1, start - 1 + limit);

          const formatted = selected
            .map((l, i) => `${(start + i).toString().padStart(6)}\t${l}`)
            .join("\n");

          const cap = resolveMaxOutputBytes();
          const cappedByChars = formatted.length > cap;
          const truncated = cappedByChars || lines.length > start - 1 + limit;
          return {
            path: input.path,
            linesCount: lines.length,
            content: cappedByChars
              ? truncateReadContent(formatted, cap, start)
              : formatted,
            truncated,
          };
        }

        if (input.action === "write") {
          const safePath = await resolveProjectSafePath(input.path, canonicalRoot);

          // Spec §4.2: cap writes at 5MB. The zod `.max()` counts UTF-16 code
          // units, so a multibyte payload can slip past it — enforce bytes here.
          const byteLength = Buffer.byteLength(input.content, "utf8");
          if (byteLength > MAX_WRITE_BYTES) {
            return {
              error: `File content exceeds the ${MAX_WRITE_BYTES} byte write limit (${byteLength} bytes)`,
            };
          }

          await fs.mkdir(path.dirname(safePath), { recursive: true });
          await fs.writeFile(safePath, input.content, "utf8");
          return {
            status: "success",
            path: input.path,
            bytesWritten: byteLength,
          };
        }

        if (input.action === "edit") {
          const safePath = await resolveProjectSafePath(input.path, canonicalRoot);
          const content = await fs.readFile(safePath, "utf8");

          const occurrences = content.split(input.oldString).length - 1;
          if (occurrences === 0) {
            return { error: `Target oldString was not found in ${input.path}` };
          }
          if (occurrences > 1) {
            return {
              error: `Target oldString matched ${occurrences} times. Must be unique.`,
            };
          }

          const updated = content.replace(input.oldString, input.newString);
          await fs.writeFile(safePath, updated, "utf8");
          return {
            status: "success",
            path: input.path,
            replaced: true,
          };
        }

        return { error: "Unknown action" };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
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
