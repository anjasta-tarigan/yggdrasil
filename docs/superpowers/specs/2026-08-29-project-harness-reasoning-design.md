# Architectural Specification: Project Harness Agent, System Reasoning & AI SDK v7 Tool Alignment

**Date:** 2026-08-29  
**Status:** Approved (Refined)  
**Authors:** Anjasta Bagus Tarigan & Yggdrasil Cognitive Architecture Team  

---

## 1. Executive Summary

This specification establishes the architecture for:
1. **Full-Stack Project Harness Chat & Workspace Execution**: An autonomous coding agent scoped to user-authorized project directories (`src/components/projects-view.tsx`, `src/lib/project-service.ts`, `src/app/api/projects/chat/route.ts`).
2. **System-Wide Reasoning & `<think>` Streaming Engine**: Auto-detection of reasoning capabilities with an `xhigh` effort default and a fallback cascade (`high` / `medium` / `low` / token budgets), paired with a stateful streaming lookahead transformer for `<think>...</think>` tags and unified `<Reasoning>` / `<ChainOfThought>` UI elements.
3. **AI SDK v7 Tool & Harness Standard Alignment**: Integration of `projectBash`, `projectWriteFile`, `projectReadFile`, `projectListFiles`, `manage_tasks`, `create_artifact`, and sandbox `bash` with process group cancellation (`req.signal` + process group `SIGTERM`/`SIGKILL`), UTF-8 `StringDecoder` boundary protection, and session persistence.

---

## 2. Reasoning Engine & Stream Transformation

### 2.1 Auto-Detect & Fallback Strategy (`xhigh` Default)

Different AI providers and model architectures use divergent protocols for reasoning/extended thinking:
- **OpenAI o-Series (`o1`, `o3`, `o3-mini`, `o1-mini`)**:
  - API accepts `reasoningEffort: "low" | "medium" | "high"`.
  - When the requested level is `"xhigh"`, the engine maps it to `"high"` (the maximum supported OpenAI tier).
- **Anthropic Claude 3.7 Sonnet (Extended Thinking)**:
  - API accepts `thinking: { type: "enabled", budgetTokens: number }`.
  - Tier mapping:
    - `"xhigh"` $\to$ `budgetTokens: 16000` (up to max `32000`)
    - `"high"` $\to$ `budgetTokens: 8000`
    - `"medium"` $\to$ `budgetTokens: 4000`
    - `"low"` $\to$ `budgetTokens: 2048`
- **Open-Weight Models (DeepSeek-R1, Qwen-2.5-Coder-R1 on vLLM / Ollama / LMStudio)**:
  - If the endpoint accepts `chat_template_kwargs: { thinking: true }` or `reasoning_effort`, passes it through; otherwise allows the model to output `<think>...</think>` tokens naturally for the stream transformer.
- **Graceful Degradation**:
  - If a model does not support any reasoning parameters, provider options fall back to standard generation without throwing runtime errors or failing requests.

### 2.2 Lookahead Stream Transformer for `<think>` Tags

Streaming `<think>` and `</think>` tags across network chunk boundaries requires a lookahead buffer to avoid leaking partial tag fragments (e.g. chunk 1 ends with `</th` and chunk 2 starts with `ink>`).

```
Chunk Stream ──► [ 8-Char Lookahead Buffer ]
                        │
         ┌──────────────┴──────────────┐
         ▼                             ▼
   Inside <think>?               Outside <think>?
         │                             │
   Emit { type: "reasoning" }    Emit { type: "text" }
```

- **Lookahead Buffer & State Machine**:
  - Maintains `insideThink: boolean` and `buffer: string` (max lookahead window: 8 characters, covering `</think>`).
  - When encountering `<` or `</`, buffering pauses emission until the tag name resolves:
    - If `<think>` is matched $\to$ transitions `insideThink = true`, discards the tag literal, and flushes accumulated characters as reasoning.
    - If `</think>` is matched $\to$ transitions `insideThink = false`, discards the tag literal, and flushes subsequent characters as text.
    - If the buffer does not match a think tag $\to$ flushes buffered characters according to the current `insideThink` state.
- **Stream Termination & Error Fallback**:
  - On stream end or abort, any remaining buffered text is flushed immediately.
  - If a model produces unclosed `<think>` tags (e.g. truncated due to output limits), remaining text is safely emitted as reasoning rather than dropped.

---

## 3. Project Harness Chat & Execution Security

### 3.1 Honest Security Model & Defense-in-Depth

The Project Harness allows autonomous full-stack development (running builds, running tests, inspecting source code, and applying edits). Because absolute containment of arbitrary shell commands within a host directory requires full VM/container virtualization, Yggdrasil implements a 4-tier defense-in-depth model:

1. **User Authorization Gate (Trust Barrier)**:
   - Projects default to `trusted: false`.
   - The UI displays an amber alert and requires explicit confirmation in the Project Trust Dialog before any tool execution is enabled.
2. **Strict Environment Scoping (Rule 06)**:
   - `safeEnv` provides only clean standard variables (`PATH`, `HOME=projectDir`, `USER=sandbox`, `SHELL=/bin/bash`, `LANG=en_US.UTF-8`, `TERM=dumb`).
   - Server secrets (`LLM_API_KEY`, search tokens, internal envs) are completely stripped.
3. **Process Group Tree Lifecycle Management**:
   - `spawn` runs bash in a dedicated process group (`detached: true`).
   - When a client aborts (`req.signal`) or the command hits `COMMAND_TIMEOUT_MS` (60s):
     - Sends `process.kill(-child.pid, "SIGTERM")` to the entire process group.
     - Sets a 2000ms grace period timer; if processes remain alive, escalates to `process.kill(-child.pid, "SIGKILL")`.
4. **Symlink Boundary & Path Resolution (Rule 06 / TOCTOU Defense)**:
   - `validateAndResolveProjectPath` validates both lexical and canonical paths:
     - Lexical check: `resolved.startsWith(normalizedRoot + path.sep)`.
     - Canonical realpath check: If file or parent exists, resolves `fs.realpathSync` to ensure symbolic links cannot point outside the project directory.
     - For writes (`projectWriteFile`), parent directories are created first, canonical paths are verified, and writes target the validated resolved path.
5. **Speed Bumps**:
   - Pre-execution regex filtering blocks catastrophic patterns (`sudo`, `rm -rf /`, `mkfs`, raw `/dev/` writes, system shutdown, world-writable root).

### 3.2 Backend Endpoint (`/api/projects/chat`)
- Multi-turn autonomous tool loop with its own loop policy (see §3.4).
- Guaranteed `chatActiveTracker` cleanup via `safeEndChatTracking()` across `onEnd`, `onError`, `toUIMessageStream({ onError })`, and root `try/catch`.
- Comprehensive tool suite: `projectBash`, `projectWriteFile`, `projectReadFile`, `projectListFiles`, `manage_tasks`, `create_artifact`, `web_search`, `fetch_page`.

### 3.3 Frontend Interactive Harness UI (`projects-view.tsx`)
- **Reasoning**: Collapsible `<Reasoning>` cards with live timer duration, auto-open during streaming, and streamdown KaTeX math support.
- **Terminal**: Custom `<Terminal>` component for `projectBash` displaying live command strings, exit status pills, stdout/stderr streams, and output truncation notices.
- **Task Checklist**: Interactive `<Task>` cards for `manage_tasks`.
- **Artifacts**: `<ArtifactChip>` chips that open interactive HTML/React deliverables in the side drawer.
- **Session Management**: Full project session switcher with batched message loading and live generation cancellation (`stop()`).

### 3.4 Loop Policy

The harness owns its loop policy in `src/lib/ai/harness-loop.ts` — a single source of truth used only by the Projects route:

- **Step cap:** `HARNESS_MAX_STEPS = 60` (this supersedes the earlier "30 steps" figure). `createHarnessStopConditions()` returns only `isStepCount(HARNESS_MAX_STEPS)`; the harness has no `ask_user_question` tool, so chat's second stop condition does not apply.
- **No tool withholding, no temperature change:** `createHarnessPrepareStep()` returns `{}` on every step before the last. `bash` stays in the active tool set for the whole run because the Verification Gate needs it.
- **Forced wrap-up:** on the final permitted step (`stepNumber === HARNESS_MAX_STEPS - 1`) the policy sets `toolChoice: "none"` and appends a wrap-up instruction, so a capped run reports status instead of ending silently mid-task.
- **Timeouts (`HARNESS_TIMEOUT`):** `totalMs` 20 min, `stepMs` 3 min, `firstChunkMs` 90 s, `chunkMs` 60 s, `toolMs` 2 min, `tools.bashMs` 5 min. The tool's own `HARNESS_BASH_TIMEOUT_MS` (4 min) must stay strictly below the SDK `bash` timeout so the model gets a structured tool result rather than an SDK-level abort. Invariants: `totalMs > stepMs > firstChunkMs` and `tools.bashMs > HARNESS_BASH_TIMEOUT_MS > 60_000`.
- **Trust status:** the synthesized system prompt states the workspace trust status (`trusted` vs `NOT trusted`), and in the untrusted case tells the model which tools are disabled and to stop after read-only analysis.
- **Model guard:** the route rejects a model whose registry capability `supportsToolCalls === false` with a 400 — a chat-only model would silently degrade the harness into the assistant it replaces.

**Why the chat loop policy must not be reused:** the chat policy is tuned for short conversational turns (15-step cap, `bash` withheld after step 5, temperature drop, an `ask_user_question` stop condition). Applied to the harness it teaches the model to under-work and cuts the loop off mid-task — the exact regression (C1) this section exists to prevent. Keep harness policy in `harness-loop.ts`; the ESLint config restricts `@/lib/ai/prepare-step` and `@/lib/ai/termination-conditions` imports under `src/app/api/projects/**` and `src/lib/project-*.ts` to enforce it.

#### Context guard (`src/lib/ai/harness-context.ts`)

**Why:** compaction (`compactAndPruneMessages`) runs **only at request start** and used to fill history to the entire budget, leaving no headroom. Inside a single `streamText` run (up to 60 steps) every tool result is appended to the prompt on every step and nothing prunes it, so a handful of large results per step overflows the window and the provider rejects the request. The guard degrades gracefully instead: elide stale tool output first, force a status-report wrap-up last.

Constants (single source of truth):

| Constant | Value | Meaning |
| --- | --- | --- |
| `HARNESS_HISTORY_BUDGET_RATIO` | `0.6` | request-start history may use at most this share of the budget, leaving headroom for the run |
| `HARNESS_ELIDE_TRIGGER_RATIO` | `0.8` | start eliding stale tool output above this share |
| `HARNESS_ELIDE_TARGET_RATIO` | `0.55` | elide until at or below this share (hysteresis: the guard does not fire every step, which bounds prompt-cache churn) |
| `HARNESS_CONTEXT_WRAPUP_RATIO` | `0.95` | if still above this after eliding, force a wrap-up |
| `HARNESS_KEEP_RECENT_TOOL_ROUNDS` | `4` | the newest tool rounds are never touched |
| `HARNESS_MIN_ELIDE_TOKENS` | `200` | outputs smaller than this are not worth eliding |

The ladder, evaluated per step by `evaluateContextGuard`:

1. `none` — estimate at or below 80% of the budget: the prompt is sent unchanged.
2. `elide` — above 80%: replace the `output` of completed `tool-result` parts, oldest rounds first, with a short stub (`[tool output elided to save context: ~N tokens. Re-run the tool if you still need it.]`) until at or below 55%. Cheap win first: `pruneMessages({ reasoning: "before-last-message", toolCalls: "none", emptyMessages: "keep" })` drops old reasoning parts without touching tool calls.
3. `wrap-up` — still above 95% at `stepNumber > 0`: set `toolChoice: "none"` and append the context wrap-up instruction so the model reports status instead of overflowing. Step 0 never wraps up (there is no history to prune yet).

**Elision never removes a call/result pair.** Only the `output` field of a `tool-result` part is replaced; tool-call and tool-result parts are always retained, so every call id keeps a matching result and no provider sees an orphaned pair. `execution-denied` outputs, approval request/response parts, pending calls, user messages and assistant text are never touched, and the operation is idempotent (a stubbed output is below the minimum, so a second pass is a no-op). Because a `prepareStep` `messages` override carries forward, elision is cumulative and already-elided outputs are never re-processed.

The request-start budget for the harness is `HARNESS_HISTORY_BUDGET_RATIO` of the normal budget (via the exported `harnessHistoryBudget(budgetTokens)` helper), so client and server agree on the headroom the run needs.

---

## 4. Testing & Verification Strategy

### 4.1 Test Targets & Scenarios
1. **Security & Sandbox (`src/lib/__tests__/project-service.test.ts`)**:
   - Path traversal rejection on relative paths (`../../etc`).
   - Symlink jail breakout rejection on symlinks pointing outside workspace (`ln -s /etc ./keys`).
   - Process group termination and timeout escalation (`SIGTERM` $\to$ `SIGKILL`).
   - UTF-8 `StringDecoder` multibyte character preservation across split buffer chunks.
2. **Reasoning & Stream Transformation (`src/lib/ai/__tests__/provider.test.ts`, `src/app/api/__tests__/projects-chat-api.test.ts`)**:
   - Lookahead buffer correctly extracts `<think>...</think>` tags across multi-chunk boundaries.
   - Unclosed `<think>` tag fallback on stream abort.
   - Provider options mapping from `xhigh` to OpenAI `high` and Anthropic `budgetTokens`.
3. **Harness API & UI (`src/app/api/__tests__/projects-chat-api.test.ts`, `src/components/__tests__/projects-view.test.tsx`)**:
   - Multi-step tool execution with `manage_tasks`, `projectBash`, and `create_artifact`.
   - `chatActiveTracker` release verification on stream errors.
   - Session switching without stale message closures.

### 4.2 Quality & Regression Gates
- 100% pass rate across all 47+ existing test suites.
- Strict adherence to Rule 01 (DRY), Rule 02 (No Silent Errors), Rule 06 (Isolation), and Rule 12 (N+1 Prevention).
