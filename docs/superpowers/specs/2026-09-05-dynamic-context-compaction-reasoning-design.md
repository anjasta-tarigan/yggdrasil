# Dynamic Context Window Budgeting, Auto-Compaction, and Reasoning-Aware Output Specs

**Date:** 2026-09-05  
**Status:** Approved Design (Revision 2 — Fully Monotonic & Structurally Clamped)  
**Scope:** Server-side context budgeting, conversation auto-compaction and summary, reasoning effort output budgets, client-side model-switching context recalculation.

---

## 1. Problem Statement

1. **Static 24k Context Budget**: `src/app/api/chat/route.ts` runs `pruneMessagesToTokenBudget(processedMessages)` before model resolution, always defaulting to a hardcoded `24_000` tokens regardless of model capacity. Models supporting 128k, 200k, 400k (e.g. `laguna-s-2.1`), or 1M tokens are prematurely truncated after a few dozen messages.
2. **Context Loss on Truncation**: When messages are dropped, valuable conversation history, decisions, and instructions are discarded, replaced only by a disclaimer note: `[Context note: X earlier messages were truncated...]`.
3. **Reasoning Token Starvation & Budget Collision**:
   - Models supporting reasoning/thinking (DeepSeek-R1, OpenAI o1/o3, Claude Thinking, Laguna, Qwen-Thinking) produce both internal reasoning tokens and response tokens within the same `maxOutputTokens` ceiling.
   - If thinking budget equals or approaches `maxOutputTokens`, the model exhausts tokens during thinking and cuts off with zero response tokens (or hits Anthropic's hard rejection: `budget_tokens` must be `< max_tokens`).
   - If output allocation across effort tiers is non-monotonic, lower effort tiers can inadvertently request more tokens than higher tiers.
4. **Small-Context Window Clamping**: If context budgeting clamps output internally for small context windows without feeding that clamped limit forward to `streamText`, the provider call overflows the model's actual physical window.
5. **Tool Atomicity During Pruning**: Splitting message history naively on user-turn boundaries can orphan `tool_use` and `tool_result` sequences across multi-step turns, causing upstream provider rejections.
6. **Model Switching Real-Time Recalculation**: When switching between models (e.g. 32k vs 400k/1M), the client context gauge updates, but the server pipeline was ignoring the selected model's capacity during truncation.

---

## 2. Architecture & Design

### 2.1 Unified Shared Pipeline & Execution Order

In `src/app/api/chat/route.ts`, the pipeline guarantees that the exact parameters sent to `streamText` are the single source of truth used for context budgeting:

```
Step 1: Resolve Target Model (ModelEntry + capabilities)
Step 2: Calculate Reasoning Output Allocation (thinkingBudget, requestedOutputTokens)
Step 3: Measure System Prompt & Tool Schema Token Footprint
Step 4: Compute Dynamic Message Budget & Clamped Effective Output:
        calculateContextTokenBudget(...) -> { budgetTokens, effectiveMaxOutputTokens }
Step 5: Compact & Prune Messages to budgetTokens (preserving tool atomicity & summary)
Step 6: Stream with Synchronized Parameters:
        streamText({
          model,
          messages: budgetedMessages,
          maxOutputTokens: effectiveMaxOutputTokens, // Clamped value strictly matching Step 4
          providerOptions
        })
```

---

### 2.2 Reasoning-Aware Output Budgeting (`calculateReasoningOutputBudget`)

Located in `src/lib/ai/reasoning.ts`:

#### Invariant 1: Structural Headroom (`thinkingBudget < maxOutputTokens`)
For any tier where thinking is enabled, `maxOutputTokens` is structurally derived by adding a fixed guaranteed response floor on top of the thinking budget:
$$\text{requestedOutputTokens} = \min(\text{modelMaxOutput}, \text{thinkingBudget} + \text{responseFloor})$$

Where `responseFloor` is an effort-invariant floor (default `4_000` tokens, or `min(4_000, modelMaxOutput * 0.25)` if model output capacity is very tight).

#### Invariant 2: Strict Monotonicity Across Tiers
Reasoning effort strictly increases or maintains output budget as effort scales up:
$$\text{effort}(\text{xhigh}) \ge \text{effort}(\text{high}) \ge \text{effort}(\text{medium}) \ge \text{effort}(\text{low}) \ge \text{effort}(\text{none})$$

#### Monotonic Allocation Formula
Given `modelMaxOutput` (from `capabilities.maxOutputTokens ?? 16_384`) and `effort`:

| Tier | Target Thinking Budget | Guaranteed Response Floor | Effective Output Request |
| :--- | :--- | :--- | :--- |
| **`xhigh`** | $\min(32_000, \lfloor \text{modelMaxOutput} \times 0.75 \rfloor)$ | $\max(4_000, \lfloor \text{modelMaxOutput} \times 0.25 \rfloor)$ | $\min(\text{modelMaxOutput}, \text{thinking} + \text{floor})$ |
| **`high`** | $\min(16_000, \lfloor \text{modelMaxOutput} \times 0.60 \rfloor)$ | $\max(4_000, \lfloor \text{modelMaxOutput} \times 0.25 \rfloor)$ | $\min(\text{modelMaxOutput}, \text{thinking} + \text{floor})$ |
| **`medium`**| $\min(8_000, \lfloor \text{modelMaxOutput} \times 0.40 \rfloor)$  | $\max(4_000, \lfloor \text{modelMaxOutput} \times 0.25 \rfloor)$ | $\min(\text{modelMaxOutput}, \text{thinking} + \text{floor})$ |
| **`low`**   | $\min(2_000, \lfloor \text{modelMaxOutput} \times 0.20 \rfloor)$  | $\max(2_000, \lfloor \text{modelMaxOutput} \times 0.25 \rfloor)$ | $\min(\text{modelMaxOutput}, \text{thinking} + \text{floor})$ |
| **`none`**  | $0$ (thinking disabled) | N/A | $\min(8_000, \text{modelMaxOutput})$ |

*Proof of monotonicity with `modelMaxOutput = 128,000`:*
- `xhigh`: thinking = 32,000, floor = 32,000 $\rightarrow$ **64,000**
- `high`: thinking = 16,000, floor = 32,000 $\rightarrow$ **48,000**
- `medium`: thinking = 8,000, floor = 32,000 $\rightarrow$ **40,000**
- `low`: thinking = 2,000, floor = 32,000 $\rightarrow$ **34,000**
- `none`: thinking = 0 $\rightarrow$ **8,000**
Monotonicity strictly holds: $64\text{k} > 48\text{k} > 40\text{k} > 34\text{k} > 8\text{k}$.

Provider options passed:
- Anthropic: `thinking: { type: "enabled", budgetTokens: thinkingBudget }`
- OpenAI / vLLM / Open-weights: `reasoningEffort: tier === "xhigh" ? "high" : tier`

---

### 2.3 Dynamic Context Budgeting with Clamped Output (`calculateContextTokenBudget`)

Located in `src/lib/ai/context-budget.ts`:

#### Function Signature
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

#### Invariant: Zero Overlap / Zero Overflow Under All Window Sizes
$$\text{budgetTokens} + \text{effectiveMaxOutputTokens} + \text{systemAndToolsTokens} \le \text{effectiveWindow}$$

1. **Honest Unknown Handling (SSoT Principle)**:
   - When `contextWindow` is `null` or `<= 0`, do **NOT** assume 128k.
   - Fall back to safe conservative baseline: `effectiveWindow = 24_000` with `isFallback = true`.
   - Log diagnostic warning: `[context-budget] contextWindow unknown for model; defaulting to safe 24k window`.
2. **Measured System and Tool Footprint**:
   - Accepts measured tokens from system prompt and serialized tool schemas:
     ```ts
     const systemAndToolsTokens = options.systemAndToolsTokens ?? 4_000;
     ```
3. **Small-Model Clamping (Clamped Output Returned for `streamText`)**:
   - If `effectiveWindow` is small (e.g. $\le 32_000$ or if requested output + tools exceeds 50% of the window):
     $$\text{effectiveMaxOutputTokens} = \min(\text{options.requestedOutputTokens}, \lfloor \text{effectiveWindow} \times 0.35 \rfloor)$$
     $$\text{effectiveSystem} = \min(\text{systemAndToolsTokens}, \lfloor \text{effectiveWindow} \times 0.20 \rfloor)$$
     $$\text{budgetTokens} = \max(1_000, \text{effectiveWindow} - \text{effectiveMaxOutputTokens} - \text{effectiveSystem})$$
   - Crucially, `effectiveMaxOutputTokens` is returned to caller and passed to `streamText({ maxOutputTokens: effectiveMaxOutputTokens })` in Step 6.
   - *Example with 16k window and 64k requested output:*
     - `effectiveMaxOutputTokens = min(64000, 16000 * 0.35) = 5,600`
     - `effectiveSystem = min(4000, 16000 * 0.20) = 3,200`
     - `budgetTokens = 16000 - 5600 - 3200 = 7,200`
     - Verification: $7,200 + 5,600 + 3,200 = 16,000 \le 16,000$. The window never overflows.
4. **Large Models (128k, 400k, 1M)**:
   - For windows where `requestedOutputTokens + systemAndToolsTokens < effectiveWindow * 0.5`:
     $$\text{effectiveMaxOutputTokens} = \text{options.requestedOutputTokens}$$
     $$\text{budgetTokens} = \text{effectiveWindow} - \text{effectiveMaxOutputTokens} - \text{systemAndToolsTokens}$$
   - *Example (Laguna S 2.1 — 400k window, 64k output, 6k system/tools):*
     - `effectiveMaxOutputTokens = 64,000`
     - `budgetTokens = 400,000 - 64,000 - 6,000 = 330,000`

---

### 2.4 Auto-Compaction & Incremental Summarization Engine

#### Tool Atomicity Preservation
During truncation, messages are traversed in reverse to select the kept slice:
1. **Clean Turn & Tool Sequence Boundary**:
   - The kept slice **must start on a user message** that is not part of an in-flight tool call sequence.
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
   - Executed synchronously on the request critical path in $< 5\text{ms}$ (deterministic extraction of user goals, key constraints, files modified, and recent decisions).
2. **Background Semantic Consolidation**:
   - Asynchronous memory consolidation (`sleep_consolidation` daemon / `executeTurnReflection`) extracts long-term episodic and semantic knowledge into SQLite/vector memory without blocking the live streaming turn.
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

1. **`src/lib/ai/__tests__/reasoning.test.ts`**:
   - Monotonicity test across all effort tiers (`xhigh > high > medium > low > none`).
   - `thinkingBudget < maxOutputTokens` holds strictly for all reasoning tiers.
   - Floor guarantee verification (response floor is never zero or negative).
2. **`src/lib/ai/__tests__/context-budget.test.ts`**:
   - Invariant test: `budgetTokens + effectiveMaxOutputTokens + systemAndToolsTokens <= effectiveWindow` across wide range of windows (4k, 8k, 16k, 32k, 128k, 400k, 1M).
   - Small window clamp test: verifies `effectiveMaxOutputTokens` is clamped and that the returned budget plus clamped output fits the small window.
   - Unknown/null contextWindow fallback test (falls back to 24k with `isFallback = true`).
   - Tool atomicity test: tool-calls and tool-results are never separated across the pruning boundary.
   - Hierarchical rollup test: verifies compaction summary never exceeds 1,500 tokens across successive compactions.
3. **`src/app/api/__tests__/chat-registry.test.ts`**:
   - Integration test verifying dynamic budget and clamped output are passed to `streamText`.
4. **Sequential Test Execution**:
   - Run Vitest suites sequentially (`--maxWorkers=1` per Rule 18).
   - Run `npx tsc --noEmit`.
