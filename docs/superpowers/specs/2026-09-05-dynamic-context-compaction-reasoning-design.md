# Dynamic Context Window Budgeting, Auto-Compaction, and Reasoning-Aware Output Specs

**Date:** 2026-09-05  
**Status:** Approved Design  
**Scope:** Server-side context budgeting, conversation auto-compaction and summary, reasoning effort output budgets, client-side model-switching context recalculation.

---

## 1. Problem Statement

1. **Static 24k Context Budget**: `src/app/api/chat/route.ts` runs `pruneMessagesToTokenBudget(processedMessages)` before model resolution, always defaulting to a hardcoded `24_000` tokens regardless of model capacity. Models supporting 128k, 200k, 400k (e.g. `laguna-s-2.1`), or 1M tokens are prematurely truncated after a few dozen messages.
2. **Context Loss on Truncation**: When messages are dropped, valuable conversation history, decisions, and instructions are discarded, replaced only by a disclaimer note: `[Context note: X earlier messages were truncated...]`.
3. **Reasoning Token Starvation**: Models supporting reasoning/thinking (DeepSeek-R1, OpenAI o1/o3, Claude Thinking, Laguna, Qwen-Thinking) generate both reasoning tokens and response tokens against the same `maxOutputTokens` ceiling. If the ceiling is too low, reasoning burns the entire budget and the model cuts off mid-answer.
4. **Model Switching Real-Time Recalculation**: When switching between a 32k model and a 400k/1M model, the client context gauge updates, but the server pipeline was ignoring the selected model's capacity during truncation.

---

## 2. Architecture & Design

### 2.1 Server-Side Dynamic Model-Aware Context Budgeting

In `src/app/api/chat/route.ts`:
1. Model resolution occurs **first** before message context pruning:
   - Decode model ref (`providerId::modelId`) or look up registry default model.
   - Extract `capabilities.contextWindow` and `capabilities.maxOutputTokens`.
2. Compute dynamic budget `budgetTokens`:
   ```ts
   export function calculateContextTokenBudget(
     contextWindow: number | null | undefined,
     maxOutputTokens: number | null | undefined
   ): number {
     const windowSize = contextWindow && contextWindow > 0 ? contextWindow : 128_000;
     // Headroom reserves space for system prompt, tool schemas, and model output
     const outputReserve = Math.max(
       4_000,
       Math.min(maxOutputTokens ?? 8_000, 32_000)
     );
     const systemAndToolsReserve = 4_000;
     const totalReserve = Math.min(
       Math.max(outputReserve + systemAndToolsReserve, Math.floor(windowSize * 0.2)),
       64_000
     );
     return Math.max(4_000, windowSize - totalReserve);
   }
   ```
3. Pass computed `budgetTokens` into context pruning.

### 2.2 Auto-Compaction & Incremental Summarization (Option A)

When `messages` exceed `budgetTokens`:
1. `pruneMessagesToTokenBudget` splits messages into:
   - `dropped`: messages that do not fit in the window.
   - `kept`: messages that fit within the budget starting on a clean user-turn boundary.
2. An async summarizer `compactDroppedMessages(dropped, model)` generates a compact summary:
   - Extracts existing `[Conversation Summary: ...]` if earlier compactions already occurred.
   - Summarizes newly dropped turns via concise LLM generation (`generateText` with low temperature).
   - If LLM summarization fails or times out, falls back to deterministic extraction of key user queries and bullet points.
3. Injects the summary at the beginning of the first kept user message:
   ```markdown
   [Conversation Summary:
   - Topic: Developing Next.js 16 app Yggdrasil
   - Key User Preferences: Strict types, surgical diffs, no dead code
   - Core Decisions: SQLite with WAL, AI SDK v7, provider-config SSoT]
   ```

### 2.3 Reasoning-Aware Output Budgeting (`maxOutputTokens`)

In `src/lib/ai/reasoning.ts`:
1. Provide a helper `calculateReasoningOutputBudget(effort, modelMaxOutput)`:
   - `xhigh`: thinking budget ~16k–32k; `maxOutputTokens` scaled to `Math.max(32_000, modelMaxOutput ?? 32_768)`.
   - `high`: thinking budget ~8k–16k; `maxOutputTokens` scaled to `Math.max(16_000, modelMaxOutput ?? 16_384)`.
   - `medium`: thinking budget ~4k–8k; `maxOutputTokens` scaled to `Math.max(8_000, modelMaxOutput ?? 8_192)`.
   - `low` / `minimal`: thinking budget ~1k–2k; `maxOutputTokens` scaled to `Math.max(4_000, modelMaxOutput ?? 4_096)`.
   - `none`: standard completion limit without thinking budget.
2. In `src/app/api/chat/route.ts`:
   - Pass `maxOutputTokens` to `streamText` along with `providerOptions: getReasoningProviderOptions(...)`.
   - Ensures thinking phase cannot starve response generation.

### 2.4 Client-Side Model-Switching Recalculation

In `src/components/chat/ChatArea.tsx`:
1. Context indicator reads `activeModelInfo?.capabilities?.contextWindow`.
2. When model changes:
   - `maxContextTokens` updates dynamically (e.g. 32,768 vs 128,000 vs 400,000 vs 1,000,000).
   - `usedTokens / maxContextTokens` percentage updates instantly.
   - Tooltip displays accurate model capacity and output cap.
3. Server receives qualified model ref (`providerId::modelId`), resolving the identical capacity for pruning and output budgets.

---

## 3. Implementation Steps

1. **`src/lib/ai/context-budget.ts`**:
   - Implement `calculateContextTokenBudget`.
   - Implement `compactAndPruneMessages` with auto-compaction and summary injection.
   - Add unit tests for dynamic budgeting, compact summary retention, and fallbacks.
2. **`src/lib/ai/reasoning.ts`**:
   - Implement `calculateReasoningOutputBudget` for reasoning-aware `maxOutputTokens`.
   - Unit tests covering reasoning effort tiers and output limits.
3. **`src/app/api/chat/route.ts`**:
   - Reorder model resolution to precede context pruning.
   - Compute dynamic context budget and pass to `compactAndPruneMessages`.
   - Apply reasoning-aware `maxOutputTokens` to `streamText`.
4. **`src/components/chat/ChatArea.tsx`**:
   - Verify context meter and tooltip dynamically reflect model capabilities on switch.
   - Add/update UI tests in `chat-selector.test.tsx`.
5. **Full Verification**:
   - Run tests sequentially per Rule 18.
   - Run `npx tsc --noEmit`.
