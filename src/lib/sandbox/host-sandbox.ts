import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";

/**
 * Host-directory sandbox for the bash/readFile/writeFile agent tools.
 *
 * The agent gets a real, persistent workspace under `data/sandbox/`
 * (relative to the server's cwd). Commands always start with that
 * directory as cwd; file tools resolve paths against it and reject
 * anything that escapes it.
 *
 * Honest scope: this is a *guardrail*, not a security boundary — a
 * determined command can still touch the wider host. It exists so the
 * model's ordinary file/command work stays tidy and reversible in one
 * place, on a single-user local deployment. Catastrophic patterns are
 * blocked as speed bumps.
 */

import { env } from "@/env";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface Sandbox {
  executeCommand(command: string): Promise<CommandResult>;
  readFile(path: string): Promise<string>;
  writeFiles(files: Array<{ path: string; content: string | Buffer }>): Promise<void>;
}

export const SANDBOX_ROOT = path.resolve(process.cwd(), "data/sandbox");

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_WRITE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_CALL = 50;

/** Speed bumps for commands that are almost certainly accidents. */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b/, reason: "privilege escalation is not allowed" },
  { pattern: /\brm\b(?:(?!\n).)*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:(?!\n).)*\s\/(?!\w)/, reason: "recursive delete of / is blocked" },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: "filesystem formatting is blocked" },
  { pattern: /\bdd\b[^|;&\n]*\bof=\/dev\//, reason: "raw device writes are blocked" },
  { pattern: />\s*\/dev\/(sd|nvme|hd)/, reason: "raw device writes are blocked" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "power commands are blocked" },
  { pattern: /\bchmod\s+-R\s+777\s+\/(?!\w)/, reason: "recursive world-writable / is blocked" },
  { pattern: /(curl|wget)\b[^|;&\n]*\|\s*(ba|z)?sh\b/, reason: "piping remote scripts into a shell is blocked" },
];

export function assertSafeCommand(command: string): void {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(`Blocked command: ${reason}.`);
    }
  }
}

function resolveInsideSandbox(relativePath: string): string {
  const cleaned = (relativePath ?? "").replace(/^\/+/, "");
  const resolved = path.resolve(SANDBOX_ROOT, cleaned);
  if (resolved !== SANDBOX_ROOT && !resolved.startsWith(SANDBOX_ROOT + path.sep)) {
    throw new Error(`Path escapes the sandbox: ${relativePath}`);
  }
  return resolved;
}

/**
 * Resolve a path and prove the *real* target is inside the sandbox.
 *
 * The lexical check in resolveInsideSandbox is necessary but not sufficient: a
 * symlink planted inside the sandbox (`ln -s /etc link`) resolves lexically to
 * a path under SANDBOX_ROOT while the OS follows it outside. `realpath`
 * collapses links, so the containment check runs against the file the OS will
 * actually touch.
 *
 * When the target does not exist yet (a write), walk up to the nearest existing
 * ancestor, canonicalize that, and re-append the tail. That still catches the
 * escape, because the ancestor's realpath is outside the sandbox whenever any
 * traversed link points out.
 */
async function resolveRealInsideSandbox(relativePath: string): Promise<string> {
  const resolved = resolveInsideSandbox(relativePath);
  const canonicalRoot = await fs.realpath(SANDBOX_ROOT);

  // Walk up until we find a path that exists (bounded: stops at the root).
  let existing = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      await fs.lstat(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }

  const canonical = path.resolve(await fs.realpath(existing), ...tail);
  if (canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + path.sep)) {
    throw new Error(
      `Path escapes the sandbox via a symlink: ${relativePath} resolves outside the sandbox.`
    );
  }
  return canonical;
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[output truncated at ${MAX_OUTPUT_CHARS} chars]`;
}

export function createHostSandbox(): Sandbox {
  return {
    async executeCommand(command: string): Promise<CommandResult> {
      assertSafeCommand(command);
      await fs.mkdir(SANDBOX_ROOT, { recursive: true });

      // Safe child process environment (System Isolation - Rule 06)
      const safeEnv: NodeJS.ProcessEnv = {
        PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin",
        HOME: SANDBOX_ROOT,
        USER: "sandbox",
        SHELL: "/bin/bash",
        LANG: env.LANG || "en_US.UTF-8",
        TERM: "dumb",
        NODE_ENV: env.NODE_ENV || "development",
      };

      return new Promise<CommandResult>((resolve) => {
        // No spawn `timeout` option: it SIGTERMs only the direct child and
        // flips child.killed, which previously raced the custom timer below
        // into an early bail. Timeout handling is fully owned here, with
        // process-group SIGTERM → SIGKILL escalation that survives a command
        // that traps/ignores SIGTERM.
        const child = spawn("bash", ["-c", command], {
          cwd: SANDBOX_ROOT,
          env: safeEnv,
          detached: true,
        });

        let stdout = "";
        let stderr = "";
        let stdoutOverflow = false;
        let stderrOverflow = false;
        let settled = false;
        let timedOut = false;
        let timeoutTimer: NodeJS.Timeout | null = null;
        let forceKillTimer: NodeJS.Timeout | null = null;

        const cleanupTimers = () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
        };

        const killGroup = (signal: "SIGTERM" | "SIGKILL") => {
          const pid = child.pid;
          if (!pid) return;
          try {
            process.kill(-pid, signal);
          } catch (err) {
            console.debug("[host-sandbox] Process group kill failed, falling back to child.kill:", err);
            try {
              child.kill(signal);
            } catch (err2) {
              // Process group and child both already gone — expected during
              // teardown; log at debug level for diagnostics without noise.
              console.debug("[host-sandbox] Process already exited during kill:", err2);
            }
          }
        };

        const settle = (exitCode: number, extra?: string) => {
          if (settled) return;
          settled = true;
          cleanupTimers();
          resolve({
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(
              extra ? `${stderr}${stderr ? "\n" : ""}${extra}` : stderr
            ),
            exitCode,
          });
        };

        timeoutTimer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          killGroup("SIGTERM");
          // Escalation must NOT be cleared by settle(): settle now (the
          // tool result is final at the 30s mark) while the group kill runs
          // on its own timer to reap TERM-ignoring stragglers.
          settle(124, `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.`);
          forceKillTimer = setTimeout(() => killGroup("SIGKILL"), 2000);
        }, COMMAND_TIMEOUT_MS);

        child.stdout.on("data", (chunk: Buffer) => {
          if (stdoutOverflow) {
            child.stdout.resume();
            return;
          }
          stdout += chunk.toString();
          if (stdout.length > MAX_OUTPUT_CHARS * 2) {
            stdoutOverflow = true;
            child.stdout.resume();
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderrOverflow) {
            child.stderr.resume();
            return;
          }
          stderr += chunk.toString();
          if (stderr.length > MAX_OUTPUT_CHARS * 2) {
            stderrOverflow = true;
            child.stderr.resume();
          }
        });

        child.on("error", (err) => settle(127, String(err.message)));
        child.on("close", (code, signal) => {
          // If the group died because of our timeout signal, keep the
          // tool's timeout exit code even when close reports a different
          // signal (e.g. SIGKILL from the escalation timer).
          if (timedOut) {
            settle(124, `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.`);
          } else if (signal) {
            settle(128 + 15, `Command terminated by ${signal}.`);
          } else {
            settle(code ?? 1);
          }
        });
      });
    },

    async readFile(filePath: string): Promise<string> {
      await fs.mkdir(SANDBOX_ROOT, { recursive: true });
      const resolved = await resolveRealInsideSandbox(filePath);
      return fs.readFile(resolved, "utf8");
    },

    async writeFiles(
      files: Array<{ path: string; content: string | Buffer }>
    ): Promise<void> {
      if (files.length > MAX_FILES_PER_CALL) {
        throw new Error(`Too many files in one call (max ${MAX_FILES_PER_CALL}).`);
      }
      await fs.mkdir(SANDBOX_ROOT, { recursive: true });
      for (const file of files) {
        const resolved = await resolveRealInsideSandbox(file.path);
        const data =
          typeof file.content === "string"
            ? Buffer.from(file.content, "utf8")
            : file.content;
        if (data.byteLength > MAX_WRITE_FILE_BYTES) {
          throw new Error(
            `File too large: ${file.path} (max ${MAX_WRITE_FILE_BYTES} bytes).`
          );
        }
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, data);
      }
    },
  };
}

/**
 * Builds the sandbox tool set (bash, readFile, writeFile) as plain AI SDK
 * tools backed by the host sandbox. Errors are returned as tool output (not
 * thrown) so the model can see them and recover. Construction is
 * synchronous and cannot fail, so chats never degrade here.
 */
export function createBashTool(sandbox: Sandbox) {
  return tool({
    description:
      "Run a bash or shell command inside the persistent sandbox workspace (data/sandbox) — a scratch directory, NOT the project source tree. The working directory is the sandbox root and files created there persist between turns. Use for computations, running or testing code, data processing, and quick experiments. 30 second timeout; blocked: sudo, device writes, recursive deletes of /, piping remote scripts into a shell.",
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
    execute: async ({ command, cmd }) => {
      const rawCmd = (command ?? cmd ?? "").trim();
      if (!rawCmd) {
        return {
          stdout: "",
          stderr: "No command provided",
          exitCode: 1,
        };
      }
      try {
        return await sandbox.executeCommand(rawCmd);
      } catch (err) {
        return {
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 126,
        };
      }
    },
  });
}

export function createSandboxTools() {
  const sandbox = createHostSandbox();
  const bashTool = createBashTool(sandbox);

  return {
    bash: bashTool,
    shell: bashTool,
    exec: bashTool,

    readFile: tool({
      description:
        "Read a text file from the sandbox scratch workspace (data/sandbox), not the project source tree — use file_operations for project files. Path is relative to the sandbox root; paths escaping it (including via symlinks) are rejected.",
      inputSchema: z.object({
        path: z.string().min(1).max(500).describe("File path relative to the sandbox root"),
      }),
      execute: async ({ path: filePath }) => {
        try {
          const content = await sandbox.readFile(filePath);
          return {
            path: filePath,
            content:
              content.length > MAX_OUTPUT_CHARS
                ? `${content.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]`
                : content,
            truncated: content.length > MAX_OUTPUT_CHARS,
          };
        } catch (err) {
          return {
            path: filePath,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),

    writeFile: tool({
      description:
        "Write (create or overwrite) a text file inside the sandbox scratch workspace (data/sandbox), not the project source tree — use file_operations to change project files. Path is relative to the sandbox root; parent directories are created automatically.",
      inputSchema: z.object({
        path: z.string().min(1).max(500).describe("File path relative to the sandbox root"),
        content: z.string().describe("Full file content"),
      }),
      execute: async ({ path: filePath, content }) => {
        try {
          await sandbox.writeFiles([{ path: filePath, content }]);
          return { path: filePath, bytesWritten: Buffer.byteLength(content, "utf8") };
        } catch (err) {
          return {
            path: filePath,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),
  };
}
