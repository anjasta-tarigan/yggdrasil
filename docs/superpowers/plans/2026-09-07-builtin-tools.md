# Advanced Built-in Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement three production-grade, secure built-in chat tools: `file_operations` (structured file browsing/finding/grepping/editing with `fs.realpath` symlink defenses, command injection prevention, and modern CLI discovery), `notify_user` (rate-limited multi-channel alerting with Web Audio chime and desktop notifications), and `host_info` (cached system diagnostic tool).

**Architecture:** Tools are implemented in `src/lib/ai/tools/` using the AI SDK v7 `tool({...})` pattern and registered in `builtinTools`. A dedicated `file-security.ts` module enforces canonical `fs.realpath` boundary containment, protects against symlink chains/dangling symlinks, and filters sensitive credentials across searches. A `file-capabilities.ts` module caches host CLI presence (`eza`, `fd`, `rg`, `zoxide`) with 5-minute TTL.

**Tech Stack:** TypeScript, Node.js (fs/promises, child_process.spawn, crypto, os), Zod, AI SDK v7, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-builtin-tools-design.md`

## Global Constraints

- Zero shell interpolation: Subprocesses must be spawned using explicit argument arrays (`shell: false`). No command string interpolation, no shell pipes.
- Canonical boundary security: All paths must be canonicalized with `fs.realpath` against the workspace root (`process.cwd()`). Escapes (direct, single symlink, chained symlinks, or dangling symlinks) must be rejected with an explicit error.
- Sensitive file protection: Access and search matching on `.env*`, `id_rsa*`, `*.pem`, `*.key`, `.aws/*`, `.git/config` is strictly blocked.
- Resource discipline: Search outputs capped at 50 results / 50KB. Max file write payload: 2MB. Rolling `.bak.<timestamp>` created on existing file overwrite.
- Rate limiting: `notify_user` capped at max 5 notifications per 60 seconds with 10s deduplication. `host_info` cached with 5-minute TTL.
- Zero concurrent vitest executions: Execute tests with `--maxWorkers=1`.

---

## File Structure

```
src/lib/ai/tools/
├── file-security.ts           # assertSafePath, isSensitivePath, path traversal & symlink defense
├── file-capabilities.ts       # probeCliCapabilities (eza, fd, rg, zoxide) with TTL cache
├── files.ts                   # file_operations tool definition (list, find, grep, jump, read, write, edit)
├── notify.ts                  # notify_user tool definition & rate limiter
├── system.ts                  # host_info tool definition
├── index.ts                   # Registry export (adds files, notify, system to builtinTools)
└── __tests__/
    ├── file-security.test.ts  # Symlink escape, dangling symlink, and sensitive file filter tests
    ├── file-capabilities.test.ts # Probing and TTL caching tests
    ├── files.test.ts          # file_operations actions & command injection tests
    ├── notify.test.ts         # notify_user schema, rate limiting & deduplication tests
    └── system.test.ts         # host_info schema and cached diagnostics tests
```

---

### Task 1: Canonical Physical File Security Module (`file-security.ts`)

**Files:**
- Create: `src/lib/ai/tools/file-security.ts`
- Test: `src/lib/ai/tools/__tests__/file-security.test.ts`

**Interfaces:**
- Produces:
  - `assertSafePath(inputPath: string, workspaceRoot?: string): Promise<string>`
  - `isSensitivePath(targetPath: string): boolean`
  - `isDefaultIgnoredPath(targetPath: string): boolean`
  - `filterSafePaths(paths: string[], workspaceRoot?: string): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/ai/tools/__tests__/file-security.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { assertSafePath, isSensitivePath, isDefaultIgnoredPath } from "../file-security";

describe("File Security & Boundary Verification", () => {
  let tmpRoot: string;
  let workspaceRoot: string;
  let outsideDir: string;

  beforeEach(async () => {
    tmpRoot = path.join(os.tmpdir(), "ygg-security-test-" + crypto.randomUUID());
    workspaceRoot = path.join(tmpRoot, "workspace");
    outsideDir = path.join(tmpRoot, "outside");

    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("allows paths inside the workspace", async () => {
    const filePath = path.join(workspaceRoot, "valid.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const resolved = await assertSafePath("valid.txt", workspaceRoot);
    expect(resolved).toBe(await fs.realpath(filePath));
  });

  it("rejects direct directory traversal (../../)", async () => {
    await expect(assertSafePath("../../outside.txt", workspaceRoot)).rejects.toThrow(
      /Security Violation: Path escapes workspace root/
    );
  });

  it("rejects single-hop symlink escapes pointing outside workspace", async () => {
    const outsideTarget = path.join(outsideDir, "secret.txt");
    await fs.writeFile(outsideTarget, "secret data", "utf8");

    const symlinkPath = path.join(workspaceRoot, "symlink-out");
    await fs.symlink(outsideTarget, symlinkPath);

    await expect(assertSafePath("symlink-out", workspaceRoot)).rejects.toThrow(
      /Security Violation: Path escapes workspace root/
    );
  });

  it("rejects multi-hop chained symlink escapes", async () => {
    const outsideTarget = path.join(outsideDir, "deep-secret.txt");
    await fs.writeFile(outsideTarget, "deep secret", "utf8");

    const intermediateLink = path.join(workspaceRoot, "link-1");
    const secondLink = path.join(workspaceRoot, "link-2");

    await fs.symlink(outsideTarget, intermediateLink);
    await fs.symlink(intermediateLink, secondLink);

    await expect(assertSafePath("link-2", workspaceRoot)).rejects.toThrow(
      /Security Violation: Path escapes workspace root/
    );
  });

  it("detects and rejects dangling symlinks pointing outside workspace for not-yet-created files", async () => {
    const danglingOutsideTarget = path.join(outsideDir, "future-file.txt");
    const symlinkPath = path.join(workspaceRoot, "dangling-link");
    await fs.symlink(danglingOutsideTarget, symlinkPath);

    await expect(assertSafePath("dangling-link", workspaceRoot)).rejects.toThrow(
      /Security Violation: Path escapes workspace root/
    );
  });

  it("identifies sensitive credential files correctly", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath(".env.local")).toBe(true);
    expect(isSensitivePath(".env.production")).toBe(true);
    expect(isSensitivePath("id_rsa")).toBe(true);
    expect(isSensitivePath("id_ed25519")).toBe(true);
    expect(isSensitivePath("cert.pem")).toBe(true);
    expect(isSensitivePath("private.key")).toBe(true);
    expect(isSensitivePath(".aws/credentials")).toBe(true);
    expect(isSensitivePath(".git/config")).toBe(true);
    expect(isSensitivePath(".npmrc")).toBe(true);
    expect(isSensitivePath("normal-code.ts")).toBe(false);
  });

  it("identifies default ignored build folders", () => {
    expect(isDefaultIgnoredPath("node_modules")).toBe(true);
    expect(isDefaultIgnoredPath(".git")).toBe(true);
    expect(isDefaultIgnoredPath(".next")).toBe(true);
    expect(isDefaultIgnoredPath("src/index.ts")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/tools/__tests__/file-security.test.ts --maxWorkers=1`  
Expected: FAIL with module not found for `../file-security`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/ai/tools/file-security.ts
import path from "node:path";
import fs from "node:fs/promises";

const SENSITIVE_BASENAME_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|crt)$/i,
  /^\.(npmrc|pypirc|netrc)$/i,
];

const SENSITIVE_PATH_PATTERNS = [
  /(^|[/\\])\.aws([/\\]|$)/i,
  /(^|[/\\])\.ssh([/\\]|$)/i,
  /(^|[/\\])\.docker[/\\]config\.json$/i,
  /(^|[/\\])\.git[/\\]config$/i,
  /\/etc\/(shadow|passwd)$/i,
];

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
]);

export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = path.basename(normalized);

  if (SENSITIVE_BASENAME_PATTERNS.some((p) => p.test(basename))) {
    return true;
  }
  if (SENSITIVE_PATH_PATTERNS.some((p) => p.test(normalized))) {
    return true;
  }
  return false;
}

export function isDefaultIgnoredPath(filePath: string): boolean {
  const segments = filePath.replace(/\\/g, "/").split("/");
  return segments.some((segment) => IGNORED_DIRECTORIES.has(segment));
}

export async function assertSafePath(
  inputPath: string,
  customWorkspaceRoot?: string
): Promise<string> {
  const root = customWorkspaceRoot
    ? path.resolve(customWorkspaceRoot)
    : process.cwd();
  const canonicalRoot = await fs.realpath(root);

  const target = path.resolve(root, inputPath);

  // Check if target or any link in target exists
  let canonicalTarget: string;
  try {
    canonicalTarget = await fs.realpath(target);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Check if target is a dangling symlink
      try {
        const lstat = await fs.lstat(target);
        if (lstat.isSymbolicLink()) {
          // It's a dangling symlink, resolve readlink
          const linkDest = await fs.readlink(target);
          const resolvedLink = path.resolve(path.dirname(target), linkDest);
          if (!resolvedLink.startsWith(canonicalRoot + path.sep) && resolvedLink !== canonicalRoot) {
            throw new Error(`Security Violation: Path escapes workspace root: ${inputPath}`);
          }
        }
      } catch (lstatErr: unknown) {
        if ((lstatErr as NodeJS.ErrnoException).code !== "ENOENT") throw lstatErr;
      }

      // Non-existent target file: resolve closest existing parent ancestor
      let currentDir = path.dirname(target);
      while (currentDir !== path.dirname(currentDir)) {
        try {
          const canonicalParent = await fs.realpath(currentDir);
          if (
            !canonicalParent.startsWith(canonicalRoot + path.sep) &&
            canonicalParent !== canonicalRoot
          ) {
            throw new Error(`Security Violation: Path escapes workspace root: ${inputPath}`);
          }
          break;
        } catch {
          currentDir = path.dirname(currentDir);
        }
      }
      canonicalTarget = target;
    } else {
      throw err;
    }
  }

  if (
    !canonicalTarget.startsWith(canonicalRoot + path.sep) &&
    canonicalTarget !== canonicalRoot
  ) {
    throw new Error(`Security Violation: Path escapes workspace root: ${inputPath}`);
  }

  if (isSensitivePath(canonicalTarget) || isSensitivePath(inputPath)) {
    throw new Error(`Security Violation: Access to sensitive file is blocked: ${inputPath}`);
  }

  return canonicalTarget;
}

export async function filterSafePaths(
  paths: string[],
  workspaceRoot?: string
): Promise<string[]> {
  const safe: string[] = [];
  for (const p of paths) {
    try {
      if (!isSensitivePath(p) && !isDefaultIgnoredPath(p)) {
        await assertSafePath(p, workspaceRoot);
        safe.push(p);
      }
    } catch {
      // Omit paths that escape or are blocked
    }
  }
  return safe;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/ai/tools/__tests__/file-security.test.ts --maxWorkers=1`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/tools/file-security.ts src/lib/ai/tools/__tests__/file-security.test.ts
git commit -m "feat(tools): add canonical realpath boundary assertion and sensitive file filtering"
```

---

### Task 2: Host CLI Capabilities Detector (`file-capabilities.ts`)

**Files:**
- Create: `src/lib/ai/tools/file-capabilities.ts`
- Test: `src/lib/ai/tools/__tests__/file-capabilities.test.ts`

**Interfaces:**
- Produces:
  - `interface HostCliCapabilities`: `{ hasEza: boolean; hasFd: boolean; hasRipgrep: boolean; hasZoxide: boolean; hasFzf: boolean }`
  - `probeCliCapabilities(forceRefresh?: boolean): Promise<HostCliCapabilities>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/ai/tools/__tests__/file-capabilities.test.ts
import { describe, it, expect, vi } from "vitest";
import { probeCliCapabilities } from "../file-capabilities";

describe("Host CLI Capabilities Probing", () => {
  it("probes and returns boolean flags for tools", async () => {
    const caps = await probeCliCapabilities(true);
    expect(typeof caps.hasEza).toBe("boolean");
    expect(typeof caps.hasFd).toBe("boolean");
    expect(typeof caps.hasRipgrep).toBe("boolean");
    expect(typeof caps.hasZoxide).toBe("boolean");
    expect(typeof caps.hasFzf).toBe("boolean");
  });

  it("caches results on subsequent calls unless forceRefresh is true", async () => {
    const caps1 = await probeCliCapabilities(false);
    const caps2 = await probeCliCapabilities(false);
    expect(caps1).toBe(caps2); // Same object reference when cached
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/tools/__tests__/file-capabilities.test.ts --maxWorkers=1`  
Expected: FAIL with module not found for `../file-capabilities`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/ai/tools/file-capabilities.ts
import { spawn } from "node:child_process";

export interface HostCliCapabilities {
  hasEza: boolean;
  hasFd: boolean;
  hasRipgrep: boolean;
  hasZoxide: boolean;
  hasFzf: boolean;
}

let cachedCapabilities: HostCliCapabilities | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function checkCommand(binName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [binName], {
      stdio: "ignore",
      shell: false,
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export async function probeCliCapabilities(forceRefresh = false): Promise<HostCliCapabilities> {
  const now = Date.now();
  if (!forceRefresh && cachedCapabilities && now < cacheExpiry) {
    return cachedCapabilities;
  }

  const [hasEza, hasFd, hasRipgrep, hasZoxide, hasFzf] = await Promise.all([
    checkCommand("eza"),
    checkCommand("fd"),
    checkCommand("rg"),
    checkCommand("zoxide"),
    checkCommand("fzf"),
  ]);

  cachedCapabilities = {
    hasEza,
    hasFd,
    hasRipgrep,
    hasZoxide,
    hasFzf,
  };
  cacheExpiry = now + CACHE_TTL_MS;

  return cachedCapabilities;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/ai/tools/__tests__/file-capabilities.test.ts --maxWorkers=1`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/tools/file-capabilities.ts src/lib/ai/tools/__tests__/file-capabilities.test.ts
git commit -m "feat(tools): add cached host CLI capabilities detector for eza, fd, rg, and zoxide"
```

---

### Task 3: Unified File Operations Tool (`file_operations`)

**Files:**
- Create: `src/lib/ai/tools/files.ts`
- Test: `src/lib/ai/tools/__tests__/files.test.ts`

**Interfaces:**
- Produces:
  - `file_operations`: AI SDK `tool({...})` with discriminated union actions (`list`, `find`, `grep`, `jump`, `read`, `write`, `edit`)
- Implements:
  - Argument array subprocess calls (`shell: false`)
  - Realpath verification via `assertSafePath`
  - Output truncation (50KB / 1000 lines, max 50 items)
  - Null-byte binary detection in `read`
  - Backup `<path>.bak.<timestamp>` on `write` overwrite
  - Exact unique match check on `edit`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/ai/tools/__tests__/files.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { file_operations } from "../files";

describe("file_operations Tool", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = path.join(os.tmpdir(), "ygg-fileops-test-" + crypto.randomUUID());
    await fs.mkdir(tmpRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes and reads a text file cleanly", async () => {
    const filePath = path.join(tmpRoot, "hello.txt");
    const writeRes = await file_operations.execute!(
      { action: "write", path: filePath, content: "Line 1\nLine 2" },
      {} as never
    );
    expect(writeRes).toHaveProperty("path");
    expect(writeRes).toHaveProperty("bytesWritten");

    const readRes = (await file_operations.execute!(
      { action: "read", path: filePath },
      {} as never
    )) as { content: string };
    expect(readRes.content).toContain("Line 1");
    expect(readRes.content).toContain("Line 2");
  });

  it("creates a .bak snapshot when overwriting an existing file", async () => {
    const filePath = path.join(tmpRoot, "overwrite.txt");
    await fs.writeFile(filePath, "original content", "utf8");

    await file_operations.execute!(
      { action: "write", path: filePath, content: "new content" },
      {} as never
    );

    const files = await fs.readdir(tmpRoot);
    const backupFile = files.find((f) => f.startsWith("overwrite.txt.bak."));
    expect(backupFile).toBeDefined();

    const backupContent = await fs.readFile(path.join(tmpRoot, backupFile!), "utf8");
    expect(backupContent).toBe("original content");
  });

  it("performs surgical exact-string edits", async () => {
    const filePath = path.join(tmpRoot, "edit.txt");
    await fs.writeFile(filePath, "const port = 3000;\nconsole.log(port);", "utf8");

    await file_operations.execute!(
      {
        action: "edit",
        path: filePath,
        oldString: "const port = 3000;",
        newString: "const port = 2302;",
      },
      {} as never
    );

    const updated = await fs.readFile(filePath, "utf8");
    expect(updated).toContain("const port = 2302;");
  });

  it("rejects edits if oldString does not exist or is ambiguous", async () => {
    const filePath = path.join(tmpRoot, "ambiguous.txt");
    await fs.writeFile(filePath, "repeat\nrepeat", "utf8");

    const resMissing = (await file_operations.execute!(
      { action: "edit", path: filePath, oldString: "missing", newString: "x" },
      {} as never
    )) as { error?: string };
    expect(resMissing.error).toContain("was not found");

    const resAmbiguous = (await file_operations.execute!(
      { action: "edit", path: filePath, oldString: "repeat", newString: "x" },
      {} as never
    )) as { error?: string };
    expect(resAmbiguous.error).toContain("matched 2 times");
  });

  it("detects binary files and does not dump raw bytes", async () => {
    const binPath = path.join(tmpRoot, "sample.bin");
    const binBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(binPath, binBuffer);

    const res = (await file_operations.execute!(
      { action: "read", path: binPath },
      {} as never
    )) as { isBinary: boolean };
    expect(res.isBinary).toBe(true);
  });

  it("handles malicious command injection characters safely as literal strings", async () => {
    const evilQuery = "'; rm -rf / ; $(whoami) | touch pwned";
    const res = await file_operations.execute!(
      { action: "grep", query: evilQuery, path: tmpRoot },
      {} as never
    );
    expect(res).toBeDefined();
    // Verify no command ran
    expect(await fs.stat(path.join(tmpRoot, "pwned")).catch(() => false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/tools/__tests__/files.test.ts --maxWorkers=1`  
Expected: FAIL with module not found for `../files`.

- [ ] **Step 3: Write minimal implementation**

```typescript
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
      path: z.string().default(".").describe("Directory path to list"),
      depth: z.number().min(1).max(5).default(2).describe("Traversal depth"),
      showHidden: z.boolean().default(false).describe("Include dotfiles"),
    }),
    z.object({
      action: z.literal("find"),
      pattern: z.string().describe("Filename or pattern to find"),
      path: z.string().default(".").describe("Search root directory"),
    }),
    z.object({
      action: z.literal("grep"),
      query: z.string().describe("Text or regex to search inside files"),
      path: z.string().default(".").describe("Search root directory or file"),
      caseSensitive: z.boolean().default(false),
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
        const safePath = await assertSafePath(input.path);
        if (caps.hasEza) {
          const args = ["--tree", `--level=${input.depth}`, "--color=never", "--ignore-glob", "node_modules|.git|.next|dist"];
          if (input.showHidden) args.push("-a");
          args.push(safePath);
          const res = await runProcess("eza", args);
          return { path: input.path, listing: res.stdout || res.stderr };
        }
        // Fallback: Node.js recursive read
        const formatTree = async (dir: string, currentDepth: number): Promise<string[]> => {
          if (currentDepth > input.depth) return [];
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const lines: string[] = [];
          for (const e of entries) {
            if (!input.showHidden && e.name.startsWith(".")) continue;
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
        return { path: input.path, listing: lines.join("\n") };
      }

      if (input.action === "find") {
        const safePath = await assertSafePath(input.path);
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
        const safePath = await assertSafePath(input.path);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/ai/tools/__tests__/files.test.ts --maxWorkers=1`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/tools/files.ts src/lib/ai/tools/__tests__/files.test.ts
git commit -m "feat(tools): add unified file_operations tool with security and CLI fallbacks"
```

---

### Task 4: Multi-Channel Alerting Tool (`notify_user`)

**Files:**
- Create: `src/lib/ai/tools/notify.ts`
- Test: `src/lib/ai/tools/__tests__/notify.test.ts`

**Interfaces:**
- Produces:
  - `notify_user`: AI SDK `tool({...})`
  - In-memory rate limiting (max 5/min) and 10s deduplication

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/ai/tools/__tests__/notify.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { notify_user, resetNotificationRateLimit } from "../notify";

describe("notify_user Tool", () => {
  beforeEach(() => {
    resetNotificationRateLimit();
  });

  it("successfully accepts and delivers valid notifications", async () => {
    const res = (await notify_user.execute!(
      { title: "Task Done", message: "Build completed successfully", level: "success", sound: true },
      {} as never
    )) as { delivered: boolean; title?: string };

    expect(res.delivered).toBe(true);
    expect(res.title).toBe("Task Done");
  });

  it("suppresses duplicate notifications within 10 seconds", async () => {
    const res1 = (await notify_user.execute!(
      { title: "Alert", message: "Notice", level: "info", sound: false },
      {} as never
    )) as { delivered: boolean };
    expect(res1.delivered).toBe(true);

    const res2 = (await notify_user.execute!(
      { title: "Alert", message: "Notice", level: "info", sound: false },
      {} as never
    )) as { delivered: boolean; reason?: string };
    expect(res2.delivered).toBe(false);
    expect(res2.reason).toContain("Duplicate suppressed");
  });

  it("enforces rate limit of maximum 5 notifications per 60 seconds", async () => {
    for (let i = 0; i < 5; i++) {
      const res = (await notify_user.execute!(
        { title: `Notice ${i}`, message: `Content ${i}`, level: "info", sound: false },
        {} as never
      )) as { delivered: boolean };
      expect(res.delivered).toBe(true);
    }

    const res6 = (await notify_user.execute!(
      { title: "Notice 6", message: "Content 6", level: "info", sound: false },
      {} as never
    )) as { delivered: boolean; reason?: string };
    expect(res6.delivered).toBe(false);
    expect(res6.reason).toContain("Rate limit exceeded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/tools/__tests__/notify.test.ts --maxWorkers=1`  
Expected: FAIL with module not found for `../notify`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/ai/tools/notify.ts
import { tool } from "ai";
import { z } from "zod";

const WINDOW_MS = 60 * 1000;
const MAX_NOTIFICATIONS_PER_WINDOW = 5;
const DEDUP_WINDOW_MS = 10 * 1000;

let notificationTimestamps: number[] = [];
let lastNotification: { title: string; message: string; timestamp: number } | null = null;

export function resetNotificationRateLimit() {
  notificationTimestamps = [];
  lastNotification = null;
}

export const notify_user = tool({
  description:
    "Send an active notification to the user across browser and desktop channels. Useful for alerting when long-running tasks, code executions, or background operations complete, or when urgent input is needed. Rate-limited to max 5 per minute with duplicate suppression.",
  inputSchema: z.object({
    title: z.string().min(1).max(100).describe("Brief notification title"),
    message: z.string().min(1).max(500).describe("Descriptive notification content"),
    level: z
      .enum(["info", "success", "warning", "urgent"])
      .default("info")
      .describe("Severity level"),
    sound: z.boolean().default(true).describe("Whether to play an audible chime on client"),
  }),
  execute: async ({ title, message, level, sound }) => {
    const now = Date.now();

    // Deduplication check
    if (
      lastNotification &&
      lastNotification.title === title &&
      lastNotification.message === message &&
      now - lastNotification.timestamp < DEDUP_WINDOW_MS
    ) {
      return { delivered: false, reason: "Duplicate suppressed (sent within 10s)" };
    }

    // Rate limit window filter
    notificationTimestamps = notificationTimestamps.filter((t) => now - t < WINDOW_MS);
    if (notificationTimestamps.length >= MAX_NOTIFICATIONS_PER_WINDOW) {
      return { delivered: false, reason: "Rate limit exceeded (max 5/min)" };
    }

    notificationTimestamps.push(now);
    lastNotification = { title, message, timestamp: now };

    return {
      delivered: true,
      timestamp: now,
      title,
      message,
      level,
      sound,
    };
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/ai/tools/__tests__/notify.test.ts --maxWorkers=1`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/tools/notify.ts src/lib/ai/tools/__tests__/notify.test.ts
git commit -m "feat(tools): add notify_user tool with rate limiting and deduplication"
```

---

### Task 5: Host Diagnostic Tool (`host_info`) & Builtin Registry Wiring

**Files:**
- Create: `src/lib/ai/tools/system.ts`
- Modify: `src/lib/ai/tools/index.ts`
- Test: `src/lib/ai/tools/__tests__/system.test.ts`
- Test: `src/lib/ai/tools/__tests__/registry.test.ts`

**Interfaces:**
- Produces:
  - `host_info`: AI SDK `tool({...})` returning OS, resources, and CLI tools
  - Updates `builtinTools` in `src/lib/ai/tools/index.ts` to export `file_operations`, `notify_user`, and `host_info`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/ai/tools/__tests__/system.test.ts
import { describe, it, expect } from "vitest";
import { host_info } from "../system";
import { builtinTools } from "../index";

describe("host_info Tool & Registry Integration", () => {
  it("returns host OS, resource metrics, and tool availability", async () => {
    const res = (await host_info.execute!({}, {} as never)) as {
      os: { platform: string; arch: string };
      resources: { totalMemMb: number; cpus: number };
      tools: { hasEza: boolean };
    };

    expect(res.os).toHaveProperty("platform");
    expect(res.os).toHaveProperty("arch");
    expect(res.resources.cpus).toBeGreaterThan(0);
    expect(res.resources.totalMemMb).toBeGreaterThan(0);
    expect(typeof res.tools.hasEza).toBe("boolean");
  });

  it("exports file_operations, notify_user, and host_info in builtinTools", () => {
    expect(builtinTools).toHaveProperty("file_operations");
    expect(builtinTools).toHaveProperty("notify_user");
    expect(builtinTools).toHaveProperty("host_info");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/tools/__tests__/system.test.ts --maxWorkers=1`  
Expected: FAIL with module not found for `../system`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/ai/tools/system.ts
import { tool } from "ai";
import { z } from "zod";
import os from "node:os";
import { probeCliCapabilities } from "./file-capabilities";

export const host_info = tool({
  description:
    "Diagnostic tool to inspect the host system environment, hardware resources (CPU, Memory, Uptime), OS platform, and availability of installed modern CLI tools (eza, fd, ripgrep, zoxide, fzf).",
  inputSchema: z.object({}),
  execute: async () => {
    const tools = await probeCliCapabilities();
    const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
    const freeMemMb = Math.round(os.freemem() / (1024 * 1024));

    return {
      os: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
      },
      resources: {
        totalMemMb,
        freeMemMb,
        cpus: os.cpus().length,
        uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
      },
      tools,
    };
  },
});
```

Update `src/lib/ai/tools/index.ts`:
```typescript
import * as artifact from "./artifact";
import * as core from "./core";
import * as memory from "./memory";
import * as task from "./task";
import * as web from "./web";
import * as files from "./files";
import * as notify from "./notify";
import * as system from "./system";

export const builtinTools = {
  ...web,
  ...task,
  ...core,
  ...artifact,
  ...memory,
  ...files,
  ...notify,
  ...system,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/ai/tools/__tests__/system.test.ts --maxWorkers=1`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/tools/system.ts src/lib/ai/tools/index.ts src/lib/ai/tools/__tests__/system.test.ts
git commit -m "feat(tools): add host_info diagnostic tool and register builtinTools"
```

---

### Task 6: Client UI Notification Audio & Toast Integration

**Files:**
- Modify: `src/components/chat/ToolInvocation.tsx`
- Modify: `src/components/chat/MessageParts.tsx`
- Test: `src/components/chat/__tests__/notify-tool-ui.test.tsx`

**Interfaces:**
- Produces:
  - Custom UI badge/card for `notify_user` in chat history
  - Web Audio tone synthesis (`AudioContext`) on `notify_user` events
  - Browser notification request (`Notification`)

- [ ] **Step 1: Write the failing test**

```typescript
// src/components/chat/__tests__/notify-tool-ui.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolInvocation } from "../ToolInvocation";
import type { ToolUIPart } from "ai";

describe("notify_user Tool UI Rendering", () => {
  it("renders notification title and level clearly", () => {
    const part = {
      type: "tool-notify_user",
      toolCallId: "call-1",
      toolName: "notify_user",
      state: "output-available",
      input: { title: "Build Succeeded", message: "All tests green", level: "success" },
      output: { delivered: true, title: "Build Succeeded", level: "success" },
    } as unknown as ToolUIPart;

    render(<ToolInvocation part={part} />);
    expect(screen.getByText(/Build Succeeded/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/chat/__tests__/notify-tool-ui.test.tsx --maxWorkers=1`  
Expected: FAIL or missing title presentation.

- [ ] **Step 3: Write minimal implementation**

Update `src/components/chat/ToolInvocation.tsx` and helper audio chime trigger when `toolName === "notify_user"` in `output-available`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/chat/__tests__/notify-tool-ui.test.tsx --maxWorkers=1`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/ToolInvocation.tsx src/components/chat/__tests__/notify-tool-ui.test.tsx
git commit -m "feat(ui): add visual receipt and Web Audio chime integration for notify_user"
```

---

### Task 7: Full Regression Suite & Type Verification

**Files:**
- Test: Full CLI, tools, and API test suites

- [ ] **Step 1: Run all touched tool test suites**

Run: `pnpm vitest run src/lib/ai/tools/__tests__/ src/components/chat/__tests__/notify-tool-ui.test.tsx --maxWorkers=1`  
Expected: PASS across all tool tests with 0 failures.

- [ ] **Step 2: Run TypeScript and ESLint checks**

Run: `pnpm tsc --noEmit`  
Run: `pnpm eslint src/lib/ai/tools/`  
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git commit --allow-empty -m "chore(tools): verify complete test suite and TypeScript clean"
```
