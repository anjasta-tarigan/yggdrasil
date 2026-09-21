# Architectural Specification: Project Harness as a Durable Coding Harness

**Date:** 2026-09-21
**Status:** Draft (Rev 3 — second review pass applied; pending re-review)
**Author:** Anjasta Bagus Tarigan & Yggdrasil Cognitive Architecture Team
**Supersedes (in part):** `2026-08-29-project-harness-reasoning-design.md`, `2026-09-17-project-workspaces-harness-design.md` §loop policy

---

## 1. Executive Summary

The Project Harness (`POST /api/projects/chat`) is intended to behave like a coding harness such as Claude Code: the user gives one instruction, and the agent works the task to completion. In practice it stops mid-task with no stated reason — observed empirically at ~6 steps when asked to build a landing page.

### 1.1 Root cause (code-read; reproduction pending)

There is **no 6-step limit in the code**. `HARNESS_MAX_STEPS = 60` (`src/lib/ai/harness-loop.ts:38`). The stop was caused by `chunkMs: 60_000`, a watchdog on **the gap between consecutive output chunks**. Verified in `node_modules/ai/dist/index.js`:

- `resetChunkTimeout()` (line 9675) is re-armed on **every** output chunk (called at line 9949, inside `isOutputChunk2(chunk)`).
- `isOutputChunk2` (line 8817) counts `text-delta` and `reasoning-delta` with non-empty text, plus `tool-input-delta`, `file`, `reasoning-file`, `tool-call`.

So the watchdog measures silence between chunks, not cumulative silence. A model that emits **no output chunks at all** for over 60s — e.g. a provider socket that stalls before the first token, or a reasoning model whose thinking is not streamed as `reasoning-delta` — trips it. The step at which that first happened was step ~6. The failure was **silent** because the AI SDK reports a timeout as a stream part `{ type: "abort", reason }`, not as an `error`:

- `onError` never fires for an abort.
- `toUIMessageStream` forwards the abort part; `@ai-sdk/react` ignores abort parts.
- `useChat` returns to `ready` with `error === undefined`.

The working tree already contains the fix (uncommitted): `chunkMs` removed, timeouts raised (`totalMs` 20→60min, `stepMs` 3→10min, `firstChunkMs` 90s→3min), `timeoutAbortToErrorPart()` added, `onAbort` logging added, and regression guards in `harness-loop.test.ts`.

> **Honesty note.** "Verified" here means code reading plus inference from the SDK source, not a reproduction with the watchdog restored. Stage 1 must reproduce the failure once (temporarily set `chunkMs: 60_000`, run the landing-page task, confirm the abort) before the fix is considered proven.

### 1.2 Remaining gap

The timeout fix removes a false-positive kill but does not make Projects a **long-running** harness. The in-process resumable-stream registry (`src/lib/ai/stream-registry.ts`) survives client disconnects but not a server restart, and the durable execution path (`WorkflowAgent` / `workflow@5`) exists in the repository (`src/lib/ai/durable-agents.ts`, `src/workflows/chat-workflow.ts`) but is **unwired** — no route calls it.

### 1.3 What this specification defines

Two stages, delivered in order:

- **Stage 1 — Robust single request.** Commit the existing timeout fix, **reinstating a chunk watchdog at a high value** (§5.5), and make every stop reason observable (natural / step cap / context wrap-up / timeout). No architectural change.
- **Stage 2 — Durable Workflow.** Move the Project Harness turn into Workflow DevKit (Local World, no cloud), expressed as an AI SDK `WorkflowAgent`, so a task survives client disconnect **and** server restart, resumes cleanly, and persists its task list.

The engine decision is **strengthen the native harness** (yggdrasil's own tools, prompt, model registry), **not** delegate to an external runtime (Claude Code/Codex/OpenCode adapters). `HarnessAgent` was evaluated and rejected for this work: the Claude Code and Codex adapters require a network sandbox (`@ai-sdk/sandbox-vercel`), whereas Projects operate on **local disk directories**. See §9 for the considered alternatives.

---

## 2. Scope & Non-Goals

### 2.1 In scope

- Only the Projects feature: `POST /api/projects/chat`, `src/lib/ai/harness-loop.ts`, `src/lib/project-harness-tools.ts`, `src/lib/project-service.ts`, the Projects UI, and the new workflow module.
- Making one task run to completion, observably.
- Durable execution with resume across disconnect and restart.
- Persisting the `manage_tasks` task list so it survives resume.

### 2.2 Non-goals

- **Regular chat behaviour is untouched.** `src/app/api/chat/route.ts`, `src/lib/ai/prepare-step.ts`, `src/lib/ai/termination-conditions.ts`, and `src/lib/ai/context-budget.ts` must not change behaviour. The chat loop policy (15 steps + `ask_user_question`) stays separate. *Boundary is enforced, not assumed:* `harness-loop.ts` is in scope, so any change to a shared export (`createHarnessPrepareStep`) must keep the chat path's behaviour identical, pinned by a test (§6).
- **No external harness runtime.** `HarnessAgent` and the Claude Code / Codex / OpenCode adapters are out of scope (§9.1).
- **No autonomous multi-task backlog.** Accepting a queue of tasks and working them unattended is deferred; this spec only lays the durable task-list foundation for it.
- **No prefixed tools.** Canonical tool names (`bash`, `file_operations`, `manage_tasks`) are preserved. The earlier feature (commit `b0d896d`) was reverted precisely because prefixed tools (`projectBash`, `projectReadFile`) caused tool collision and hallucination.
- **No `abortSignal: req.signal` into the generation call.** This was the cause of premature aborts on tab switch; the stop endpoint remains the only legitimate cancellation path.

---

## 3. Architecture

### 3.1 Two layers (revised)

An earlier draft had three layers, with the turn wrapped in its own `"use step"`. **That was wrong and is removed.** Verified against the `ai@7.0.97` docs and `@ai-sdk/workflow@2.0.28` types:

- A stream **reference** may be passed across the workflow/step boundary; what WDK forbids is calling `getWriter()`/`write()` in workflow context. Every official example calls `agent.stream({ writable: getWritable() })` **directly inside the `"use workflow"` function**.
- `WorkflowAgent` creates its own steps internally: the model call runs in `doStreamStep`, and each tool marked `"use step"` becomes its own durable step.
- Wrapping the whole turn in an outer `"use step"` would **nest** the tool steps inside it — recreating exactly the coarse-step design rejected in §9.3, and collapsing the tool-durability argument in §3.6.

So the design has two layers:

1. **Workflow** — `src/workflows/project-harness-workflow.ts` (`"use workflow"`). Builds the agent, calls `agent.stream({ writable: getWritable() })`, and orchestrates claim/finalise. No domain logic; no Node.js runtime; deterministic.
2. **Domain & tools** — `src/lib/project-harness-tools.ts`, `src/lib/project-service.ts`, `src/lib/ai/project-prompt.ts`, `src/lib/ai/harness-context.ts`. Roles unchanged; the call convention changes (serializable options in, resources rebuilt inside each tool step).

The durable step boundaries come from the agent and its tools — not from a hand-written wrapper. `project-harness-turn.ts` does not exist.

### 3.2 Engine: `WorkflowAgent`

The turn is executed by an AI SDK **`WorkflowAgent`** (`@ai-sdk/workflow@2.0.28`, already installed), not by a hand-rolled `streamText`-in-a-step. The justification is **not** "steps auto-retry 3×" (they do not — see §3.6). It is:

- `WorkflowAgent` handles model-call streaming from within its own step and writes to the run's writable, so the workflow function never touches a stream writer.
- It provides suspension and **signed tool approval** that survive suspension (§3.3).
- It emits `reset-step` on an inner model-call retry so the client discards the failed attempt's partial output instead of duplicating it.
- It turns each tool marked `"use step"` into its own durable step, which is what makes tool side effects resume-safe (§3.6).

**Invariant: `stopWhen` is mandatory, not merely preserved.** `WorkflowAgent` applies **no default step limit** — without `stopWhen` it runs until the model stops calling tools. We pass `stopWhen: isStepCount(HARNESS_MAX_STEPS)`. Omitting it is a runaway-loop bug, not a configuration choice.

The following are preserved as `WorkflowAgent` options. **All were verified against the tree that `WorkflowAgent` actually resolves — `ai@7.0.97`** (not the app's `ai@7.0.77`; see §7.3):

| Preserved capability | Mechanism |
|---|---|
| Step cap (60) — **mandatory** | `stopWhen: isStepCount(HARNESS_MAX_STEPS)` |
| Context guard + wrap-up | `prepareStep` (`createHarnessPrepareStep`) |
| Tool-name & tool-input repair | `repairToolCall` |
| Provider-level retry (inner model call) | `maxRetries` (default 2 — matches today's route) |
| Smooth streaming | `experimental_transform: smoothStream(...)` — **confirmed present** (`dist/index.d.ts:826`) |
| Lifecycle telemetry | `onStepEnd`, `onEnd`, `onToolExecutionStart/End`, `prepareCall` |
| Per-request correlation | `runtimeContext` (must be serializable) |
| Signed tool approval | `experimental_toolApprovalSecret` (§3.3) |
| **Turn timeout** | `timeout?: number` — **a single number, not an object** (§3.7) |

### 3.3 Approval is preserved, not lost (correction)

An earlier draft claimed HMAC approval would be replaced. That was wrong — it was based on the `ai@7.0.77` docs. In `ai@7.0.97`, `WorkflowAgent` accepts `experimental_toolApprovalSecret` **and** `needsApproval` on tools. The mechanism is stricter than the current route:

- The agent HMAC-signs approval ID, tool-call ID, tool name, and validated input. A missing or invalid signature prevents the tool from executing.
- The signature is preserved through the durable model-call stream, `createModelCallToUIChunkTransform()`, `addToolApprovalResponse()`, and `convertToModelMessages()`.
- Only the **environment variable name** is passed into signing/verification steps; each step reads the secret from its local environment. The raw value never enters step arguments, durable stream parts, callbacks, or telemetry.

**Operational requirements (Stage 2 gate, §7.4):** use a high-entropy secret of **at least 32 bytes**; make the same secret available on **every worker** that can issue or resume an approval; and **keep old keys available while approvals signed with them are pending** — rotating the secret invalidates those pending approvals. Key rotation is part of the gate, not an afterthought.

### 3.3.1 `smoothStream` is NOT lost (correction)

A previous revision listed `smoothStream` as the one accepted loss. That is wrong: `WorkflowAgent.stream()` accepts `experimental_transform?: StreamTextTransform | StreamTextTransform[]` (verified, `dist/index.d.ts:826`). The current route's `smoothStream({ chunking: "word", delayInMs: 2 })` carries over unchanged.

**Consequence: there are no accepted capability losses.** §7.3's risk row and §8's open question about a replacement are both deleted.

Approval equivalence is still a **Stage 2 gate** (§7.4), not a monitored risk: the existing `tool-policy.ts` semantics must be re-expressed through `needsApproval`, and the anti-forgery property re-verified, before the durable path is enabled.

### 3.4 Serialization boundary

`"use step"` requires serializable arguments. The following table is the authoritative work list.

| Current (per-request closure) | Durable form |
|---|---|
| `canonicalRoot`, `trusted`, `timeoutMs`, `projectDirectory` | Already serializable — pass as data, rebuild tools inside each **tool step** |
| `maxOutputChars: () => harnessToolOutputChars(budgetTokens)` | Thunk → compute `budgetTokens` inside the tool step, pass the number |
| MCP client (`collectMcpTools()`) | Not serializable → rebuild per tool step (cost budget in §6.2), or defer |
| `approvalSecret` | Passed as an **environment variable name**, never the value (§3.3) |
| `systemPrompt` | Serializable string — may be computed once and passed |
| `budgetTokens`, `providerOptions`, `resolvedEffort` | Serializable — computed before `start()` or inside the workflow |

Rule: **serializable data in, resources rebuilt inside the step.** No live handle (sandbox, DB client, MCP client) is stored in workflow state. Note the boundary: the *workflow function* passes serializable options to `agent.stream()`; the *tool steps* rebuild the resources.

### 3.5 Next.js / Workflow wiring

- Wrap `next.config.ts` with `withWorkflow()` from `workflow/next`.
- No middleware/proxy matcher change is needed: this repository has **no** `src/middleware.ts` or `src/proxy.ts` (verified). If one is added later, `.well-known/workflow/` must be excluded from its matcher.
- Set `WORKFLOW_LOCAL_DATA_DIR=data/workflow` (inside the already-git-ignored `data/`, per Rule 06 — no writes to `$HOME` or a root `.workflow-data/`).
- The Local World is the default outside Vercel and needs no cloud credentials. `recoverActiveRuns` (default `true`) re-enqueues pending/running runs at process start, which is what provides restart resilience.
- **Import pinning (decided):** `WorkflowAgent`, `WorkflowChatTransport`, and `createModelCallToUIChunkTransform` are all imported from **`@ai-sdk/workflow`** — verified, its `exports` map has only `.` and `./video`, so a `/client` subpath does not exist. Do not invent one.

### 3.6 Retry, replay, and tool side effects (the load-bearing section)

This section answers the question the design turns on: **what happens to real filesystem side effects when a run resumes?**

**Three distinct mechanisms, verified in `@ai-sdk/workflow` and `workflow`:**

| Mechanism | Trigger | Granularity | Verified |
|---|---|---|---|
| **Inner model-call retry** | provider error during the model call | inside `doStreamStep`, up to `options.maxRetries` (default 2) | `prepareRetries({ maxRetries })`, dist line 1605 |
| **Step retry on throw** | a step function throws | per step, default 3 (0 for `doStreamStep`) | `doStreamStep.maxRetries = 0`, dist line 496 |
| **Resume** | process died / invocation ended mid-run | replays from the event log; an interrupted step with no recorded completion re-executes | `workflow` docs, `workflows-and-steps` |

Key consequences, written down explicitly:

1. **`maxRetries` is the inner model-call knob, not a step knob.** The runtime already hardcodes `doStreamStep.maxRetries = 0`. We set `maxRetries: 2` (matching today's route) to govern provider retries inside the step. `reset-step` is emitted on those retries and the client discards the failed attempt's partial text/reasoning.
2. **Resume is not retry.** A crash does not "retry" a step; it re-executes it because completion was never recorded. This is why the earlier draft's `maxRetries = 0` did not break restart recovery (concern raised in review) — but it is also why the next point matters.
3. **A re-executed step re-runs its body — including tool calls, unless tools are their own steps.** Therefore **every project harness tool's `execute` is wrapped with `'use step'`** (the pattern already exists in `src/lib/ai/durable-agents.ts` → `durableTool`). Each tool call then becomes a durable step whose completion is recorded, so a resumed turn does not re-apply it. Because the turn is **not** wrapped in an outer step (§3.1), these tool steps are top-level, not nested.
4. **Idempotency position (explicit):** we do **not** attempt to make `bash` or `file_operations` idempotent — that is impossible in general. The position is: *tool calls are recorded as completed steps and are not re-executed on resume.* WDK confirms a step can run more than once if its invocation crashes before reporting, and such a re-run is retried per policy without a visible error in observability — which is exactly why mutating tool steps get `maxRetries = 0`.
5. **Task-list mutations are covered by the same rule.** Because each `manage_tasks` call is its own durable step, a replay does not re-apply it. Writes are still made idempotent by keying on the task `id` (upsert, not blind insert) as defence in depth (§4.3).
6. **Compensation gap (acknowledged).** A crash *mid-`bash`* can leave the directory half-modified, and the run then fails via `FatalError` with no automatic recovery. WDK's guidance is to make rollbacks their own steps. This spec does **not** implement compensation — it records the gap and defers the decision to §8.5. The user sees a failed run with a stated uncertainty rather than a silent partial success.

### 3.7 Timeout and the chunk watchdog on the durable path (correction)

`WorkflowAgent.stream()` accepts `timeout?: number` — **a single number**, not the `HARNESS_TIMEOUT` object. The object's `stepMs`/`firstChunkMs`/`chunkMs`/`toolMs` have **no direct equivalent**. Verified: `dist/index.d.ts:931`.

Therefore the Stage 1 anti-silent guarantee does **not** carry over by configuration. The mapping is:

| `HARNESS_TIMEOUT` field | Durable path |
|---|---|
| `totalMs` | `timeout: HARNESS_TIMEOUT.totalMs` (60 min) — the only directly expressible value |
| `stepMs` | Not available as an option. Effectively unbounded per model call; bounded only by `totalMs`. |
| `firstChunkMs` | Not available. |
| `chunkMs` | Not available. |
| `toolMs` / `tools.bashMs` | Enforced **inside the tool** (the existing `bash` process-group kill, `HARNESS_BASH_TIMEOUT_MS`), which is unaffected. |

**Decision:** the gap watchdog is **reimplemented as a language-model middleware** that wraps the model passed to `WorkflowAgent` and aborts if no output chunk arrives within `chunkMs`. This preserves dead-socket detection. If middleware proves infeasible against the installed SDK, the fallback is to declare the watchdog an **accepted loss on the durable path only** (Stage 1 still has it) and rely on `totalMs` — but that must be an explicit, written decision, not a silent omission. Resolving this is a **Stage 2 gate** (§7.4).

---

## 4. Data & State

### 4.1 Ownership

| State | Owner | Note |
|---|---|---|
| Transcript (`UIMessage[]`) | `project_messages` (SQLite) | Remains the source of truth; converted to `ModelMessage[]` before the agent. The workflow does not keep a canonical copy. |
| Harness resume state (`continueFrom`/`resumeFrom`) | Workflow World (`data/workflow`) | Opaque; persisted and replayed by the World. Do not duplicate into SQLite. |
| Task list (`manage_tasks`) | **`project_tasks` (new)** | Must be durable, or it is lost on resume. |
| Active run per session | `project_sessions.activeRunId` (new column) | Replaces the role of `activeStreamId` for the Projects path. |
| Budget / effort / context guard | Recomputed per step | Not persisted; derived from transcript + model. |

### 4.2 Schema changes (`src/db/schema.ts`, Drizzle + SQLite)

New table:

```ts
export const projectTasks = sqliteTable("project_tasks", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => projectSessions.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("pending"), // pending | in_progress | completed
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("project_tasks_session_position_idx").on(t.sessionId, t.position)]);
```

New column on `project_sessions`:

```ts
activeRunId: text("active_run_id"), // nullable; Projects path only
```

`activeStreamId` is retained for the chat path and the in-process registry. The two must never both be active for one session. Migrations are generated with `drizzle-kit generate`; WAL and `busy_timeout` pragmas already apply to the connection (Rule 15).

### 4.3 Task-list persistence

`manage_tasks` currently uses an in-memory `task_list_manager` (`src/lib/project-harness-tools.ts:16`, exposed `:975`). It is replaced by a DB-backed adapter:

- `createProjectHarnessTools()` accepts a `taskStore` (interface: `list/create/update/delete` scoped to `sessionId`), injected when tools are built **inside each tool step**.
- Mutations are **upserts keyed on task `id`**, so re-application is harmless (§3.6.5).
- The list is read at step start so it survives across steps, resumes, and restarts.
- This is the foundation for the deferred autonomous backlog, without building that now (YAGNI).

### 4.4 Transcript & resume (the persistence path is defined here)

Two concrete decisions, both required because `WorkflowAgent` removed the old convenience:

**(a) Reconnection pattern — corrected.** `WorkflowChatTransport` counts `UIMessageChunk` objects, while the durable `WorkflowAgent` stream stores raw `ModelCallStreamPart` objects. So the GET endpoint must **replay the raw stream from index 0** and apply the non-negative UI cursor in the transform:

```ts
// GET /api/projects/chat/[runId]/stream
const startIndex = Number(new URL(request.url).searchParams.get("startIndex") ?? "0");
if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
  return Response.json({ error: "startIndex must be a non-negative safe integer" }, { status: 400 });
}
const run = await getRun(runId);
const readable = run
  .getReadable({ startIndex: 0 })                          // raw ModelCallStreamPart
  .pipeThrough(createModelCallToUIChunkTransform({ uiStartIndex: startIndex }));
return createUIMessageStreamResponse({ stream: readable, headers: { "x-workflow-run-id": runId } });
```

The previous draft's `getReadable({ startIndex })` + `x-workflow-stream-tail-index` is **wrong for this stream type** and would duplicate or drop chunks. Negative indexes are not usable here.

**(b) Transcript persistence — no built-in path.** `collectUIMessages` is gone, and `stream()` returns `result.messages: ModelMessage[]`. There is **no** `ModelMessage` → `UIMessage` converter, and the SDK docs explicitly warn against treating `result.messages` as the only copy if the conversation must be re-rendered. Decision:

- **Persist from the response boundary**, not from `result.messages`. The `toUIMessageStream({ originalMessages, onEnd })` path used today still produces the final `UIMessage[]`; the finalisation step writes that to `project_messages`. This keeps the current, working server-authoritative save and avoids inventing a converter.
- The workflow's `result.messages` is used only for the stop attribution (finish reason, step count), never as the stored transcript.
- If the boundary save is unreachable in a given failure mode, the run is marked failed and the transcript is left at its last saved state — the user sees a stated failure, not a silently truncated conversation.

**Consequences:** for the Projects path, `publishStream`/`attachStream`/TTL-sweeper are no longer used **when the durable path is active**. During the flag transition they are still used by the fallback path (§7.2). `chatActiveTracker` (GPU protection) moves into the workflow's finalisation step, not the route.

### 4.5 Single-run lock (claim happens in the route)

The claim **must happen in the route, before `start()`** — the response has already begun streaming by the time the workflow body runs, so a claim inside the workflow would surface as an in-stream error rather than an HTTP 409. Order:

1. Route runs the conditional `UPDATE ... SET active_run_id = ? WHERE id = ? AND active_run_id IS NULL`.
2. If it affects 0 rows → **HTTP 409** (before any stream is created).
3. Only then `start(projectHarnessWorkflow, [input])` and return the stream.
4. The workflow **releases** `activeRunId` in its finalisation step (or on failure), never claims it.

Stale pointers are reconciled with **`getRun(runId)`** (Workflow), not `streamRegistry.has(id)`: if the recorded run is finished/failed/cancelled, the row is cleared and a new claim is allowed.

### 4.6 Isolation, retention & deletion (Rule 06)

- `WORKFLOW_LOCAL_DATA_DIR=data/workflow` — inside `data/`, which is already git-ignored.
- **Retention:** completed/failed runs accumulate in `data/workflow`; add a GC step. Policy: prune runs older than 30 days on a scheduled task, using the Workflow CLI (`npx workflow inspect` / World retention settings). Must be stated and implemented, not left implicit.
- **Session deletion during a live run:** if `activeRunId` is set, the delete path must first `getRun(activeRunId).cancel()` and await it, *then* delete. The FK cascade then removes `project_tasks`. Deleting first would orphan a run that keeps writing to a removed session.
- **Memory invariant unchanged:** no `ingest_turn`, no semantic/episodic queries for project sessions.

---

## 5. Execution Flow & Error Handling

### 5.1 Normal flow

1. `POST /api/projects/chat` — guard, resolve project/session/model/budget.
2. **Claim `activeRunId` (conditional UPDATE); 409 on conflict** (§4.5).
3. `start(projectHarnessWorkflow, [input])`. `input` is serializable: `projectId`, `sessionId`, `directoryPath`, `trusted`, `messages`, `modelRef`, `effort`, `budgetTokens`.
4. Respond with `createUIMessageStreamResponse({ stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()), headers: { "x-workflow-run-id": run.runId } })`.
5. **Workflow** (`"use workflow"`): `agent.stream({ writable: getWritable() })` → finalise (persist `project_messages` from the response boundary, clear `activeRunId`, update rolling summary).
6. **Tool steps**: each tool's `execute` (wrapped `'use step'`) rebuilds its resources from serializable options and runs. Stop attribution (finish reason, step count) comes from the agent result.
7. **Client**: `WorkflowChatTransport`; reconnect via `GET /api/projects/chat/[runId]/stream` (raw replay from index 0, §4.4a).

### 5.2 Resume

| Event | Behaviour |
|---|---|
| Client disconnect (refresh, tab close) | Client reconnects; raw stream replayed from index 0, UI cursor applied in the transform (§4.4a) |
| Server restart | Local World `recoverActiveRuns` re-enqueues; the workflow continues from the event log |
| Interrupted step | Re-executes (§3.6); tool calls are their own recorded steps and are not re-applied |
| Step throws | Retries per §3.6.1–3.6.4 (mutating tool steps: no retry, `FatalError`) |

### 5.3 Stop-reason semantics (anti-silent invariant)

Five stop reasons must **always be distinguishable**, in the log and — where relevant — to the client. On the durable path, the two timeout rows depend on the §3.7 decision; until the watchdog middleware is confirmed, `totalMs` is the only bound and the chunk row is **not** available.

| Reason | `finishReason` | Surfacing | Available on durable path? |
|---|---|---|---|
| Natural (model finished) | `stop` | normal | yes |
| Step cap (60) | `stop`, `steps >= 60` | metadata `reachedStepCap` + wrap-up text | yes |
| Context wrap-up | `stop`, `contextWrapUp = true` | metadata + wrap-up text | yes |
| Total timeout | abort → **error part** | `formatTimeoutForClient` message | yes (`timeout`) |
| Chunk watchdog | abort → **error part** | same path as timeout | **only if §3.7 middleware lands** |

`formatHarnessRunEndLog` (`harness-loop.ts:95`) already distinguishes these in logs; Stage 1 adds the client-visible metadata.

### 5.4 Error handling

- **Inner model-call retry:** `maxRetries: 2` (matches today's route), governing provider errors inside the step. Not a step-level knob (§3.6.1).
- **`FatalError`** for deterministic failures (model does not support tool calls, missing API key, project directory gone, mutating tool step crash) — do not spend retries on them.
- **Cancellation:** the stop endpoint calls `getRun(runId).cancel()`, which stops the run at its next suspension point and closes streams. For in-flight cancellation inside a step, use an `AbortController` (cooperative). Never `abortSignal: req.signal`.
- **Platform limits (framing corrected).** The 25,000-events figure and a **10,000-steps-per-run** limit are **Vercel Workflow platform** limits, not framework limits; they do not apply to the Local World. They matter only if Projects is ever deployed to Vercel. What counts toward events is step creation/completion, not stream chunks — the `workflow` docs confirm *"stream data flows directly without being stored in the event log"*. Since each tool call is now a step, the relevant ceiling on Vercel is the **step count**: 60 model steps + up to ~300 tool steps is well inside 10,000. Verify empirically with `npx workflow inspect runs` during Stage 2 rather than relying on arithmetic.

### 5.5 Chunk watchdog: reinstate at a high value (correction)

Removing `chunkMs` entirely trades one failure mode for another: a genuinely dead provider socket would then burn the full `stepMs` (or `totalMs`), and a bad run could sit silent for up to 60 minutes. `chunkMs` exists to detect a dead stream, and it is a **per-gap** watchdog, not a per-reasoning-pause one.

Stage 1 **reinstates `chunkMs` at 5 minutes**, strictly below `stepMs` so the gap watchdog can actually fire first (the previous draft set both to 10 minutes, which makes the watchdog unreachable and is a degenerate configuration):

```ts
export const HARNESS_TIMEOUT = {
  totalMs: 60 * 60_000,      // 60 min — whole turn
  stepMs: 10 * 60_000,       // 10 min — one step ceiling (as in the working tree)
  chunkMs: 5 * 60_000,       // 5 min  — gap between output chunks (dead-socket detection)
  firstChunkMs: 3 * 60_000,  // 3 min  — time to first token
  toolMs: 2 * 60_000,
  tools: { bashMs: 5 * 60_000 },
} as const;
```


Invariants (asserted in `harness-loop.test.ts`): `totalMs > stepMs > chunkMs > firstChunkMs` (strict — `chunkMs` must be *below* `stepMs` or the watchdog can never fire first) and `tools.bashMs > HARNESS_BASH_TIMEOUT_MS > 60_000`. The regression guard is **flipped** from asserting `chunkMs` is absent to asserting it is present, `< stepMs`, and `>= 5` minutes.

---

## 6. Testing & Verification

Per Rule 18: Vitest memory-safe configuration, one sequential execution, no concurrent runs from subagents or review agents.

| Layer | What is tested | How |
|---|---|---|
| Pure unit | Task store upsert/list, stop-reason attribution, serialization helpers, `activeRunId` claim/release + stale-pointer reconciliation | Vitest, no model; separate files, bounded `maxWorkers` |
| Workflow agent | `WorkflowAgent` emits correct stream parts, handles `reset-step`, tools rebuilt from serializable options | `MockLanguageModelV4` + `simulateReadableStream` (pattern already in `harness-loop.test.ts`) |
| Tool durability | A tool wrapped with `'use step'` is not re-executed on resume; a mutating tool step that throws raises `FatalError` without retry | Workflow test utilities; assert single side-effect application |
| Chat boundary | `createChatStopConditions()` is still `isStepCount(15)` + `hasToolCall("ask_user_question")`, and the chat route's policy is unchanged after any `harness-loop.ts` edit | Unit test on the exported policy (enforces §2.2) |
| Resume stream | Raw `ModelCallStreamPart` replayed from index 0 with `uiStartIndex` applied yields no duplicated/lost chunks | Unit test on the GET route with a mock run |
| Workflow | Orchestration: claim (route) → agent → finalise; resume after a simulated crash | `workflow` testing utilities, no parallel processes |
| E2E eval | Real scenarios including **"build a landing page"** (the failing case) | Existing `evals/harness/` S0–S5; add one durability scenario |
| Regression guard | `chunkMs` present, `< stepMs`, `>= 5 min`; stop reasons distinguishable; `activeRunId` claim is atomic | Assertions in unit tests (existing pattern) |

### 6.1 Acceptance criteria

1. The instruction "build a landing page" **completes in one run** — no unexplained mid-task stop.
2. Every run ends with a **recorded** reason (natural / cap / context wrap-up / timeout / chunk watchdog), in the log and to the client where relevant.
3. Refreshing the page mid-run reconnects the stream with **no duplicated output** (raw-replay-from-0 + UI cursor, §4.4a).
4. Restarting the dev server mid-run **resumes** the run with a consistent transcript (persisted at the response boundary, §4.4b).
5. The task list persists across a resume (re-read from `project_tasks`).
6. **No tool side effect is applied twice** across a resume — verified by a test that resumes a run whose turn contained a mutating `file_operations` call.


### 6.2 Performance criterion (MCP rebuild)

§3.4 rebuilds MCP connections inside each step. Budget: **MCP tool-collection must add < 500 ms per step**, measured over a 20-step run. If it exceeds this, cache the connection in a step-scoped module (rebuilt once per step, not per tool call) or exclude MCP from the durable path. "Unacceptable latency" now has a threshold to test against.

---

## 7. Rollout & Risk Mitigation

### 7.1 Stage 1 first (no Workflow)

Reproduce the failure with `chunkMs: 60_000` restored, commit the fix with `chunkMs` at **5 minutes** (strictly below `stepMs`), and add stop-reason surfacing. Independently validatable against "build a landing page" before any architectural change, so risk is not stacked.

### 7.2 Stage 2 behind a flag — routing specified

Enable the durable path behind `PROJECT_HARNESS_DURABLE=1`.

- **Server:** when set, `POST /api/projects/chat` claims `activeRunId`, calls `start()`, and returns the Workflow stream with `x-workflow-run-id`. When unset/`0`, it uses the existing `streamText` + `stream-registry.ts` path.
- **Client:** the transport is chosen by the same signal, surfaced to the client in the POST response header (e.g. `x-harness-durable: 1`). The client uses `WorkflowChatTransport` when the header is present, otherwise the existing transport. The client must not guess.
- The flag is read at request time, so switching does not require a rebuild.

**Exit criteria for removing the flag** (define "stable"): ≥ 20 consecutive successful durable runs over ≥ 7 days with **zero** resume failures, the `evals/harness/` suite green, and no 409/reconciliation anomalies. Only then is the fallback path and the flag removed.

### 7.3 Known risks

| Risk | Mitigation |
|---|---|
| `workflow` beta incompatible with Next 16.3.2. **Framing corrected:** `@ai-sdk/workflow` *requires* Workflow 5, which is currently released under the `beta` tag — this is expected, not an anomaly. The Next.js integration risk is still real. | Stage 1 precedes it; fallback flag; inspect with `npx workflow inspect` before full integration |
| **Two `ai` copies in the tree.** The app resolves `ai@7.0.77`; `WorkflowAgent` resolves `ai@7.0.97` (its own dependency), with `@ai-sdk/provider-utils` 5.0.29 vs 5.0.39. Types differ (`ToolSet` structurally incompatible). | **Dedupe, don't cast.** Bump the app's `ai` to `^7.0.97` (or pin via `pnpm.overrides`) so one copy exists, then re-verify `durable-agents.ts` and all `ai` imports typecheck without casts. The existing cast in `durable-agents.ts:17-24` is a workaround to be removed by the dedupe, not the fix. Verify in Stage 2 before wiring. |
| Output duplication on inner model-call retry | `reset-step` + `createModelCallToUIChunkTransform()`; verified in `normalizeUIMessageStreamParts` |
| Tool side effect re-applied on resume | Tools wrapped `'use step'`; mutating tools `maxRetries = 0` + `FatalError` (§3.6) |
| No compensation after a mid-`bash` crash | Acknowledged, not solved (§3.6.6); open question §8.5 |
| Chunk watchdog unavailable on the durable path | Reimplement as model middleware, or declare an accepted loss — a Stage 2 gate (§3.7, §7.4) |
| Workflow data escaping the project | `WORKFLOW_LOCAL_DATA_DIR=data/workflow` (inside git-ignored `data/`; Rule 06) |
| `data/workflow` growth | 30-day GC policy (§4.6) |

### 7.4 Stage 2 gates (must pass before the durable path is enabled)

1. **Approval equivalence.** Re-express `tool-policy.ts` semantics through `needsApproval` and re-verify the anti-forgery property with `experimental_toolApprovalSecret`, including the ≥32-byte secret, per-worker availability, and key-rotation rules (§3.3).
2. **Version dedupe.** One `ai` copy in the tree; casts removed (§7.3).
3. **Event/step ceiling.** Empirical count from a real landing-page run (§5.4).
4. **Tool durability.** Test proving no side effect is applied twice across a resume (§6, criterion 6).
5. **Chunk watchdog decision.** Either the model-middleware watchdog works, or the loss is written down explicitly (§3.7).

---

## 8. Open Questions (to resolve in the implementation plan)

1. **MCP tools in a durable step.** Rebuild per step (cost budget in §6.2) or exclude MCP from the durable path initially. Default: rebuild; revisit if the budget is exceeded.
2. **Rolling summary and topic handoff** currently run in the route (`updateRollingSummary`, `detectAndMarkTopicShift`) and touch the DB and embeddings. Confirm they are safe to run in the finalisation step, or move them to a dedicated step.
3. **GC mechanism.** Whether to use the Workflow CLI, a World retention setting, or a `node-cron` job (already a dependency) for the 30-day `data/workflow` prune.
4. **`onInput*` lifecycle callbacks.** The review flagged that these replay after a model step rather than streaming live, which would be a regression if the Projects UI uses them for tool-input streaming. They are **not present** in `@ai-sdk/workflow@2.0.28`'s type surface (verified), so this does not apply to the pinned version — but re-check on any SDK upgrade.
5. **Compensation for a mid-`bash` crash.** Whether to implement rollback-as-step (WDK's suggested pattern) or leave the run failed with a stated uncertainty (§3.6.6).

---

## 9. Considered Alternatives

### 9.1 External harness runtime (`HarnessAgent`) — rejected

AI SDK 7.0.77 ships `HarnessAgent` (`@ai-sdk/harness/agent`) plus adapters for Claude Code, Cline, Codex, Deep Agents, Grok Build, OpenCode, and Pi, with `@ai-sdk/workflow-harness` for durable turns. This is the closest thing to "Claude Code as the engine", but:

- The Claude Code and Codex adapters require a **network sandbox** (`@ai-sdk/sandbox-vercel`); Projects operate on local disk directories. Using them would require exposing the project directory to a sandbox.
- Tools, prompt, and model would become the runtime's, discarding yggdrasil's harness investment (canonical tools, project prompt engine, provider registry, context guard).
- The packages are experimental and not currently installed.

Rejected in favour of strengthening the native harness.

### 9.2 Hand-rolled durable step over the existing `streamText` — rejected

Wrapping `createHarnessLoop` in a workflow step would preserve the harness verbatim, but requires manually solving stream duplication on retry and model-call streaming from inside a step, and forgoes the SDK's suspension and signed-approval support. Higher long-term maintenance for a worse result.

### 9.3 One coarse durable step — rejected

Wrapping the whole turn in a single large-budget step is the smallest change and survives restarts, but a mid-turn crash replays the step from the start. With tools **not** wrapped as steps, that would re-apply `bash`/`file_operations` against the real project directory. The chosen design avoids this by making each tool call its own durable step (§3.6), which the coarse approach does not.

*(Note: the second review correctly observed that an outer `"use step"` around the turn is itself this coarse design. §3.1 removes it for that reason.)*

---

## 10. Related Documents

- `docs/superpowers/specs/2026-09-17-project-workspaces-harness-design.md` — Project data model, security model, canonical tool names, loop-policy separation (still authoritative except where §3 supersedes it).
- `docs/superpowers/specs/2026-08-29-project-harness-reasoning-design.md` — Harness loop policy SSOT and the reasoning-effort cascade.
- `docs/superpowers/plans/2026-09-21-harness-tool-repair-and-log-isolation.md` — Tool-name/input repair and test log isolation (the current working-tree state).
- `node_modules/.pnpm/ai@7.0.97_zod@4.4.3/node_modules/ai/docs/03-agents/07-workflow-agent.mdx` — `WorkflowAgent` reference for the version it actually resolves (includes Signed Tool Approvals).
- `node_modules/workflow/docs/` — Workflow DevKit foundations (streaming, workflows-and-steps, errors-and-retries, cancellation, worlds).
