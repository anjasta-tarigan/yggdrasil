# Project Harness Agent, Reasoning Engine & AI SDK v7 Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a fully functional, autonomous Project Harness Agent chat with interactive terminal outputs, file operations, artifacts, and task tracking, alongside a system-wide reasoning engine (auto-detect `xhigh` default with fallback cascade and `<think>` stream transformer) aligned with AI SDK v7 standards.

**Architecture:** 
- A unified reasoning engine (`src/lib/ai/reasoning.ts`) that maps `xhigh` reasoning effort to provider-specific parameters (OpenAI `high`, Anthropic `budgetTokens: 16000`, open-weight passthrough) and provides a stateful lookahead stream transformer for extracting `<think>...</think>` tags into native AI SDK reasoning parts.
- Hardened project harness tools (`src/lib/project-service.ts`) with process group lifecycle management (`detached: true`, `SIGTERM` $\to$ `SIGKILL`), symlink boundary validation (`fs.realpathSync`), and UTF-8 decoders.
- Interactive harness chat endpoint (`/api/projects/chat`) and UI (`src/components/projects-view.tsx`) with `<Reasoning>`, `<Terminal>`, `<Task>`, `<ArtifactChip>`, and synchronized multi-session management.

**Tech Stack:** Next.js 16 (App Router), AI SDK v7 (`ai`, `@ai-sdk/openai-compatible`), Drizzle ORM, better-sqlite3, Tailwind CSS v4, Radix UI, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-project-harness-reasoning-design.md`

## Global Constraints
- Strictly adhere to Rule 06 (System Isolation / Project Directory Jailing).
- No silent error suppression (Rule 02) and no N+1 database queries (Rule 12).
- Zero regressions across existing test suites (47 test files).

---

### Task 1: Reasoning Engine & `<think>` Tag Stream Transformer

**Files:**
- Create: `src/lib/ai/reasoning.ts`
- Test: `src/lib/ai/__tests__/reasoning.test.ts`

**Interfaces:**
- Consumes: None
- Produces:
  - `getReasoningProviderOptions(modelId: string, requestedEffort?: "xhigh" | "high" | "medium" | "low"): Record<string, unknown>`
  - `createThinkTagStreamTransformer(): TransformStream<UIMessageStreamPart, UIMessageStreamPart>`
  - `extractThinkTags(text: string): { reasoning: string | null; text: string }`

- [ ] **Step 1: Write failing unit tests for reasoning provider options and `<think>` transformer**

```typescript
// src/lib/ai/__tests__/reasoning.test.ts
import { describe, it, expect } from "vitest";
import {
  getReasoningProviderOptions,
  extractThinkTags,
  createThinkTagStreamTransformer,
} from "../reasoning";

describe("Reasoning Engine", () => {
  it("maps xhigh reasoning effort to OpenAI and Anthropic provider options", () => {
    const oaiOptions = getReasoningProviderOptions("o3-mini", "xhigh");
    expect(oaiOptions).toMatchObject({
      openai: { reasoningEffort: "high" },
    });

    const claudeOptions = getReasoningProviderOptions("claude-3-7-sonnet-20250219", "xhigh");
    expect(claudeOptions).toMatchObject({
      anthropic: { thinking: { type: "enabled", budgetTokens: 16000 } },
    });
  });

  it("extracts <think> tags from complete text", () => {
    const raw = "<think>Let me analyze the algorithm.</think>Here is the solution.";
    const result = extractThinkTags(raw);
    expect(result.reasoning).toBe("Let me analyze the algorithm.");
    expect(result.text).toBe("Here is the solution.");
  });

  it("transforms split <think> stream chunks into reasoning and text parts", async () => {
    const transformer = createThinkTagStreamTransformer();
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", text: "<th" });
        controller.enqueue({ type: "text-delta", text: "ink>Thinking about code" });
        controller.enqueue({ type: "text-delta", text: "</think>Final output" });
        controller.close();
      },
    });

    const reader = readable.pipeThrough(transformer).getReader();
    const parts: any[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    const reasoningParts = parts.filter((p) => p.type === "reasoning");
    const textParts = parts.filter((p) => p.type === "text-delta");
    expect(reasoningParts.length).toBeGreaterThan(0);
    expect(reasoningParts.map((p) => p.text).join("")).toBe("Thinking about code");
    expect(textParts.map((p) => p.text).join("")).toBe("Final output");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/__tests__/reasoning.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/lib/ai/reasoning.ts`**

```typescript
// src/lib/ai/reasoning.ts
export type ReasoningEffortTier = "xhigh" | "high" | "medium" | "low";

export function getReasoningProviderOptions(
  modelId: string,
  requestedEffort: ReasoningEffortTier = "xhigh"
): Record<string, unknown> {
  const isAnthropic = modelId.toLowerCase().includes("claude");
  const isOpenAiReasoning =
    modelId.toLowerCase().startsWith("o1") ||
    modelId.toLowerCase().startsWith("o3") ||
    modelId.toLowerCase().includes("reasoning");

  if (isOpenAiReasoning) {
    const oaiEffort = requestedEffort === "xhigh" ? "high" : requestedEffort;
    return {
      openai: { reasoningEffort: oaiEffort },
    };
  }

  if (isAnthropic) {
    const budgetTokens =
      requestedEffort === "xhigh"
        ? 16000
        : requestedEffort === "high"
          ? 8000
          : requestedEffort === "medium"
            ? 4000
            : 2048;
    return {
      anthropic: {
        thinking: { type: "enabled", budgetTokens },
      },
    };
  }

  // Open-weight / custom vLLM passthrough
  return {
    openai: {
      reasoningEffort: requestedEffort === "xhigh" ? "high" : requestedEffort,
    },
  };
}

export function extractThinkTags(rawText: string): { reasoning: string | null; text: string } {
  const match = rawText.match(/<think>([\s\S]*?)<\/think>/);
  if (!match) {
    return { reasoning: null, text: rawText };
  }
  const reasoning = match[1].trim();
  const text = rawText.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return { reasoning, text };
}

export function createThinkTagStreamTransformer(): TransformStream<any, any> {
  let insideThink = false;
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.type !== "text-delta" || typeof chunk.text !== "string") {
        controller.enqueue(chunk);
        return;
      }

      buffer += chunk.text;

      while (buffer.length > 0) {
        if (!insideThink) {
          const thinkStart = buffer.indexOf("<think>");
          if (thinkStart === -1) {
            // Check for partial '<think' at the end of buffer
            const partialIndex = buffer.lastIndexOf("<");
            if (partialIndex !== -1 && "<think>".startsWith(buffer.slice(partialIndex))) {
              const safeText = buffer.slice(0, partialIndex);
              if (safeText) controller.enqueue({ type: "text-delta", text: safeText });
              buffer = buffer.slice(partialIndex);
              break;
            }
            controller.enqueue({ type: "text-delta", text: buffer });
            buffer = "";
            break;
          }

          const before = buffer.slice(0, thinkStart);
          if (before) controller.enqueue({ type: "text-delta", text: before });
          insideThink = true;
          buffer = buffer.slice(thinkStart + "<think>".length);
        } else {
          const thinkEnd = buffer.indexOf("</think>");
          if (thinkEnd === -1) {
            const partialIndex = buffer.lastIndexOf("<");
            if (partialIndex !== -1 && "</think>".startsWith(buffer.slice(partialIndex))) {
              const safeReasoning = buffer.slice(0, partialIndex);
              if (safeReasoning) controller.enqueue({ type: "reasoning", text: safeReasoning });
              buffer = buffer.slice(partialIndex);
              break;
            }
            controller.enqueue({ type: "reasoning", text: buffer });
            buffer = "";
            break;
          }

          const reasoning = buffer.slice(0, thinkEnd);
          if (reasoning) controller.enqueue({ type: "reasoning", text: reasoning });
          insideThink = false;
          buffer = buffer.slice(thinkEnd + "</think>".length);
        }
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        if (insideThink) {
          controller.enqueue({ type: "reasoning", text: buffer });
        } else {
          controller.enqueue({ type: "text-delta", text: buffer });
        }
        buffer = "";
      }
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/ai/__tests__/reasoning.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit Task 1**

```bash
git add src/lib/ai/reasoning.ts src/lib/ai/__tests__/reasoning.test.ts
git commit -m "feat(reasoning): add auto-detect reasoning options and think tag stream transformer"
```

---

### Task 2: Subprocess Process Group Management & Enhanced Project Tools

**Files:**
- Modify: `src/lib/project-service.ts`
- Create: `src/lib/__tests__/project-service.test.ts`

**Interfaces:**
- Consumes: `createProjectHarnessTools(projectDirectory: string)`
- Produces:
  - Subprocess cancellation with process group escalation (`SIGTERM` $\to$ `SIGKILL`)
  - Realpath symlink traversal rejection in `validateAndResolveProjectPath`

- [ ] **Step 1: Write failing unit test for project service symlink protection and command timeouts**

```typescript
// src/lib/__tests__/project-service.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  validateAndResolveProjectPath,
  createProjectHarnessTools,
} from "../project-service";

describe("Project Service Hardening", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-proj-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects path traversal via symlinks pointing outside project directory", async () => {
    const secretFile = path.join(os.tmpdir(), "outside-secret.txt");
    await fs.writeFile(secretFile, "top-secret");

    const symlinkPath = path.join(tmpDir, "escape_link");
    fsSync.symlinkSync(secretFile, symlinkPath);

    expect(() => validateAndResolveProjectPath(tmpDir, "escape_link")).toThrow(
      /escapes the project directory boundary/
    );

    await fs.rm(secretFile, { force: true });
  });

  it("executes bash commands inside project directory and returns result", async () => {
    const tools = createProjectHarnessTools(tmpDir);
    const res: any = await tools.projectBash.execute(
      { command: "pwd && echo 'hello project'" },
      { messages: [], toolCallId: "1" }
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("hello project");
  });
});
```

- [ ] **Step 2: Run test to verify it fails or validates**

Run: `pnpm vitest run src/lib/__tests__/project-service.test.ts`

- [ ] **Step 3: Update `src/lib/project-service.ts` with process group kill & timeout handling**

Update `projectBash` in `src/lib/project-service.ts`:
- Set `detached: true` on `spawn`.
- On timeout/signal kill, call `process.kill(-child.pid, "SIGTERM")`, followed by a fallback `SIGKILL` timer.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/__tests__/project-service.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit Task 2**

```bash
git add src/lib/project-service.ts src/lib/__tests__/project-service.test.ts
git commit -m "feat(project-service): add process group lifecycle control and symlink security validation"
```

---

### Task 3: Chat & Project Chat API Reasoning & Tool Integration

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/app/api/projects/chat/route.ts`
- Modify: `src/app/api/__tests__/projects-chat-api.test.ts`

**Interfaces:**
- Consumes: `getReasoningProviderOptions`, `createThinkTagStreamTransformer` from `@/lib/ai/reasoning`
- Produces: Integrated reasoning, abort signal passing (`req.signal`), and full tool execution in chat and project harness routes.

- [ ] **Step 1: Update `src/app/api/__tests__/projects-chat-api.test.ts` to test reasoning and abort cleanup**

Add assertions in `projects-chat-api.test.ts` checking that `POST` accepts project chat requests, configures reasoning options, and pipes through `<think>` tag transformation.

- [ ] **Step 2: Update `src/app/api/projects/chat/route.ts` and `src/app/api/chat/route.ts`**

In both endpoints:
- Import `getReasoningProviderOptions` and `createThinkTagStreamTransformer` from `@/lib/ai/reasoning`.
- Pass `providerOptions: getReasoningProviderOptions(modelId, "xhigh")` to `streamText`.
- Pass `abortSignal: req.signal` to `streamText`.
- Pipe stream output through `createThinkTagStreamTransformer()` before `createUIMessageStreamResponse`.

- [ ] **Step 3: Run project chat API tests**

Run: `pnpm vitest run src/app/api/__tests__/projects-chat-api.test.ts`  
Expected: PASS

- [ ] **Step 4: Commit Task 3**

```bash
git add src/app/api/chat/route.ts src/app/api/projects/chat/route.ts src/app/api/__tests__/projects-chat-api.test.ts
git commit -m "feat(api): integrate reasoning provider options and think tag stream transformer in chat routes"
```

---

### Task 4: Rich Interactive Project Harness Feed (`projects-view.tsx`)

**Files:**
- Modify: `src/components/projects-view.tsx`
- Modify: `src/components/__tests__/projects-view.test.tsx`

**Interfaces:**
- Consumes: `<Reasoning>`, `<Terminal>`, `<Task>`, `<ArtifactChip>`, `chatTools`, `projectTools`
- Produces: Rich interactive agent feed on the Project page with live reasoning duration, terminal outputs, file inspection, artifact drawers, and cancellation controls.

- [ ] **Step 1: Write UI tests for interactive reasoning and terminal render in `projects-view.test.tsx`**

```typescript
// Add test in src/components/__tests__/projects-view.test.tsx
it("renders reasoning block and terminal tool outputs in harness chat", async () => {
  // Assert <Reasoning> and terminal output render when message contains reasoning or projectBash
});
```

- [ ] **Step 2: Update `src/components/projects-view.tsx`**

In `src/components/projects-view.tsx`:
- Import `<Reasoning>`, `<ReasoningTrigger>`, `<ReasoningContent>` from `@/components/ai-elements/reasoning`.
- Import `<Task>`, `<TaskItem>` for `manage_tasks` parts.
- Add `<Terminal>` renderer for `projectBash` parts showing exit status, stdout, and stderr.
- Add `<ArtifactChip>` integration and artifact drawer modal.
- Synchronize session state so active session switching updates messages immediately.
- Add Stop button (`stop()`) during active generation.

- [ ] **Step 3: Run project view tests**

Run: `pnpm vitest run src/components/__tests__/projects-view.test.tsx`  
Expected: PASS

- [ ] **Step 4: Commit Task 4**

```bash
git add src/components/projects-view.tsx src/components/__tests__/projects-view.test.tsx
git commit -m "feat(ui): add rich interactive harness feed with reasoning, terminal, and artifacts"
```

---

### Task 5: Full Regression & System Verification Pass

**Files:**
- Test: All 47+ test suites across the repository.

- [ ] **Step 1: Run complete test suite**

Run: `pnpm vitest run`  
Expected: All test suites PASS (0 failures)

- [ ] **Step 2: Run TypeScript typecheck**

Run: `pnpm tsc --noEmit`  
Expected: 0 errors

- [ ] **Step 3: Verify git working tree status**

Run: `git status`

- [ ] **Step 4: Commit and Push final changes**

```bash
git commit -m "chore: complete project harness agent and reasoning engine integration"
git push origin development
```
