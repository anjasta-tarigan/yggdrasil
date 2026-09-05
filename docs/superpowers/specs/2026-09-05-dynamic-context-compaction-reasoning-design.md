# Dynamic Context Window Budgeting, Auto-Compaction, and Reasoning-Aware Output Specs

**Date:** 2026-09-05  
**Status:** Approved Design (Revised from Deep Review)  
**Scope:** Server-side context budgeting, conversation auto-compaction and summary, reasoning effort output budgets, client-side model-switching context recalculation.

---

## 1. Problem Statement

1. **Static 24k Context Budget**: `src/app/api/chat/route.ts` runs `pruneMessagesToTokenBudget(processedMessages)` before model resolution, always defaulting to a hardcoded `24_000` tokens regardless of model capacity. Models supporting 128k, 200k, 400k (e.g. `laguna-s-2.1`), or 1M tokens are prematurely truncated after a few dozen messages.
2. **Context Loss on Truncation**: When messages are dropped, valuable conversation history, decisions, and instructions are discarded, replaced only by a disclaimer note: `[Context note: X earlier messages were truncated...]`.
3. **Reasoning Token Starvation & Budget Collision**:
   - Models supporting reasoning/thinking (DeepSeek-R1, OpenAI o1/o3, Claude Thinking, Laguna, Qwen-Thinking) produce both internal reasoning tokens and response tokens within the same `maxOutputTokens` ceiling.
   - If thinking budget equals or approaches `maxOutputTokens`, the model exhausts tokens during thinking and cuts off with zero response tokens (or hits Anthropic's hard rejection: `budget_tokens` must be `< max_tokens`).
   - If context-budgeting calculates output reserve independently from reasoning output calculation, large-context models under-reserve for output and cause context window overflow.
4. **Tool Atomicity During Pruning**: Splitting message history naively on user-turn boundaries can orphan `tool_use` and `tool_result` sequences across multi-step turns, causing upstream provider rejections.
5. **Model Switching Real-Time Recalculation**: When switching between models (e.g. 32k vs 400k/1M), the client context gauge updates, but the server pipeline was previously ignoring the selected model's capacity during truncation.

---

## 2. Architecture & Design

### 2.1 Unified Shared Pipeline & Execution Order

In `src/app/api/chat/route.ts`, model resolution and reasoning budget calculation must precede context budgeting:

```
Step 1: Resolve Target Model (ModelEntry + capabilities)
Step 2: Calculate Reasoning-Aware Output Budget (maxOutputTokens + thinkingBudget)
Step 3: Measure System Prompt & Tool Schema Token Footprint
Step 4: Compute Dynamic Message Budget (guaranteeing budget + output + tools <= contextWindow)
Step 5: Compact & Prune Messages to Dynamic Budget (preserving tool atomicity & summary)
Step 6: Stream with Synchronized Parameters (maxOutputTokens, providerOptions, budgetedMessages)
```

By making Step 2 the Single Source of Truth for output allocation, context budgeting (Step 4) never guesses or diverges from the real output cap passed to `streamText`.

---

### 2.2 Reasoning-Aware Output Budgeting (`calculateReasoningOutputBudget`)

Located in `src/lib/ai/reasoning.ts`:

#### Structural Headroom Invariant
Thinking budget and response tokens are structurally linked:
$$\text{maxOutputTokens} = \text{thinkingBudget} + \text{responseFloor}$$

- `responseFloor`: Minimum tokens guaranteed for the visible completion (default `4_000` tokens, or up to `8_000` for deep answers).
- `thinkingBudget` is always strictly less than `maxOutputTokens`, satisfying Anthropic, OpenAI, and open-weights constraints.

#### Tier Allocation Formula
Given `modelMaxOutput` (from `capabilities.maxOutputTokens ?? 16_384`), `contextWindow`, and `effort`:

| Tier | Target Thinking Budget | Guaranteed Response Floor | Effective `maxOutputTokens` |
| :--- | :--- | :--- | :--- |
| **`xhigh`** | $\min(32_000, \lfloor \text{modelMaxOutput} \times 0.75 \rfloor)$ | $\max(8_000, \lfloor \text{modelMaxOutput} \times 0.25 \rfloor)$ | $\text{thinking} + \text{floor}$ (capped by `modelMaxOutput`) |
| **`high`** | $\min(16_000, \lfloor \text{modelMaxOutput} \times 0.65 \rfloor)$ | $\max(6_000, \lfloor \text{modelMaxOutput} \times 0.35 \rfloor)$ | $\text{thinking} + \text{floor}$ (capped by `modelMaxOutput`) |
| **`medium`**| $\min(8_000, \lfloor \text{modelMaxOutput} \times 0.50 \rfloor)$  | $\max(4_000, \lfloor \text{modelMaxOutput} \times 0.50 \rfloor)$ | $\text{thinking} + \text{floor}$ (capped by `modelMaxOutput`) |
| **`low`**   | $\min(2_000, \lfloor \text{modelMaxOutput} \times 0.30 \rfloor)$  | $\max(3_000, \lfloor \text{modelMaxOutput} \times 0.70 \rfloor)$ | $\text{thinking} + \text{floor}$ (capped by `modelMaxOutput`) |
| **`none`**  | $0$ | $\text{modelMaxOutput}$ | $\min(8_000, \text{modelMaxOutput})$ |

For Anthropic provider options: `thinking: { type: "enabled", budgetTokens: thinkingBudget }`.  
For OpenAI provider options: `reasoningEffort: tier === "xhigh" ? "high" : tier`.  
The calculated `maxOutputTokens` is returned directly to be passed to `streamText({ maxOutputTokens })`.

---

### 2.3 Dynamic Model-Aware Context Budgeting (`calculateContextTokenBudget`)

Located in `src/lib/ai/context-budget.ts`:

#### Function Signature
```ts
export function calculateContextTokenBudget(options: {
  contextWindow: number | null | undefined;
  maxOutputTokens: number;
  systemAndToolsTokens?: number;
}): {
  budgetTokens: number;
  isFallback: boolean;
  effectiveWindow: number;
};
```

#### Invariant: Zero Overlap / Zero Overflow
$$\text{budgetTokens} + \text{maxOutputTokens} + \text{systemAndToolsTokens} \le \text{effectiveWindow}$$

1. **Honest Unknown Handling (SSoT Principle)**:
   - When `contextWindow` is `null` or `<= 0` (unprobed/unknown), do **NOT** assume 128k.
   - Fall back to safe conservative baseline: `effectiveWindow = 24_000` with `isFallback = true`.
   - Log diagnostic warning: `[context-budget] contextWindow unknown for model; defaulting to safe 24k window`.
2. **Measured System and Tool Footprint**:
   - Instead of a magic 4k constant, measure actual prompt tokens:
     ```ts
     const systemAndToolsTokens = options.systemAndToolsTokens ?? 4_000;
     ```
3. **Proportional Clamping for Small Models**:
   - If `effectiveWindow` is small (e.g. $\le 16_000$), clamp reserves proportionally:
     $$\text{clampedOutput} = \min(\text{maxOutputTokens}, \lfloor \text{effectiveWindow} \times 0.40 \rfloor)$$
     $$\text{clampedSystem} = \min(\text{systemAndToolsTokens}, \lfloor \text{effectiveWindow} \times 0.25 \rfloor)$$
     $$\text{budgetTokens} = \max(1_000, \text{effectiveWindow} - \text{clampedOutput} - \text{clampedSystem})$$
4. **Large Models (128k, 400k, 1M)**:
   - Uses exact `maxOutputTokens` from Step 2 without artificial caps.
   - Example: 1,000,000 window, 128,000 output, 6,000 system+tools:
     $$\text{budgetTokens} = 1_000_000 - 128_000 - 6_000 = 866_000 \text{ tokens}$$
   - Example: 400,000 window (Laguna S 2.1), 32,768 output, 6,000 tools:
     $$\text{budgetTokens} = 400_000 - 32_768 - 6_000 = 361_232 \text{ tokens}$$

---

### 2.4 Auto-Compaction & Incremental Summarization Engine

#### Tool Atomicity Preservation
During truncation, messages are traversed in reverse to select the kept slice:
1. **Clean Turn & Tool Sequence Boundary**:
   - The kept slice **must start on a user message** that is not part of a pending tool resolution.
   - Tool calls (`tool-call` / `tool_use`) and their corresponding tool results (`tool-result` / `tool_result`) are treated as **inseparable atomic units**. A slice boundary can never fall between a tool call and its result.
   - Any dangling tool results with dropped parent calls are pruned out via `ignoreIncompleteToolCalls: true` in `convertToModelMessages`.

#### Summary Bounding & Hierarchical Rollup
1. **Compaction Trigger**:
   - Triggered when total conversation tokens exceed `budgetTokens`.
2. **Summary Length Cap**:
   - Maximum summary length: **1,500 tokens** (~6,000 characters).
3. **Hierarchical Rollup**:
   - When dropped messages contain an existing `[Conversation Summary: ...]`, extract the prior summary.
   - If `priorSummary + newDropped` exceeds 1,500 tokens, rollup summarizes:
     *"Previous Summary: <prior> + New events: <newDropped> -> New compact summary under 1,500 tokens"*.
   - Prevents summary bloat from consuming conversation budget over 50+ turns.

#### Latency & Critical Path Strategy
1. **Synchronous Fast Extractive Summary**:
   - To prevent blocking the user's stream with a slow LLM round-trip, the immediate turn extracts high-signal anchors (user intents, constraints, files discussed, and prior summary bullets) deterministically (< 5ms).
2. **Background Memory Consolidation Integration**:
   - The background queue (`sleep_consolidation` / `reflect_turn`) handles deep semantic memory extraction asynchronously without blocking chat response time.
3. **Injected Format**:
   ```markdown
   [Conversation Memory / Context Summary:
   - Scope: Developing Next.js 16 app Yggdrasil
   - Decisions: SQLite with WAL, AI SDK v7, provider-config SSoT
   - Rules: Strict typing, surgical diffs, no dead code]
   ```

---

### 2.5 Client-Side Real-Time Recalculation

In `src/components/chat/ChatArea.tsx`:
1. **Dynamic Capacity Binding**:
   - `maxContextTokens` binds to `activeModelInfo?.capabilities?.contextWindow ?? FALLBACK_CONTEXT_TOKENS`.
   - `maxOutputTokens` binds to `activeModelInfo?.capabilities?.maxOutputTokens ?? null`.
2. **Instant Re-rendering on Model Switch**:
   - When user switches from Model A (32k) to Model B (400k):
     - Meter percentage updates instantly (`usedTokens / maxContextTokens`).
     - State transitions seamlessly: 20k tokens changes from 62% (amber) to 5% (green).
3. **Qualified Wire Ref**:
   - Request passes qualified `providerId::modelId` so server resolves the exact same capability record.

---

## 3. Test & Verification Plan

1. **`src/lib/ai/__tests__/context-budget.test.ts`**:
   - Unit test: large context window (1M, 400k) budgets 80%+ without arbitrary 24k cap.
   - Unit test: small context window (4k, 8k, 16k) clamps reserves proportionally so sum never exceeds window.
   - Unit test: unknown/null contextWindow defaults to safe conservative 24k window (with `isFallback = true`).
   - Unit test: tool atomicity ensures no orphaned tool results in kept slice.
   - Unit test: hierarchical rollup bounds summary to <= 1,500 tokens across multiple compactions.
2. **`src/lib/ai/__tests__/reasoning.test.ts`**:
   - Unit test: `thinkingBudget < maxOutputTokens` invariant holds across all effort tiers (`xhigh`, `high`, `medium`, `low`).
   - Unit test: guaranteed response floor is never zero, preventing response cut-off.
   - Unit test: `calculateContextTokenBudget` takes reasoning-aware output budget and yields `budgetTokens + maxOutput + tools <= window`.
3. **`src/app/api/__tests__/chat-registry.test.ts`**:
   - Integration test: large model receives large context budget; chat does not log premature truncation.
4. **Sequential Test Execution**:
   - Run Vitest suites sequentially (`--maxWorkers=1` per Rule 18).
   - Run `npx tsc --noEmit`.
