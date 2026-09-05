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

In `src/app/api/chat/route.ts`, the pipeline guarantees that the exact parameters sent to `streamText` are the single source of truth used for context budgeting, with an explicit cross-boundary reconciliation step:

```
Step 1: Resolve Target Model (ModelEntry + capabilities)
Step 2: Calculate Initial Reasoning Output Allocation:
        calculateReasoningOutputBudget(effort, modelMaxOutput) -> { targetThinking, requestedOutputTokens }
Step 3: Measure System Prompt & Tool Schema Token Footprint (measured prompt tokens)
Step 4: Compute Dynamic Message Budget & Clamped Effective Output:
        calculateContextTokenBudget(contextWindow, requestedOutputTokens, systemAndToolsTokens)
        -> { budgetTokens, effectiveMaxOutputTokens, isFallback, effectiveWindow }
Step 5: Reconcile Thinking Budget against Effective Output:
        reconcileThinkingBudget(effectiveMaxOutputTokens, targetThinking)
        -> { finalThinkingBudget, thinkingEnabled, providerOptions }
        Guarantees: finalThinkingBudget < effectiveMaxOutputTokens, and if finalThinkingBudget < 1024,
        disables thinking cleanly ({ type: "disabled" }) to satisfy provider minimum thresholds.
Step 6: Compact & Prune Messages to budgetTokens (preserving tool atomicity & summary)
Step 7: Stream with Synchronized Parameters:
        streamText({
          model,
          messages: budgetedMessages,
          maxOutputTokens: effectiveMaxOutputTokens,
          providerOptions
        })
```

---

### 2.2 Reasoning-Aware Output Budgeting (`calculateReasoningOutputBudget` & `reconcileThinkingBudget`)

Located in `src/lib/ai/reasoning.ts`:

#### Invariant 1: Structural Response Floor (`thinkingBudget < effectiveMaxOutputTokens`)
For any tier where thinking is enabled, output tokens are structurally derived to guarantee an unconstrained visible completion response floor:
$$\text{responseFloor} = \max(1_000, \min(4_000, \lfloor \text{modelMaxOutput} \times 0.25 \rfloor))$$
$$\text{maxAllowableThinking} = \max(0, \text{modelMaxOutput} - \text{responseFloor})$$
$$\text{targetThinking} = \min(\text{tierThinking}[\text{tier}], \text{maxAllowableThinking})$$

#### Invariant 2: Universal Monotonicity Across All Model Capacities
Reasoning effort strictly increases or maintains total output budget as effort scales up:
$$\text{output}(\text{none}) \le \text{output}(\text{low}) \le \text{output}(\text{medium}) \le \text{output}(\text{high}) \le \text{output}(\text{xhigh})$$

For the `none` tier (thinking disabled):
$$\text{noneOutput} = \min(4_000, \text{modelMaxOutput})$$

For reasoning tiers (`low`, `medium`, `high`, `xhigh`), effective output is guaranteed to equal or exceed `noneOutput`:
$$\text{requestedOutputTokens} = \min(\text{modelMaxOutput}, \max(\text{noneOutput}, \text{targetThinking} + \text{responseFloor}))$$

#### Target Thinking Limits per Tier
- `xhigh`: target thinking = 32,000
- `high`: target thinking = 16,000
- `medium`: target thinking = 8,000
- `low`: target thinking = 2,000
- `none`: target thinking = 0

#### Invariant 3: Post-Clamping Reconciliation & Minimum Threshold (`reconcileThinkingBudget`)
When Step 4's proportional clamping reduces `effectiveMaxOutputTokens` below `requestedOutputTokens`, the thinking budget is reconciled against the new ceiling:
$$\text{clampedFloor} = \max(1_000, \min(4_000, \lfloor \text{effectiveMaxOutputTokens} \times 0.25 \rfloor))$$
$$\text{reconciledThinking} = \min(\text{targetThinking}, \max(0, \text{effectiveMaxOutputTokens} - \text{clampedFloor}))$$

**Minimum Threshold Guard**:
Providers such as Anthropic require a minimum thinking budget ($\ge 1_024$ tokens).
- If $\text{reconciledThinking} < 1_024$ or tier is `none`:
  - `thinkingEnabled = false`
  - `finalThinkingBudget = 0`
  - Anthropic: `thinking: { type: "disabled" }`
  - OpenAI / vLLM: `reasoningEffort: "low"` or omitted
- If $\text{reconciledThinking} \ge 1_024$:
  - `thinkingEnabled = true`
  - `finalThinkingBudget = reconciledThinking`
  - Anthropic: `thinking: { type: "enabled", budgetTokens: finalThinkingBudget }`
  - OpenAI / vLLM: `reasoningEffort: tier === "xhigh" ? "high" : tier`

This guarantees that:
1. `finalThinkingBudget < effectiveMaxOutputTokens` strictly holds under every context clamp.
2. No provider receives an invalid sub-minimum budget (e.g. `budget_tokens: 0` with `type: "enabled"`).

#### Mathematical Verification Across Output Sizes

1. **Default model capacity (`modelMaxOutput = 16,384` — standard fallback)**:
   - `responseFloor`: $\max(1000, \min(4000, 4096)) = 4,000$
   - `maxAllowableThinking`: $16,384 - 4,000 = 12,384$
   - `none`: thinking = 0, output = **4,000**
   - `low`: thinking = 2,000, output = $\min(16384, \max(4000, 2000 + 4000)) =$ **6,000**
   - `medium`: thinking = 8,000, output = $\min(16384, \max(4000, 8000 + 4000)) =$ **12,000**
   - `high`: thinking = 12,384 (clamped to max), output = $12,384 + 4,000 =$ **16,384**
   - `xhigh`: thinking = 12,384 (clamped to max), output = $12,384 + 4,000 =$ **16,384**
   - Monotonicity holds: $4,000 \le 6,000 \le 12,000 \le 16,384 \le 16,384$.
   - Thinking headroom holds: $2000 < 6000$, $8000 < 12000$, $12384 < 16384$.

2. **Large model capacity (`modelMaxOutput = 128,000`)**:
   - `responseFloor`: $4,000$
   - `none`: output = **4,000**
   - `low`: thinking = 2,000, output = **6,000**
   - `medium`: thinking = 8,000, output = **12,000**
   - `high`: thinking = 16,000, output = **20,000**
   - `xhigh`: thinking = 32,000, output = **36,000**
   - Monotonicity holds: $4,000 \le 6,000 \le 12,000 \le 20,000 \le 36,000$.

3. **Small model capacity (`modelMaxOutput = 4,096`)**:
   - `responseFloor`: $\max(1000, \min(4000, 1024)) = 1,024$
   - `maxAllowableThinking`: $4,096 - 1,024 = 3,072$
   - `none`: output = **4,000**
   - `low`: thinking = 2,000, output = $\min(4096, \max(4000, 2000 + 1024)) =$ **4,000**
   - `medium`: thinking = 3,072 (clamped), output = **4,096**
   - `high`: thinking = 3,072 (clamped), output = **4,096**
   - `xhigh`: thinking = 3,072 (clamped), output = **4,096**
   - Monotonicity holds: $4,000 \le 4,000 \le 4,096 \le 4,096 \le 4,096$.

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
3. **Proportional Output Clamping (Clamped Output Returned for `streamText`)**:
   - Trigger condition: `effectiveWindow <= 32_000` OR `requestedOutputTokens + systemAndToolsTokens > effectiveWindow * 0.5`.
     $$\text{effectiveMaxOutputTokens} = \min(\text{options.requestedOutputTokens}, \max(1_000, \lfloor \text{effectiveWindow} \times 0.35 \rfloor))$$
     $$\text{effectiveSystem} = \min(\text{systemAndToolsTokens}, \lfloor \text{effectiveWindow} \times 0.20 \rfloor)$$
     $$\text{budgetTokens} = \max(1_000, \text{effectiveWindow} - \text{effectiveMaxOutputTokens} - \text{effectiveSystem})$$
   - Crucially, `effectiveMaxOutputTokens` is returned to caller, used for Step 5 thinking reconciliation, and passed to `streamText({ maxOutputTokens: effectiveMaxOutputTokens })` in Step 7.
   - *Example with 16k window and 64k requested output:*
     - `effectiveMaxOutputTokens = min(64000, 16000 * 0.35) = 5,600`
     - `effectiveSystem = min(4000, 16000 * 0.20) = 3,200`
     - `budgetTokens = 16000 - 5600 - 3200 = 7,200`
     - Verification: $7,200 + 5,600 + 3,200 = 16,000 \le 16,000$. The window never overflows.
   - *Example with 4,000 window, modelMaxOutput 4,096, tier high:*
     - `requestedOutputTokens = 4,096`, `targetThinking = 3,072`
     - `effectiveMaxOutputTokens = min(4096, max(1000, 4000 * 0.35)) = 1,400`
     - `effectiveSystem = min(4000, 4000 * 0.20) = 800`
     - `budgetTokens = 4000 - 1400 - 800 = 1,800`
     - Step 5 Reconcile: `clampedFloor = max(1000, min(4000, 1400 * 0.25)) = 1,000`. `maxThinking = 1400 - 1000 = 400`. Since $400 < 1024$ minimum threshold, thinking is disabled (`thinkingEnabled = false`, `thinkingBudget = 0`).
     - Result: `maxOutputTokens = 1,400`, `thinking: { type: "disabled" }`. Anthropic API accepts the request without error!
4. **Large Models (128k, 400k, 1M)**:
   - For windows where `requestedOutputTokens + systemAndToolsTokens <= effectiveWindow * 0.5`:
     $$\text{effectiveMaxOutputTokens} = \text{options.requestedOutputTokens}$$
     $$\text{budgetTokens} = \text{effectiveWindow} - \text{effectiveMaxOutputTokens} - \text{systemAndToolsTokens}$$
   - *Example (Laguna S 2.1 — 400k window, 36k output, 6k system/tools):*
     - `effectiveMaxOutputTokens = 36,000`
     - `budgetTokens = 400,000 - 36,000 - 6,000 = 358,000`
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
   - Parameterized monotonicity test across all effort tiers (`none <= low <= medium <= high <= xhigh`) sweeping `modelMaxOutput` across `[500, 1000, 2048, 4096, 8192, 16384, 32768, 65536, 128000, 1000000]`.
   - Structural headroom test: `thinkingBudget < effectiveMaxOutputTokens` holds strictly for all reasoning tiers where thinking is enabled, across the entire swept capacity range.
   - Response floor test: visible completion floor is never zero or negative.
   - Threshold guard test: verifies `reconcileThinkingBudget` disables thinking (`{ type: "disabled" }`, `budget = 0`) if thinking budget drops below 1,024 tokens.
2. **`src/lib/ai/__tests__/context-budget.test.ts`**:
   - Parameterized invariant test: `budgetTokens + effectiveMaxOutputTokens + systemAndToolsTokens <= effectiveWindow` across wide range of windows (`[4k, 8k, 16k, 32k, 128k, 400k, 1M]`).
   - Proportional output clamp test: verifies `effectiveMaxOutputTokens` is clamped proportionally and that the returned budget plus clamped output fits the small window.
   - Unknown/null contextWindow fallback test: falls back to conservative 24k window with `isFallback = true`.
   - Tool atomicity test: tool-calls and tool-results are never separated across the pruning boundary.
   - Hierarchical rollup test: verifies compaction summary never exceeds 1,500 tokens across successive compactions.
3. **Cross-Boundary Integration Tests (`src/app/api/__tests__/chat-registry.test.ts`)**:
   - Integration test sweeping Cartesian product of `contextWindow` × `modelMaxOutput` × `reasoningTier`:
     - Verifies `thinkingBudget < effectiveMaxOutputTokens` holds *after* context window clamping.
     - Verifies `total (budget + output + tools) <= contextWindow` holds for every case.
     - Verifies no sub-minimum thinking budget (< 1024) is ever passed as `enabled`.
4. **Sequential Test Execution**:
   - Run Vitest suites sequentially (`--maxWorkers=1` per Rule 18).
   - Run `npx tsc --noEmit`.
