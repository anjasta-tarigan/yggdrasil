# Architectural Specification: Project Harness as a Durable Coding Harness

**Date:** 2026-09-21
**Status:** Draft (Pending Review)
**Author:** Anjasta Bagus Tarigan & Yggdrasil Cognitive Architecture Team
**Supersedes (in part):** `2026-08-29-project-harness-reasoning-design.md`, `2026-09-17-project-workspaces-harness-design.md` §loop policy

---

## 1. Executive Summary

The Project Harness (`POST /api/projects/chat`) is intended to behave like a coding harness such as Claude Code: the user gives one instruction, and the agent works the task to completion. In practice it stops mid-task with no stated reason — observed empirically at ~6 steps when asked to build a landing page.

### 1.1 Root cause (verified)

There is **no 6-step limit in the code**. `HARNESS_MAX_STEPS = 60` (`src/lib/ai/harness-loop.ts:38`). The stop was caused by `chunkMs: 60_000`, a per-chunk watchdog in `HARNESS_TIMEOUT`. A reasoning model at high effort emits no output for long stretches while thinking; the step at which cumulative silent time first crossed 60s was aborted mid-flight. The failure was **silent** because the AI SDK reports a timeout as a stream part `{ type: "abort", reason }`, not as an `error`:

- `onError` never fires for an abort.
- `toUIMessageStream` forwards the abort part; `@ai-sdk/react` ignores abort parts.
- `useChat` returns to `ready` with `error === undefined`.

The working tree already contains the fix (uncommitted): `chunkMs` removed, timeouts raised (`totalMs` 20→60min, `stepMs` 3→10min, `firstChunkMs` 90s→3min), `timeoutAbortToErrorPart()` added, `onAbort` logging added, and regression guards in `harness-loop.test.ts`.

### 1.2 Remaining gap

The timeout fix removes a false-positive kill but does not make Projects a **long-running** harness. The in-process resumable-stream registry (`src/lib/ai/stream-registry.ts`) survives client disconnects but not a server restart, and the durable execution path (`WorkflowAgent` / `workflow@5`) exists in the repository (`src/lib/ai/durable-agents.ts`, `src/workflows/chat-workflow.ts`) but is **unwired** — no route calls it.

### 1.3 What this specification defines

Two stages, delivered in order:

- **Stage 1 — Robust single request.** Commit the existing timeout fix; make every stop reason observable (natural / step cap / context wrap-up / timeout). No architectural change.
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

- **Regular chat is untouched.** `src/app/api/chat/route.ts`, `src/lib/ai/prepare-step.ts`, `src/lib/ai/termination-conditions.ts`, and `src/lib/ai/context-budget.ts` must not be modified. The chat loop policy (15 steps + `ask_user_question`) stays separate.
- **No external harness runtime.** `HarnessAgent` and the Claude Code / Codex / OpenCode adapters are out of scope (§9.1).
- **No autonomous multi-task backlog.** Accepting a queue of tasks and working them unattended is deferred; this spec only lays the durable task-list foundation for it.
- **No prefixed tools.** Canonical tool names (`bash`, `file_operations`, `manage_tasks`) are preserved. The earlier feature (commit `b0d896d`) was reverted precisely because prefixed tools (`projectBash`, `projectReadFile`) caused tool collision and hallucination.
- **No `abortSignal: req.signal` into the generation call.** This was the cause of premature aborts on tab switch; the stop endpoint remains the only legitimate cancellation path.

---

## 3. Architecture

### 3.1 Three layers

The harness is expressed as three layers with strict boundaries:

1. **Durable orchestration** — `src/workflows/project-harness-workflow.ts` (`"use workflow"`). Owns step sequencing, retries, suspension, and resumption. Contains **no** domain logic: it claims the run, invokes the turn, and finalises. Workflow functions have no Node.js runtime access and must be deterministic.
2. **Turn step** — `src/workflows/project-harness-turn.ts` (`"use step"`). Full Node.js access. Runs one agent turn and writes its stream parts to `getWritable()`. This is where the existing harness policy (`prepareStep`, `stopWhen`, `repairToolCall`, `timeout`) is applied.
3. **Domain & tools** — `src/lib/project-harness-tools.ts`, `src/lib/project-service.ts`, `src/lib/ai/project-prompt.ts`, `src/lib/ai/harness-context.ts`. Roles unchanged; only the call convention changes (serializable options in, resources rebuilt inside the step).

### 3.2 Engine: `WorkflowAgent` (revision of the initial design)

The turn is executed by an AI SDK **`WorkflowAgent`** (`@ai-sdk/workflow@2.0.28`, already installed), not by a hand-rolled `streamText`-in-a-step. The reason is concrete:

- Streams may only be operated **inside step functions** (workflow functions cannot touch them).
- Steps **auto-retry 3× by default**. A step that runs an entire turn and writes to a stream would duplicate already-emitted output on a mid-turn crash.
- `WorkflowAgent` solves this: it emits `reset-step` on retry, and `createModelCallToUIChunkTransform()` makes the client discard the failed step's partial output before processing the retry.

`WorkflowAgent` does **not** replace the harness — it wraps it. The following are preserved as `WorkflowAgent` options (all present in the installed AI SDK 7.0.77; verified in `node_modules/ai/docs/03-agents/07-workflow-agent.mdx`):

| Preserved capability | Mechanism |
|---|---|
| Step cap (60) | `stopWhen: isStepCount(HARNESS_MAX_STEPS)` |
| Context guard + wrap-up | `prepareStep` (`createHarnessPrepareStep`) |
| Tool-name & tool-input repair | `repairToolCall` |
| Provider-level retry | `maxRetries` |
| Timeouts | `timeout: HARNESS_TIMEOUT` |
| Lifecycle telemetry | `onStepEnd`, `onEnd`, `onToolExecutionStart/End`, `prepareCall` |
| Per-request correlation | `runtimeContext` (must be serializable) |

### 3.3 Accepted losses (honest disclosure)

Two capabilities do not carry over and are accepted deliberately:

- **`smoothStream`** (`experimental_transform`) is not a `WorkflowAgent` option. If smooth rendering is still wanted, it must move to the client or be dropped. This is a UX-only regression.
- **HMAC tool-approval** (`experimental_toolApprovalSecret`) is replaced by `WorkflowAgent`'s first-class `needsApproval` on the tool definition, which survives suspension. The HMAC path exists to prevent client-side forgery of approval responses; `needsApproval` makes the approval a workflow-level concern, so the forgery surface changes rather than disappears. Approval semantics must be re-verified during implementation (§7).

### 3.4 Serialization boundary

`"use step"` requires serializable arguments. The following table is the authoritative work list.

| Current (per-request closure) | Durable form |
|---|---|
| `canonicalRoot`, `trusted`, `timeoutMs`, `projectDirectory` | Already serializable — pass as data, rebuild tools inside the step |
| `maxOutputChars: () => harnessToolOutputChars(budgetTokens)` | Thunk → compute `budgetTokens` inside the step, pass the number |
| MCP client (`collectMcpTools()`) | Not serializable → rebuild per step, or defer (§8) |
| `approvalSecret` (HMAC) | Resolve inside the step from env/DB |
| `systemPrompt` | Serializable string — may be computed once and passed |
| `budgetTokens`, `providerOptions`, `resolvedEffort` | Serializable — computed before `start()` or inside the step |

Rule: **serializable data in, resources rebuilt inside the step.** No live handle (sandbox, DB client, MCP client) is stored in workflow state.

### 3.5 Next.js / Workflow wiring

- Wrap `next.config.ts` with `withWorkflow()` from `workflow/next`.
- No middleware/proxy matcher change is needed: this repository has **no** `src/middleware.ts` or `src/proxy.ts` (verified). If one is added later, `.well-known/workflow/` must be excluded from its matcher.
- Set `WORKFLOW_LOCAL_DATA_DIR=data/workflow` (inside the already-git-ignored `data/`, per Rule 06 — no writes to `$HOME` or a root `.workflow-data/`).
- The Local World is the default outside Vercel and needs no cloud credentials. `recoverActiveRuns` (default `true`) re-enqueues pending/running runs at process start, which is what provides restart resilience.

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

- `createProjectHarnessTools()` accepts a `taskStore` (interface: `list/create/update/delete` scoped to `sessionId`), injected when tools are built **inside the step**.
- Every mutation is written; the list is read at step start so it survives across steps, resumes, and restarts.
- This is the foundation for the deferred autonomous backlog, without building that now (YAGNI).

### 4.4 Transcript & resume

- Durable flow: `POST` starts the workflow → the turn step runs → a **finalisation step** saves `project_messages` (server-authoritative, as `toUIMessageStream.onEnd` does today) and clears `activeRunId`.
- The client uses `WorkflowChatTransport`; reconnect goes through `GET /api/projects/chat/[runId]/stream` (`run.getReadable({ startIndex })` plus the `x-workflow-stream-tail-index` header). Chunks replay from the durable Workflow stream, not from `stream-registry.ts`.
- **Consequence:** for the Projects path, `publishStream`/`attachStream`/TTL-sweeper are no longer used. `chatActiveTracker` (GPU protection) moves inside the turn step (start at turn start, end at finalisation), not the route.

### 4.5 Single-run lock (replacing the 409 check)

- `activeRunId` is claimed with a conditional `UPDATE ... WHERE active_run_id IS NULL` — the existing atomic pattern, on a new column.
- Stale pointers are reconciled with **`getRun(runId)`** (Workflow), not `streamRegistry.has(id)`.
- A `POST` while a run is live returns 409; a finished or failed run allows a new claim.

### 4.6 Isolation & retention (Rule 06)

- `WORKFLOW_LOCAL_DATA_DIR=data/workflow` — inside `data/`, which is already git-ignored.
- Session deletion cascades to `project_tasks` via the foreign key.
- **Memory invariant unchanged:** no `ingest_turn`, no semantic/episodic queries for project sessions.

---

## 5. Execution Flow & Error Handling

### 5.1 Normal flow

1. `POST /api/projects/chat` — guard, resolve project/session/model/budget, then `start(projectHarnessWorkflow, [input])`. `input` is serializable: `projectId`, `sessionId`, `directoryPath`, `trusted`, `messages`, `modelRef`, `effort`, `budgetTokens`.
2. The route responds with `createUIMessageStreamResponse({ stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()), headers: { "x-workflow-run-id": run.runId } })`.
3. **Workflow**: claim `activeRunId` (step) → run the turn → finalise (persist `project_messages`, clear `activeRunId`, update rolling summary).
4. **Turn step**: rebuild tools from serializable options → run the agent → write to `getWritable()` → return transcript + usage + stop attribution.
5. **Client**: `WorkflowChatTransport`; reconnect via `GET /api/projects/chat/[runId]/stream`.

### 5.2 Resume

| Event | Behaviour |
|---|---|
| Client disconnect (refresh, tab close) | Client reconnects; `getReadable({ startIndex })` replays from the last received chunk |
| Server restart | Local World `recoverActiveRuns` re-enqueues; the workflow continues from the event log |
| Step failure | See §5.4 — retries are controlled, not the default 3 |

### 5.3 Stop-reason semantics (anti-silent invariant)

Four stop reasons must **always be distinguishable**, in the log and — where relevant — to the client. This is the direct continuation of the Stage 1 fix.

| Reason | `finishReason` | Surfacing |
|---|---|---|
| Natural (model finished) | `stop` | normal |
| Step cap (60) | `stop`, `steps >= 60` | metadata `reachedStepCap` + wrap-up text |
| Context wrap-up | `stop`, `contextWrapUp = true` | metadata + wrap-up text |
| Timeout | abort → **error part** | `formatTimeoutForClient` message |

`formatHarnessRunEndLog` (`harness-loop.ts:95`) already distinguishes these in logs; Stage 1 adds the client-visible metadata.

### 5.4 Error handling

- **Turn step: `maxRetries = 0`.** The turn already carries `streamText`/agent `maxRetries: 2` for provider errors; a workflow-level retry of a step that has already written to the stream only produces duplicates. `maxRetries = 0` delegates retry to the inner layer, which does not duplicate the stream.
- **`FatalError`** for deterministic failures (model does not support tool calls, missing API key, project directory gone) — do not spend 3 retries on them.
- **Cancellation:** the stop endpoint calls `getRun(runId).cancel()`, which stops the run at its next suspension point and closes streams. For in-flight cancellation inside a step, use an `AbortController` (cooperative). Never `abortSignal: req.signal`.
- **Framework limit:** `MAX_EVENTS_EXCEEDED` = 25,000 events/run. A 60-step cap with tool calls stays far below it; no child workflows are needed.

---

## 6. Testing & Verification

Per Rule 18: Vitest memory-safe configuration, one sequential execution, no concurrent runs from subagents or review agents.

| Layer | What is tested | How |
|---|---|---|
| Pure unit | Task store CRUD, stop-reason attribution, serialization helpers, `activeRunId` claim/release | Vitest, no model; separate files, bounded `maxWorkers` |
| Turn step | `runProjectHarnessTurn` emits correct stream parts, handles `reset-step`, rebuilds tools from serializable options | `MockLanguageModelV4` + `simulateReadableStream` (pattern already used in `harness-loop.test.ts`) |
| Workflow | Orchestration: claim → turn → finalise; resume after a simulated crash | `workflow` testing utilities, no parallel processes |
| E2E eval | Real scenarios including **"build a landing page"** (the failing case) | Existing `evals/harness/` S0–S5; add one durability scenario |
| Regression guard | `chunkMs` stays absent; stop reasons stay distinguishable; `activeRunId` is atomic | Assertions in unit tests (existing pattern) |

### 6.1 Acceptance criteria

1. The instruction "build a landing page" **completes in one run** — no unexplained mid-task stop.
2. Every run ends with a **recorded** reason (natural / cap / context wrap-up / timeout), in the log and to the client where relevant.
3. Refreshing the page mid-run reconnects the stream with **no duplicated output**.
4. Restarting the dev server mid-run **resumes** the run (Local World recovery) with a consistent transcript.
5. The task list persists across a resume (re-read from `project_tasks`).

---

## 7. Rollout & Risk Mitigation

### 7.1 Stage 1 first (no Workflow)

Commit the existing timeout fix and add stop-reason surfacing. This is independently validatable against "build a landing page" before any architectural change, so risk is not stacked.

### 7.2 Stage 2 behind a flag

Enable the Workflow path behind `PROJECT_HARNESS_DURABLE=1`. When unset or `0`, the route uses the hardened `streamText` path. This protects against `workflow` beta + Next 16.3.2 incompatibility without maintaining two implementations permanently — the flag is removed once stable.

### 7.3 Known risks

| Risk | Mitigation |
|---|---|
| `workflow@5.0.0-beta.50` incompatible with Next 16.3.2 | Stage 1 precedes it; fallback flag; inspect with `npx workflow inspect` before full integration |
| Version skew: `ai@7.0.77` (direct) vs `ai@7.0.97` (pulled by `@ai-sdk/workflow@2.0.28`), whose `@ai-sdk/provider-utils` majors make `ToolSet` structurally incompatible | Isolated cast, following the documented pattern in `src/lib/ai/durable-agents.ts:17-24`; one touch point, not scattered |
| Output duplication on retry | `WorkflowAgent` `reset-step` + `createModelCallToUIChunkTransform()`; turn `maxRetries = 0` |
| Loss of `smoothStream` / HMAC approval | Accepted and disclosed (§3.3); approval semantics re-verified during implementation |
| Workflow data escaping the project | `WORKFLOW_LOCAL_DATA_DIR=data/workflow` (inside git-ignored `data/`; Rule 06) |
| Approval forgery surface changes with `needsApproval` | Explicit re-verification task in the implementation plan |

---

## 8. Open Questions (to resolve in the implementation plan)

1. **MCP tools in a durable step.** MCP clients are not serializable. Options: rebuild the MCP connection inside each turn step (cost per step), or exclude MCP from the durable path initially and add it later. Default: rebuild inside the step; revisit if latency is unacceptable.
2. **Approval equivalence.** Does `WorkflowAgent`'s `needsApproval` provide the same anti-forgery guarantee as the HMAC secret? Needs explicit verification against the installed SDK and the existing `tool-policy.ts` semantics.
3. **`smoothStream` replacement.** Whether to drop smooth rendering or implement a client-side equivalent.
4. **Rolling summary and topic handoff** currently run in the route (`updateRollingSummary`, `detectAndMarkTopicShift`). These must move into a step (they touch the DB and, for topic detection, embeddings). Confirm they are safe to run in the finalisation step.

---

## 9. Considered Alternatives

### 9.1 External harness runtime (`HarnessAgent`) — rejected

AI SDK 7.0.77 ships `HarnessAgent` (`@ai-sdk/harness/agent`) plus adapters for Claude Code, Cline, Codex, Deep Agents, Grok Build, OpenCode, and Pi, with `@ai-sdk/workflow-harness` for durable turns. This is the closest thing to "Claude Code as the engine", but:

- The Claude Code and Codex adapters require a **network sandbox** (`@ai-sdk/sandbox-vercel`); Projects operate on local disk directories. Using them would require exposing the project directory to a sandbox.
- Tools, prompt, and model would become the runtime's, discarding yggdrasil's harness investment (canonical tools, project prompt engine, provider registry, context guard).
- The packages are experimental and not currently installed.

Rejected in favour of strengthening the native harness.

### 9.2 Hand-rolled durable step over the existing `streamText` — rejected

Wrapping `createHarnessLoop` in a workflow step would preserve the harness verbatim, but requires manually solving stream duplication on retry and model-call streaming from inside a step, and forgoes the SDK's suspension/approval support. Higher long-term maintenance for a worse result.

### 9.3 One coarse durable step — rejected

Wrapping the whole turn in a single large-budget step is the smallest change and survives restarts, but a mid-turn crash replays the step from the start, and there is no per-tool durability. Insufficient for the stated goal.

---

## 10. Related Documents

- `docs/superpowers/specs/2026-09-17-project-workspaces-harness-design.md` — Project data model, security model, canonical tool names, loop-policy separation (still authoritative except where §3 supersedes it).
- `docs/superpowers/specs/2026-08-29-project-harness-reasoning-design.md` — Harness loop policy SSOT and the reasoning-effort cascade.
- `docs/superpowers/plans/2026-09-21-harness-tool-repair-and-log-isolation.md` — Tool-name/input repair and test log isolation (the current working-tree state).
- `node_modules/ai/docs/03-agents/07-workflow-agent.mdx` — `WorkflowAgent` reference for the installed AI SDK version.
- `node_modules/workflow/docs/` — Workflow DevKit foundations (streaming, workflows-and-steps, errors-and-retries, cancellation, worlds).
