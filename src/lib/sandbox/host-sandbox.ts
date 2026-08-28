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
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        HOME: SANDBOX_ROOT,
        USER: "sandbox",
        SHELL: "/bin/bash",
        LANG: process.env.LANG || "en_US.UTF-8",
        TERM: "dumb",
      };

      return new Promise<CommandResult>((resolve) => {
        const child = spawn("bash", ["-c", command], {
          cwd: SANDBOX_ROOT,
          env: safeEnv,
          timeout: COMMAND_TIMEOUT_MS,
        });

        let stdout = "";
        let stderr = "";
        let stdoutOverflow = false;
        let stderrOverflow = false;
        let settled = false;

        const settle = (exitCode: number, extra?: string) => {
          if (settled) return;
          settled = true;
          resolve({
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(
              extra ? `${stderr}${stderr ? "\n" : ""}${extra}` : stderr
            ),
            exitCode,
          });
        };

        child.stdout.on("data", (chunk: Buffer) => {
          if (stdoutOverflow) return;
          stdout += chunk.toString();
          if (stdout.length > MAX_OUTPUT_CHARS * 2) stdoutOverflow = true;
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderrOverflow) return;
          stderr += chunk.toString();
          if (stderr.length > MAX_OUTPUT_CHARS * 2) stderrOverflow = true;
        });

        child.on("error", (err) => settle(127, String(err.message)));
        child.on("close", (code, signal) => {
          if (signal === "SIGTERM") {
            settle(124, `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.`);
          } else {
            settle(code ?? 1);
          }
        });
      });
    },

    async readFile(filePath: string): Promise<string> {
      const resolved = resolveInsideSandbox(filePath);
      return fs.readFile(resolved, "utf8");
    },

    async writeFiles(
      files: Array<{ path: string; content: string | Buffer }>
    ): Promise<void> {
      if (files.length > MAX_FILES_PER_CALL) {
        throw new Error(`Too many files in one call (max ${MAX_FILES_PER_CALL}).`);
      }
      for (const file of files) {
        const resolved = resolveInsideSandbox(file.path);
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
export function createSandboxTools() {
  const sandbox = createHostSandbox();

  return {
    bash: tool({
      description:
        "Run a bash command inside the persistent sandbox workspace (data/sandbox). The working directory is the sandbox root and files created there persist between turns. Use for computations, running or testing code, data processing, and quick experiments. 30 second timeout; blocked: sudo, device writes, recursive deletes of /, piping remote scripts into a shell.",
      inputSchema: z.object({
        command: z
          .string()
          .min(1)
          .max(4000)
          .describe("The bash command to execute"),
      }),
      execute: async ({ command }) => {
        try {
          return await sandbox.executeCommand(command);
        } catch (err) {
          return {
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            exitCode: 126,
          };
        }
      },
    }),

    readFile: tool({
      description:
        "Read a text file from the sandbox workspace (data/sandbox). Path is relative to the sandbox root; paths escaping it are rejected.",
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
        "Write (create or overwrite) a text file inside the sandbox workspace (data/sandbox). Path is relative to the sandbox root; parent directories are created automatically.",
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
