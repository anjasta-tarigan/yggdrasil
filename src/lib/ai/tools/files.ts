// src/lib/ai/tools/files.ts
import { tool } from "ai";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertSafePath, isSensitivePath, isDefaultIgnoredPath, filterSafePaths } from "./file-security";
import { probeCliCapabilities } from "./file-capabilities";

const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB
const MAX_LINES = 1000;
const MAX_WRITE_BYTES = 2 * 1024 * 1024; // 2MB

function runProcess(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => { stdout += c.toString(); });
    child.stderr?.on("data", (c) => { stderr += c.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
  });
}

export const file_operations = tool({
  description:
    "High-performance filesystem operations tool. Provides actions: 'list' (directory tree), 'find' (fast file search), 'grep' (text search), 'jump' (directory jumping with zoxide), 'read' (view file with line numbers), 'write' (create/overwrite file with backup), and 'edit' (exact surgical find-and-replace). Enforces workspace containment, protects sensitive files, and uses modern CLI tools (eza, fd, rg) with automatic fallbacks.",
  inputSchema: z.discriminatedUnion("action", [
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
      action: z.literal("jump"),
      query: z.string().describe("Directory keyword to resolve via zoxide"),
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
  ]),
  execute: async (input) => {
    try {
      const caps = await probeCliCapabilities();

      if (input.action === "list") {
        const targetPath = input.path ?? ".";
        const depth = input.depth ?? 2;
        const showHidden = input.showHidden ?? false;
        const safePath = await assertSafePath(targetPath);
        if (caps.hasEza) {
          const args = ["--tree", `--level=${depth}`, "--color=never", "--ignore-glob", "node_modules|.git|.next|dist"];
          if (showHidden) args.push("-a");
          args.push(safePath);
          const res = await runProcess("eza", args);
          return { path: targetPath, listing: res.stdout || res.stderr };
        }
        // Fallback: Node.js recursive read
        const formatTree = async (dir: string, currentDepth: number): Promise<string[]> => {
          if (currentDepth > depth) return [];
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const lines: string[] = [];
          for (const e of entries) {
            if (!showHidden && e.name.startsWith(".")) continue;
            if (isDefaultIgnoredPath(e.name) || isSensitivePath(e.name)) continue;
            const indent = "  ".repeat(currentDepth - 1);
            lines.push(`${indent}${e.isDirectory() ? e.name + "/" : e.name}`);
            if (e.isDirectory()) {
              lines.push(...(await formatTree(path.join(dir, e.name), currentDepth + 1)));
            }
          }
          return lines;
        };
        const lines = await formatTree(safePath, 1);
        return { path: targetPath, listing: lines.join("\n") };
      }

      if (input.action === "find") {
        const targetPath = input.path ?? ".";
        const safePath = await assertSafePath(targetPath);
        if (caps.hasFd) {
          const res = await runProcess("fd", [
            "--color=never",
            "--max-results", "50",
            "--exclude", "node_modules",
            "--exclude", ".git",
            "--exclude", ".next",
            "--exclude", ".env*",
            "--exclude", "*.pem",
            "--exclude", "*.key",
            input.pattern,
            safePath,
          ]);
          return { matches: res.stdout.trim().split("\n").filter(Boolean) };
        }
        // Fallback: find
        const res = await runProcess("find", [safePath, "-name", `*${input.pattern}*`]);
        const allMatches = res.stdout.trim().split("\n").filter(Boolean);
        const filtered = await filterSafePaths(allMatches);
        return { matches: filtered.slice(0, 50) };
      }

      if (input.action === "grep") {
        const targetPath = input.path ?? ".";
        const safePath = await assertSafePath(targetPath);
        if (caps.hasRipgrep) {
          const args = [
            "--no-heading",
            "--line-number",
            "--color=never",
            "--max-count", "50",
            "--glob", "!node_modules",
            "--glob", "!.git",
            "--glob", "!.next",
            "--glob", "!.env*",
            "--glob", "!*.pem",
            "--glob", "!*.key",
            "--glob", "!id_*",
          ];
          if (!input.caseSensitive) args.push("-i");
          args.push(input.query, safePath);
          const res = await runProcess("rg", args);
          return { matches: res.stdout.trim().split("\n").filter(Boolean).slice(0, 50) };
        }
        // Fallback: grep
        const args = ["-rnI", "--max-count=50"];
        if (!input.caseSensitive) args.push("-i");
        args.push(input.query, safePath);
        const res = await runProcess("grep", args);
        const rawLines = res.stdout.trim().split("\n").filter(Boolean);
        const safeLines = rawLines.filter((l) => !isSensitivePath(l.split(":")[0]));
        return { matches: safeLines.slice(0, 50) };
      }

      if (input.action === "jump") {
        if (caps.hasZoxide) {
          const res = await runProcess("zoxide", ["query", input.query]);
          const resolved = res.stdout.trim();
          if (resolved) {
            try {
              const safe = await assertSafePath(resolved);
              return { resolvedPath: safe };
            } catch {
              return { error: `Resolved directory escapes workspace boundary: ${resolved}` };
            }
          }
        }
        return { error: `Directory matching query '${input.query}' not found via zoxide` };
      }

      if (input.action === "read") {
        const safePath = await assertSafePath(input.path);
        const stat = await fs.stat(safePath);

        // Binary sniff
        const handle = await fs.open(safePath, "r");
        const buf = Buffer.alloc(512);
        const { bytesRead } = await handle.read(buf, 0, 512, 0);
        await handle.close();

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

        return {
          path: input.path,
          linesCount: lines.length,
          content: formatted.slice(0, MAX_OUTPUT_BYTES),
          truncated: formatted.length > MAX_OUTPUT_BYTES || lines.length > start - 1 + limit,
        };
      }

      if (input.action === "write") {
        const safePath = await assertSafePath(input.path);

        // Snapshot existing file
        try {
          const exists = await fs.stat(safePath).catch(() => null);
          if (exists && exists.isFile()) {
            const bakPath = `${safePath}.bak.${Date.now()}`;
            await fs.copyFile(safePath, bakPath);
          }
        } catch {
          // Proceed with write
        }

        await fs.mkdir(path.dirname(safePath), { recursive: true });
        await fs.writeFile(safePath, input.content, "utf8");
        return {
          path: input.path,
          bytesWritten: Buffer.byteLength(input.content, "utf8"),
        };
      }

      if (input.action === "edit") {
        const safePath = await assertSafePath(input.path);
        const content = await fs.readFile(safePath, "utf8");

        const occurrences = content.split(input.oldString).length - 1;
        if (occurrences === 0) {
          return { error: `Target oldString was not found in ${input.path}` };
        }
        if (occurrences > 1) {
          return { error: `Target oldString matched ${occurrences} times. Must be unique.` };
        }

        const updated = content.replace(input.oldString, input.newString);
        await fs.writeFile(safePath, updated, "utf8");
        return { path: input.path, replaced: true };
      }

      return { error: "Unknown action" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
});
