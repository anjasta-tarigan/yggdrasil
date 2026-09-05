# Dynamic Context Window Budgeting, Auto-Compaction, and Reasoning-Aware Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement dynamic model-aware context budgeting, tool-atomic auto-compaction and summary, monotonic reasoning-aware output caps, and client-side model-switching context recalculation.

**Architecture:** Model resolution occurs first before context pruning. The server dynamically derives reasoning output and thinking budgets (`reasoning.ts`), calculates message context budget with proportional output clamping (`context-budget.ts`), reconciles thinking budget against clamped output, and compacts dropped history with hierarchical summary rollups. The exact clamped output is passed to `streamText`, strictly guaranteeing zero window overflow.

**Tech Stack:** Next.js 16 App Router (React 19), TypeScript 6, AI SDK v7 (`ai`, `@ai-sdk/openai-compatible`), Vitest 4 (`maxWorkers: 2`, `--maxWorkers=1` in subagents).

**Spec:** `docs/superpowers/specs/2026-09-05-dynamic-context-compaction-reasoning-design.md`

## Global Constraints

- Strictly follow Rule 18 (tests never run concurrently — subagents use `npx vitest run <file> --maxWorkers=1`; full suite honors `vitest.config.ts` `maxWorkers: 2`).
- Follow Rule 16 (surgical, minimal diffs — no collateral refactoring, no dead code).
- Invariant: `budgetTokens + effectiveMaxOutputTokens + systemAndToolsTokens <= effectiveWindow` under all context window sizes.
- Invariant: `thinkingBudget < effectiveMaxOutputTokens` strictly holds for all reasoning tiers where thinking is enabled.
- Invariant: Thinking budget $< 1024$ or tier `none` disables thinking cleanly (`{ type: "disabled" }`, budget 0).
- Tool atomicity: Tool-call and tool-result pairs must never be split across the message pruning boundary.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/ai/reasoning.ts` | Compute monotonic reasoning output allocation (`calculateReasoningOutputBudget`) and reconcile thinking budget post-clamp (`reconcileThinkingBudget`). |
| `src/lib/ai/context-budget.ts` | Dynamic context budget calculation (`calculateContextTokenBudget`), tool-atomic message pruning, fast extractive compaction with hierarchical summary rollup (`compactAndPruneMessages`). |
| `src/app/api/chat/route.ts` | Orchestrate model resolution $\rightarrow$ reasoning output $\rightarrow$ context budget $\rightarrow$ thinking reconciliation $\rightarrow$ compaction $\rightarrow$ `streamText`. |
| `src/components/chat/ChatArea.tsx` | Bind context gauge and tooltip to dynamic model capabilities on model switch. |
| `src/lib/ai/__tests__/reasoning.test.ts` | Tests for reasoning output monotonicity, headroom, and minimum threshold guard. |
| `src/lib/ai/__tests__/context-budget.test.ts` | Tests for dynamic context budget, zero-overflow invariant, tool atomicity, and hierarchical summary rollup. |
| `src/app/api/__tests__/chat-registry.test.ts` | Integration tests verifying dynamic context budget and synchronized parameters sent to `streamText`. |

---

### Task 1: Reasoning Output Budget & Post-Clamp Reconciliation

**Files:**
- Modify: `src/lib/ai/reasoning.ts`
- Test: `src/lib/ai/__tests__/reasoning.test.ts`

**Interfaces:**
- Consumes: `ReasoningEffortTier = "xhigh" | "high" | "medium" | "low" | "none"`
- Produces:
  ```ts
  export function calculateReasoningOutputBudget(
    effort: ReasoningEffortTier,
    modelMaxOutput: number | null | undefined
  ): { targetThinking: number; requestedOutputTokens: number };

  export function reconcileThinkingBudget(
    effectiveMaxOutputTokens: number,
    targetThinking: number,
    tier: ReasoningEffortTier,
    modelId: string
  ): {
    finalThinkingBudget: number;
    thinkingEnabled: boolean;
    providerOptions: Record<string, any>;
  };
  ```

- [ ] **Step 1: Write the failing tests**

Update `src/lib/ai/__tests__/reasoning.test.ts` with tests for universal monotonicity, structural headroom, and minimum threshold guard:

```ts
import { describe, it, expect } from "vitest";
import {
  calculateReasoningOutputBudget,
  reconcileThinkingBudget,
  ReasoningEffortTier,
} from "../reasoning";

describe("calculateReasoningOutputBudget & reconcileThinkingBudget", () => {
  const SIZES = [500, 1000, 2048, 4096, 8192, 16384, 32768, 65536, 128000, 1000000];
  const TIERS: ReasoningEffortTier[] = ["none", "low", "medium", "high", "xhigh"];

  it("satisfies universal monotonicity across all modelMaxOutput capacities", () => {
    for (const size of SIZES) {
      const outputs = TIERS.map(
        (t) => calculateReasoningOutputBudget(t, size).requestedOutputTokens
      );
      for (let i = 0; i < outputs.length - 1; i++) {
        expect(outputs[i]).toBeLessThanOrEqual(outputs[i + 1]);
      }
    }
  });

  it("guarantees targetThinking < requestedOutputTokens when thinking is requested", () => {
    for (const size of SIZES) {
      for (const tier of TIERS) {
        if (tier === "none") continue;
        const { targetThinking, requestedOutputTokens } =
          calculateReasoningOutputBudget(tier, size);
        if (targetThinking > 0) {
          expect(targetThinking).toBeLessThan(requestedOutputTokens);
        }
      }
    }
  });

  it("reconciles thinking budget against clamped output and disables thinking if below 1024", () => {
    // Clamped output of 1,400 with targetThinking 3,072
    const reconciled = reconcileThinkingBudget(1400, 3072, "high", "claude-3-7-sonnet");
    expect(reconciled.thinkingEnabled).toBe(false);
    expect(reconciled.finalThinkingBudget).toBe(0);
    expect(reconciled.providerOptions).toEqual({
      anthropic: { thinking: { type: "disabled" } },
    });

    // Adequate output of 16,000 with targetThinking 8,000
    const reconciledOk = reconcileThinkingBudget(16000, 8000, "medium", "claude-3-7-sonnet");
    expect(reconciledOk.thinkingEnabled).toBe(true);
    expect(reconciledOk.finalThinkingBudget).toBe(8000);
    expect(reconciledOk.finalThinkingBudget).toBeLessThan(16000);
    expect(reconciledOk.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ai/__tests__/reasoning.test.ts --maxWorkers=1`  
Expected: FAIL — `calculateReasoningOutputBudget` and `reconcileThinkingBudget` are not exported.

- [ ] **Step 3: Implement `calculateReasoningOutputBudget` & `reconcileThinkingBudget`**

In `src/lib/ai/reasoning.ts`:
1. Expand `ReasoningEffortTier` to include `"none"`.
2. Define `TARGET_THINKING_BUDGETS: Record<ReasoningEffortTier, number>`.
3. Implement `calculateReasoningOutputBudget`:
   - `modelMax = modelMaxOutput && modelMaxOutput > 0 ? modelMaxOutput : 16_384`
   - `responseFloor = Math.max(1_000, Math.min(4_000, Math.floor(modelMax * 0.25)))`
   - `maxThinking = Math.max(0, modelMax - responseFloor)`
   - `targetThinking = Math.min(TARGET_THINKING_BUDGETS[effort], maxThinking)`
   - `noneOutput = Math.min(4_000, modelMax)`
   - `requestedOutputTokens = Math.min(modelMax, Math.max(noneOutput, targetThinking + responseFloor))`
4. Implement `reconcileThinkingBudget`:
   - Minimum threshold: `MIN_THINKING_BUDGET = 1_024`
   - `clampedFloor = Math.max(1_000, Math.min(4_000, Math.floor(effectiveMaxOutputTokens * 0.25)))`
   - `reconciledThinking = Math.min(targetThinking, Math.max(0, effectiveMaxOutputTokens - clampedFloor))`
   - If `tier === "none"` or `reconciledThinking < MIN_THINKING_BUDGET`: disable thinking.
   - Return `{ finalThinkingBudget, thinkingEnabled, providerOptions }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/ai/__tests__/reasoning.test.ts --maxWorkers=1`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/reasoning.ts src/lib/ai/__tests__/reasoning.test.ts
git commit -m "feat(reasoning): add monotonic output budget calculation and post-clamp thinking reconciliation"
```

---

### Task 2: Dynamic Context Budget Calculation with Clamped Output

**Files:**
- Modify: `src/lib/ai/context-budget.ts`
- Test: `src/lib/ai/__tests__/context-budget.test.ts`

**Interfaces:**
- Consumes: `calculateReasoningOutputBudget` from Task 1
- Produces:
  ```ts
  export function calculateContextTokenBudget(options: {
    contextWindow: number | null | undefined;
    requestedOutputTokens: number;
    systemAndToolsTokens?: number;
  }): {
    budgetTokens: number;
    effectiveMaxOutputTokens: number;
    isFallback: boolean;
    effectiveWindow: number;
  };
  ```

- [ ] **Step 1: Write the failing test**

Add unit tests in `src/lib/ai/__tests__/context-budget.test.ts` for dynamic budgeting and proportional clamping:

```ts
import { calculateContextTokenBudget } from "../context-budget";

describe("calculateContextTokenBudget", () => {
  const WINDOWS = [4_000, 8_000, 16_000, 24_000, 32_000, 64_000, 128_000, 400_000, 1_000_000];

  it("strictly guarantees budgetTokens + effectiveMaxOutputTokens + systemAndTools <= effectiveWindow", () => {
    for (const w of WINDOWS) {
      for (const reqOutput of [2_000, 4_000, 8_000, 16_000, 32_000, 64_000]) {
        const res = calculateContextTokenBudget({
          contextWindow: w,
          requestedOutputTokens: reqOutput,
          systemAndToolsTokens: 4_000,
        });
        const total = res.budgetTokens + res.effectiveMaxOutputTokens + 4_000;
        expect(total).toBeLessThanOrEqual(res.effectiveWindow);
        expect(res.budgetTokens).toBeGreaterThanOrEqual(1_000);
      }
    }
  });

  it("falls back to conservative 24k window when contextWindow is null or 0 (honest unknown)", () => {
    const res = calculateContextTokenBudget({
      contextWindow: null,
      requestedOutputTokens: 4_000,
    });
    expect(res.isFallback).toBe(true);
    expect(res.effectiveWindow).toBe(24_000);
  });

  it("clamps effectiveMaxOutputTokens proportionally on small context windows", () => {
    const res = calculateContextTokenBudget({
      contextWindow: 16_000,
      requestedOutputTokens: 64_000,
      systemAndToolsTokens: 4_000,
    });
    expect(res.effectiveMaxOutputTokens).toBeLessThan(16_000);
    expect(res.effectiveMaxOutputTokens).toBe(5_600); // 35% of 16k
    expect(res.budgetTokens).toBe(7_200); // 16k - 5600 - 3200
    expect(res.budgetTokens + res.effectiveMaxOutputTokens + 3_200).toBe(16_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ai/__tests__/context-budget.test.ts --maxWorkers=1`  
Expected: FAIL — `calculateContextTokenBudget` not found.

- [ ] **Step 3: Implement `calculateContextTokenBudget`**

In `src/lib/ai/context-budget.ts`:
1. Check `contextWindow`: if `null`, `<= 0`, or undefined $\rightarrow$ `effectiveWindow = 24_000`, `isFallback = true`; else `effectiveWindow = contextWindow`, `isFallback = false`.
2. Measure `systemAndTools = options.systemAndToolsTokens ?? 4_000`.
3. Check clamping condition: `effectiveWindow <= 32_000 || options.requestedOutputTokens + systemAndTools > effectiveWindow * 0.5`.
4. If clamping:
   - `effectiveMaxOutputTokens = Math.min(options.requestedOutputTokens, Math.max(1_000, Math.floor(effectiveWindow * 0.35)))`
   - `effectiveSystem = Math.min(systemAndTools, Math.floor(effectiveWindow * 0.20))`
   - `budgetTokens = Math.max(1_000, effectiveWindow - effectiveMaxOutputTokens - effectiveSystem)`
5. If not clamping:
   - `effectiveMaxOutputTokens = options.requestedOutputTokens`
   - `effectiveSystem = systemAndTools`
   - `budgetTokens = effectiveWindow - effectiveMaxOutputTokens - effectiveSystem`
6. Return `{ budgetTokens, effectiveMaxOutputTokens, isFallback, effectiveWindow }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/ai/__tests__/context-budget.test.ts --maxWorkers=1`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/context-budget.ts src/lib/ai/__tests__/context-budget.test.ts
git commit -m "feat(context-budget): add dynamic context budgeting with proportional output clamping"
```

---

### Task 3: Tool Atomicity & Hierarchical Rollup Auto-Compaction

**Files:**
- Modify: `src/lib/ai/context-budget.ts`
- Test: `src/lib/ai/__tests__/context-budget.test.ts`

**Interfaces:**
- Consumes: `calculateContextTokenBudget`
- Produces:
  ```ts
  export function compactAndPruneMessages(
    messages: UIMessage[],
    budgetTokens: number
  ): PruneResult;
  ```

- [ ] **Step 1: Write the failing test**

In `src/lib/ai/__tests__/context-budget.test.ts`:
1. Test that `compactAndPruneMessages` preserves tool-call and tool-result atomicity (never splits between a tool call and its result).
2. Test that dropping messages produces a `[Conversation Summary: ...]` block.
3. Test hierarchical rollup: when dropped messages contain an existing summary, it rolls it up and caps the summary text to $\le 1,500$ tokens (~6,000 characters).

```ts
it("preserves tool-call and tool-result atomicity across the pruning boundary", () => {
  const toolCallMsg: UIMessage = {
    id: "a1",
    role: "assistant",
    parts: [{ type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "test" } } as any],
  };
  const toolResultMsg: UIMessage = {
    id: "u2",
    role: "user",
    parts: [{ type: "tool-result", toolCallId: "c1", toolName: "search", output: { result: "ok" } } as any],
  };
  const recentUser: UIMessage = {
    id: "u3",
    role: "user",
    parts: [{ type: "text", text: "latest question" }],
  };

  const messages = [msg("user", "very old ".repeat(500)), toolCallMsg, toolResultMsg, recentUser];
  const res = compactAndPruneMessages(messages, 400);

  // If toolCall is dropped, toolResult must also be dropped; or both kept
  const hasCall = res.messages.some((m) => m.id === "a1");
  const hasResult = res.messages.some((m) => m.id === "u2");
  expect(hasCall).toBe(hasResult);
});

it("caps hierarchical summary to 1500 tokens across successive compactions", () => {
  const messagesWithExistingSummary: UIMessage[] = [
    msg("user", "[Conversation Summary:\n- Old point 1\n- Old point 2]\n\nFollow-up question"),
    msg("assistant", "Response ".repeat(300)),
    msg("user", "New question ".repeat(300)),
  ];
  const res = compactAndPruneMessages(messagesWithExistingSummary, 300);
  const text = (res.messages[0].parts[0] as { text: string }).text;
  expect(text).toContain("[Conversation Summary:");
  expect(text.length).toBeLessThan(6000); // 1500 tokens * 4 chars
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ai/__tests__/context-budget.test.ts --maxWorkers=1`  
Expected: FAIL — `compactAndPruneMessages` not defined.

- [ ] **Step 3: Implement `compactAndPruneMessages`**

In `src/lib/ai/context-budget.ts`:
1. Implement tool pair grouping:
   - When traversing backwards, identify tool calls and tool results by `toolCallId`.
   - Ensure a cut boundary never separates an assistant message containing a `tool-call` from the user message containing its `tool-result`.
2. Extract dropped text and detect existing `[Conversation Summary: ...]`.
3. Deterministically extract bullet points: user intents, key queries, and files mentioned.
4. Truncate/roll up summary if length exceeds 6,000 chars (1,500 tokens).
5. Inject `[Conversation Summary:\n...]` into the first kept user message.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/ai/__tests__/context-budget.test.ts --maxWorkers=1`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/context-budget.ts src/lib/ai/__tests__/context-budget.test.ts
git commit -m "feat(context-budget): implement tool-atomic pruning and bounded hierarchical auto-compaction"
```

---

### Task 4: Server Chat Route Pipeline Integration

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Test: `src/app/api/__tests__/chat-registry.test.ts`

**Interfaces:**
- Consumes:
  - `calculateReasoningOutputBudget` & `reconcileThinkingBudget` from `src/lib/ai/reasoning.ts`
  - `calculateContextTokenBudget` & `compactAndPruneMessages` from `src/lib/ai/context-budget.ts`
- Produces: `POST /api/chat` unified pipeline execution.

- [ ] **Step 1: Write the failing test**

In `src/app/api/__tests__/chat-registry.test.ts`, add an integration test:

```ts
it("computes dynamic context budget from model capabilities and avoids premature truncation for large models", async () => {
  // Model has 400,000 contextWindow
  const longMessages: UIMessage[] = [];
  for (let i = 0; i < 30; i++) {
    longMessages.push({
      id: `u-${i}`,
      role: "user",
      parts: [{ type: "text", text: `User query ${i} `.repeat(50) }],
    });
    longMessages.push({
      id: `a-${i}`,
      role: "assistant",
      parts: [{ type: "text", text: `Assistant reply ${i} `.repeat(50) }],
    });
  }

  const res = await POST(
    chatReq({
      messages: longMessages,
      model: "server::ps/poolside/laguna-s-2.1", // 400k context
    })
  );
  expect(res.status).not.toBe(500);
});
```

- [ ] **Step 2: Run test to verify current state**

Run: `npx vitest run src/app/api/__tests__/chat-registry.test.ts --maxWorkers=1`  

- [ ] **Step 3: Integrate pipeline in `src/app/api/chat/route.ts`**

Reorder `POST /api/chat`:
1. Step 1: Resolve model entry (`ModelEntry`) and provider up front.
2. Step 2: `const { targetThinking, requestedOutputTokens } = calculateReasoningOutputBudget(effort, modelEntry.capabilities.maxOutputTokens)`.
3. Step 3: Measure `systemAndToolsTokens = estimateTokens(fullSystemPrompt.length) + 2000`.
4. Step 4: `const { budgetTokens, effectiveMaxOutputTokens } = calculateContextTokenBudget({ contextWindow: modelEntry.capabilities.contextWindow, requestedOutputTokens, systemAndToolsTokens })`.
5. Step 5: `const { providerOptions } = reconcileThinkingBudget(effectiveMaxOutputTokens, targetThinking, effort, resolvedModelId)`.
6. Step 6: `const { messages: budgetedMessages, droppedCount } = compactAndPruneMessages(processedMessages, budgetTokens)`.
7. Step 7: Pass `maxOutputTokens: effectiveMaxOutputTokens` and `providerOptions` to `streamText`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/__tests__/chat-registry.test.ts --maxWorkers=1`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/chat/route.ts src/app/api/__tests__/chat-registry.test.ts
git commit -m "refactor(chat): reorder pipeline to dynamically size context budget and reconcile reasoning output"
```

---

### Task 5: Client-Side Context Gauge & Model-Switching Recalculation

**Files:**
- Modify: `src/components/chat/ChatArea.tsx`
- Test: `src/components/__tests__/chat-selector.test.tsx`

**Interfaces:**
- Consumes: `useRegisteredModels()`, `activeModelInfo.capabilities.contextWindow`, `activeModelInfo.capabilities.maxOutputTokens`.
- Produces: Dynamically recalculating gauge percentage and context tooltip.

- [ ] **Step 1: Write the failing test**

In `src/components/__tests__/chat-selector.test.tsx`:

```ts
it("recalculates context limit dynamically when switching from a 32k model to a 400k model", () => {
  const { rerender } = render(
    <ChatArea
      chatId="chat-1"
      initialMessages={[]}
      model="server::small-model" // 32k
      onSelectModel={vi.fn()}
      onSettled={() => {}}
    />
  );
  expect(screen.getByText(/Window 32K/i)).toBeInTheDocument();

  rerender(
    <ChatArea
      chatId="chat-1"
      initialMessages={[]}
      model="server::ps/poolside/laguna-s-2.1" // 400k
      onSelectModel={vi.fn()}
      onSettled={() => {}}
    />
  );
  expect(screen.getByText(/Window 400K/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/chat-selector.test.tsx --maxWorkers=1`  

- [ ] **Step 3: Update `ChatArea.tsx` & model mock**

In `src/components/chat/ChatArea.tsx`:
- Ensure `maxContextTokens` updates on `model` change from `activeModelInfo?.capabilities?.contextWindow`.
- Ensure output cap shows `formatTokenCount(maxOutputTokens)` when defined.
- Update test fixture in `chat-selector.test.tsx` with explicit model capabilities.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/chat-selector.test.tsx --maxWorkers=1`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/ChatArea.tsx src/components/__tests__/chat-selector.test.tsx
git commit -m "feat(ui): dynamically recalculate context window and output limits on model switch"
```

---

### Task 6: Full Verification and Cleanup

**Files:**
- Run all test suites
- Run typecheck

- [ ] **Step 1: Run complete test suite sequentially**

Run: `npx vitest run --maxWorkers=1`  
Expected: 108+ test files pass (100% green).

- [ ] **Step 2: Run TypeScript compiler**

Run: `npx tsc --noEmit`  
Expected: 0 errors.

- [ ] **Step 3: Commit any minor cleanup**

```bash
git status
```
