import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { assertSafeCommand } from "@/lib/sandbox/host-sandbox";
import {
  assertSafePath,
  isSensitivePath,
  isDefaultIgnoredPath,
  filterSafePaths,
} from "@/lib/ai/tools/file-security";

/**
 * Durable step implementations for the Projects harness tools.
 *
 * These live in the step bundle (full Node.js access), so they may use
 * `node:fs`/`node:child_process` directly. They are intentionally self-contained:
 * the module must NOT import `project-harness-tools.ts`, because that module
 * transitively pulls `web`/`task`/`artifact` (→ `ssrf`/`db`/`log-store`), which
 * the Workflow runtime forbids in the workflow-function bundle. The fallback route
 * keeps the richer, formatting-identical implementations in that module; the
 * durable path uses these functionally-equivalent versions.
 *
 * Each step receives configuration via the per-tool `toolsContext` entry
 * (`{ canonicalRoot, trusted, ... }`), never from a closure, because a step
 * receives parameters, not the workflow's live scope (spec §3.4). Mutating steps
 * are wired with `maxRetries: 0` by the workflow so a half-applied change is
 * reported rather than silently re-run (spec §3.6.4).
 */

const MAX_MATCHES = 50;
const MAX_LINES = 1000;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;

async function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  maxOutputChars?: number
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, HISTFILE: "/dev/null" } });
    let stdout = "";
    let stderr = "";
    const cap = maxOutputChars ?? 30_000;
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > cap * 2) stdout = stdout.slice(0, cap);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > cap * 2) stderr = stderr.slice(0, cap);
    });
    child.on("error", (err) => resolve({ stdout, stderr: err.message, code: 127 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

async function resolveProjectSafePath(
  targetPath: string,
  canonicalRoot: string
): Promise<string> {
  const safe = path.resolve(canonicalRoot, targetPath);
  assertSafePath(safe, canonicalRoot);
  return safe;
}

/**
 * Durable bash step. Runs the command via `bash -c` in the canonical root.
 */
export async function projectBashStep(
  input: { command?: string; cmd?: string },
  options: {
    context?: { canonicalRoot: string; trusted: boolean; timeoutMs?: number; maxOutputChars?: number };
    abortSignal?: AbortSignal;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  "use step";
  const ctx = options.context ?? {
    canonicalRoot: "",
    trusted: false,
    timeoutMs: 60_000,
    maxOutputChars: 30_000,
  };
  const rawCmd = (input.command ?? input.cmd ?? "").trim();
  if (!rawCmd) return { stdout: "", stderr: "No command provided", exitCode: 1 };
  if (!ctx.trusted) {
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
    return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 126 };
  }
  const result = await runProcess("bash", ["-lc", rawCmd], ctx.canonicalRoot, ctx.maxOutputChars);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
}

/**
 * Durable file_operations step. Covers list/find/grep/read/write/edit.
 */
export async function projectFileOpsStep(
  input: {
    action: string;
    path?: string;
    depth?: number;
    showHidden?: boolean;
    pattern?: string;
    query?: string;
    caseSensitive?: boolean;
    offset?: number;
    limit?: number;
    content?: string;
    overwrite?: boolean;
    oldString?: string;
    newString?: string;
  },
  options: {
    context?: { canonicalRoot: string; trusted: boolean; maxOutputChars?: number; maxOutputBytes?: number };
  }
): Promise<Record<string, unknown>> {
  "use step";
  const ctx = options.context ?? {
    canonicalRoot: "",
    trusted: false,
    maxOutputChars: 30_000,
    maxOutputBytes: 50 * 1024,
  };

  try {
    if (!ctx.trusted && (input.action === "write" || input.action === "edit")) {
      return {
        error:
          "Directory trust required to modify files. Please approve directory trust in the project view before modifying files.",
      };
    }

    if (input.action === "list") {
      const safePath = await resolveProjectSafePath(input.path ?? ".", ctx.canonicalRoot);
      const entries = await fs.readdir(safePath, { withFileTypes: true });
      const lines = entries
        .filter((e) => !(input.showHidden ?? false) || !e.name.startsWith("."))
        .filter((e) => !isDefaultIgnoredPath(e.name) && !isSensitivePath(e.name))
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name));
      return { path: input.path ?? ".", listing: lines.join("\n"), truncated: false };
    }

    if (input.action === "read") {
      const safePath = await resolveProjectSafePath(input.path!, ctx.canonicalRoot);
      const raw = await fs.readFile(safePath, "utf8");
      const lines = raw.split("\n");
      const start = Math.max(1, input.offset ?? 1);
      const limit = input.limit ?? MAX_LINES;
      const selected = lines.slice(start - 1, start - 1 + limit);
      return {
        path: input.path,
        linesCount: lines.length,
        content: selected.join("\n"),
        truncated: lines.length > start - 1 + limit,
      };
    }

    if (input.action === "write") {
      const safePath = await resolveProjectSafePath(input.path!, ctx.canonicalRoot);
      const byteLength = Buffer.byteLength(input.content ?? "", "utf8");
      if (byteLength > MAX_WRITE_BYTES) {
        return { error: `File content exceeds the ${MAX_WRITE_BYTES} byte write limit (${byteLength} bytes)` };
      }
      if (!input.overwrite) {
        const exists = await fs.stat(safePath).then((s) => s.isFile()).catch(() => false);
        if (exists) {
          return {
            error: `${input.path} already exists. Use action "edit" with oldString/newString, or pass overwrite: true.`,
          };
        }
      }
      await fs.mkdir(path.dirname(safePath), { recursive: true });
      await fs.writeFile(safePath, input.content ?? "", "utf8");
      return { status: "success", path: input.path, bytesWritten: byteLength };
    }

    if (input.action === "edit") {
      const safePath = await resolveProjectSafePath(input.path!, ctx.canonicalRoot);
      const content = await fs.readFile(safePath, "utf8");
      const occurrences = content.split(input.oldString!).length - 1;
      if (occurrences === 0) return { error: `Target oldString was not found in ${input.path}` };
      if (occurrences > 1) return { error: `Target oldString matched ${occurrences} times. Must be unique.` };
      const updated = content.replace(input.oldString!, input.newString!);
      await fs.writeFile(safePath, updated, "utf8");
      return { status: "success", path: input.path, replaced: true };
    }

    if (input.action === "find" || input.action === "grep") {
      const safePath = await resolveProjectSafePath(input.path ?? ".", ctx.canonicalRoot);
      const tool = input.action === "find" ? "find" : "grep";
      const args =
        input.action === "find"
          ? [safePath, "-name", `*${input.pattern}*`]
          : ["-rnI", "--exclude-dir=node_modules", "--exclude-dir=.git", "--", input.query!, safePath];
      const res = await runProcess(tool, args, ctx.canonicalRoot);
      const rawLines = res.stdout.trim().split("\n").filter(Boolean);
      const safeLines = rawLines.filter(
        (l) => !isSensitivePath(l.split(":")[0]) && !isDefaultIgnoredPath(l.split(":")[0])
      );
      return { matches: safeLines.slice(0, MAX_MATCHES) };
    }

    return { error: "Unknown action" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
