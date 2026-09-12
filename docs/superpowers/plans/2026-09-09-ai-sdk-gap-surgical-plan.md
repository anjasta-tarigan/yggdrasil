# AI SDK v7 Alignment: Surgical Gap-Closure Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps between Yggdrasil's current AI SDK v7 usage and the full SDK feature surface through a series of surgical, independently-testable interventions — each adding one concrete capability without rewriting existing working code.

**Architecture:** The plan is organized as 12 surgical tasks grouped into three priority tiers (High / Medium / Low). Each task adds exactly one AI SDK v7 capability that the system currently lacks. Existing working code (custom context-budget, stream-registry, tool-policy, subagent-runner) is preserved; tasks layer new SDK features on top of it.

**Tech Stack:** Next.js 16, AI SDK v7.0.77 (`ai`, `@ai-sdk/react`, `@ai-sdk/mcp`), Zod, SQLite/Drizzle, Tailwind CSS v4, Vitest.

**Spec:** This plan is derived from a comparison of the bundled AI SDK v7 docs (`node_modules/ai/docs/`) against Yggdrasil's source (`src/`). The AI SDK docs are the source of truth for the APIs being added; each task cites the relevant docs section.

## Global Constraints
- AI SDK version locked at v7.0.77 (installed in `node_modules/ai/package.json`). All APIs must match this version's docs/source.
- Zero regressions across existing test suites (57+ test files).
- Every new capability must have a unit test before integration.
- `pnpm` is the package manager; no `npm install` — use `pnpm add <pkg>`.
- No breaking changes to the public API (`POST /api/chat` contract).
- `experimental_toolApprovalSecret` requires a persisted high-entropy secret (stored in settings, like provider keys).

---

## Current State Summary

The system already uses many AI SDK v7 capabilities:
- `streamText`, `toUIMessageStream`, `createUIMessageStreamResponse`, `convertToModelMessages` (with `ignoreIncompleteToolCalls`)
- `ToolLoopAgent`, `isStepCount`, `readUIMessageStream`, `toUIMessageStream`, `toModelOutput` (subagents — `subagent-runner.ts`)
- `toolApproval` callback (via `tool-policy.ts`)
- `repairToolCall` callback (via `tool-repair.ts`)
- `smoothStream`, `generateId`, `InvalidToolInputError`
- `wrapLanguageModel` + `extractReasoningMiddleware` (via `provider.ts`)
- `detectToolDrift`, `fingerprintTools` from `@ai-sdk/mcp` (via `mcp/manager.ts`)
- `lastAssistantMessageIsCompleteWithApprovalResponses`, `addToolApprovalResponse`, `sendAutomaticallyWhen` (via `ChatArea.tsx`)
- Custom resumable stream registry (`stream-registry.ts` — in-memory replay)
- Custom context budget with token-ratio calibration (`context-budget.ts`)
- Custom background job queue (`queue/queue.ts` with SQLite persistence)

**Gaps (features NOT yet used):**
1. Full lifecycle callbacks (`onStart`, `onStepStart`, `onLanguageModelCallStart/End`, `onToolExecutionStart/End`)
2. `experimental_toolApprovalSecret` (HMAC signing)
3. Custom `stopWhen` conditions beyond `stepCountIs` (`hasToolCall`, custom predicates)
4. MCP Apps (`mcpAppClientCapabilities`, `splitMcpAppTools`, `readMCPAppResource`, `experimental_MCPAppRenderer`)
5. `@ai-sdk/devtools` for call capture/debugging
6. `runtimeContext` + `toolsContext` (v7 context flow)
7. `prepareStep` for per-step model/settings adaptation
8. `prepareCall` for pre-loop configuration
9. `DirectChatTransport` for in-process agent communication
10. `InferAgentUIMessage` for type-safe client components
11. `Output.object` / `generateObject` for structured agent output
12. Durable workflows (`@ai-sdk/workflow` `WorkflowAgent` + `WorkflowChatTransport`)

---

## Priority 1 — High Impact, Surgical (directly in the chat loop)

### Task 1: Granular Lifecycle Callbacks for Agent Observability

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Create: `src/lib/ai/__tests__/lifecycle-callbacks.test.ts`
- Modify: `src/lib/observability/log-store.ts` (add structured metric recording helper)

**Interfaces:**
- Consumes: `streamText` from `"ai"`, `syslog` from `@/lib/observability/log-store`
- Produces: `onStart`, `onStepStart`, `onLanguageModelCallStart`, `onLanguageModelCallEnd`, `onToolExecutionStart`, `onToolExecutionEnd` callbacks wired to `syslog` and a new `recordAgentMetric()` helper for per-step token/performance telemetry

The chat route currently only uses `onStepFinish` (deprecated alias) and `onEnd`. The AI SDK lifecycle callbacks docs (`docs/03-ai-sdk-core/65-lifecycle-callbacks.mdx`) describe a full lifecycle: `onStart → onStepStart → onLanguageModelCallStart → onLanguageModelCallEnd → onToolExecutionStart → onToolExecutionEnd → onStepEnd → onEnd`.

- [ ] **Step 1: Write failing tests** for a `recordAgentMetric()` helper in `src/lib/observability/log-store.ts` that stores per-call timing and token data in a ring buffer, queryable by `callId`.

- [ ] **Step 2: Add `recordAgentMetric()` and `queryAgentMetrics()`** to `log-store.ts` — a bounded in-memory store keyed by `callId`, with fields: `callId`, `stepNumber`, `toolName`, `durationMs`, `inputTokens`, `outputTokens`, `totalTokens`, `finishReason`.

- [ ] **Step 3: Wire `onStart`** in the `streamText()` call in `route.ts` to log the model + provider + message count at the start of every generation.

- [ ] **Step 4: Wire `onLanguageModelCallStart` / `onLanguageModelCallEnd`** to record provider-level response time and token throughput. The `onLanguageModelCallEnd` event provides `performance.responseTimeMs` and `performance.outputTokensPerSecond`.

- [ ] **Step 5: Wire `onStepStart`** to log the step number and which tools are active (from `activeTools`).

- [ ] **Step 6: Wire `onToolExecutionStart` / `onToolExecutionEnd`** to record per-tool execution time (the `toolExecutionMs` field from `onToolExecutionEnd`), replacing the ad-hoc logging currently in `onStepFinish`.

- [ ] **Step 7: Run tests:** `pnpm vitest run src/lib/ai/__tests__/lifecycle-callbacks.test.ts src/lib/observability/` and `pnpm vitest run src/app/api/__tests__/`

- [ ] **Step 8: Commit** — `feat(observability): add granular lifecycle callbacks to chat stream`

---

### Task 2: HMAC-Signed Tool Approvals (`experimental_toolApprovalSecret`)

**Files:**
- Create: `src/lib/ai/approval-secret.ts`
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/lib/settings-service.ts` and `src/db/schema.ts` (add `tool_approval_secret` setting)
- Create: `src/lib/ai/__tests__/approval-secret.test.ts`

**Interfaces:**
- Consumes: `toolApproval` callback in `streamText`, `getSettingDb`/`setSettingsDb`, `crypto` from `node:crypto`
- Produces: `resolveApprovalSecret(): string | undefined` that reads a persisted high-entropy secret; passes it as `experimental_toolApprovalSecret` in `streamText`

The AI SDK docs (`docs/03-agents/06-tool-approvals.mdx`, "Signing approvals with `experimental_toolApprovalSecret`") describe HMAC-signing each approval request to bind it to the issuing server, preventing client-side forgery of approval responses. The current `tool-policy.ts` uses a regex-based `evaluateToolApproval` that returns `'user-approval'` or `undefined`, but approvals are NOT signed — a client that crafts a valid-looking approval response can bypass the human-in-the-loop gate.

- [ ] **Step 1: Write failing tests** for `resolveApprovalSecret()` and `generateApprovalSecret()` in `approval-secret.test.ts` — test that a new secret is generated on first call, persisted, and returned on subsequent calls; test that an existing secret is reused.

- [ ] **Step 2: Create `src/lib/ai/approval-secret.ts`** with `generateApprovalSecret()` (32-byte random, base64) and `resolveApprovalSecret()` that reads from settings (`tool_approval_secret` key), generates + persists if missing. Uses `crypto.randomUUID()` or `crypto.randomBytes(32)`.

- [ ] **Step 3: Add `tool_approval_secret` to the settings schema** in `src/db/schema.ts` (column type: text, nullable).

- [ ] **Step 4: Wire `experimental_toolApprovalSecret`** into the `streamText()` call in `route.ts` by calling `resolveApprovalSecret()` and passing the result. The existing `toolApproval` callback stays unchanged — the secret is an additional security layer.

- [ ] **Step 5: Run tests:** `pnpm vitest run src/lib/ai/__tests__/approval-secret.test.ts` and `pnpm vitest run src/app/api/__tests__/chat-stream-endpoints.test.ts`

- [ ] **Step 6: Commit** — `feat(security): HMAC-sign tool approvals with experimental_toolApprovalSecret`

---

### Task 3: Custom `stopWhen` Conditions Beyond Step Count

**Files:**
- Create: `src/lib/ai/termination-conditions.ts`
- Modify: `src/app/api/chat/route.ts`
- Create: `src/lib/ai/__tests__/termination-conditions.test.ts`

**Interfaces:**
- Consumes: `stopWhen`, `stepCountIs` from `ai`, `hasToolCall` from `ai`
- Produces: A composite `stopWhen` that uses `isStepCount(15)` AND `hasToolCall` for specific terminal tools

The route currently uses `stopWhen: stepCountIs(15)` exclusively. The AI SDK docs (`docs/03-agents/04-loop-control.mdx`) describe `hasToolCall(...toolNames)` to stop when specific tools are called, and custom `StopCondition` functions that receive `steps` to implement budget-based or result-based termination.

- [ ] **Step 1: Write failing tests** for `createChatStopConditions()` that returns an array stop condition combining `isStepCount(15)` with a custom predicate checking for a "complete" signal in tool output.

- [ ] **Step 2: Create `src/lib/ai/termination-conditions.ts`** exporting `createChatStopConditions()` that returns `[stepCountIs(15), hasToolCall('ask_user_question')]` — the `ask_user_question` tool from the QnA plan signals the agent needs user input, so the loop should stop and wait.

- [ ] **Step 3: Replace `stopWhen: stepCountIs(15)`** in `route.ts` with `stopWhen: createChatStopConditions()`.

- [ ] **Step 4: Run tests:** `pnpm vitest run src/lib/ai/__tests__/termination-conditions.test.ts` and `pnpm vitest run src/app/api/__tests__/chat-stream-endpoints.test.ts`

- [ ] **Step 5: Commit** — `feat(agent): add hasToolCall-based stop condition for QnA tool`

---

### Task 4: MCP Apps Support (Sandboxed Interactive Tool UIs)

**Files:**
- Modify: `src/lib/ai/mcp/manager.ts`
- Create: `src/components/ai-elements/mcp-app-renderer.tsx`
- Create: `src/app/api/mcp/mcp-app-host/read-resource/route.ts`
- Create: `src/app/api/mcp/mcp-app-host/call-tool/route.ts`
- Create: `src/lib/ai/__tests__/mcp-apps.test.ts`

**Interfaces:**
- Consumes: `createMCPClient`, `mcpAppClientCapabilities`, `splitMcpAppTools`, `readMCPAppResource` from `@ai-sdk/mcp`; `experimental_MCPAppRenderer` from `@ai-sdk/react`
- Produces: An MCP Apps host that splits model-visible vs. app-visible tools, renders `ui://` resources in a sandboxed iframe, and proxies app-visible tool calls

The AI SDK docs (`docs/03-ai-sdk-core/17-mcp-apps.mdx`) describe MCP Apps: tools can point to a `ui://` resource containing HTML rendered in a sandboxed iframe. The system already collects MCP tools (`mcp/manager.ts`) but does not advertise MCP Apps client capabilities or render interactive UIs.

- [ ] **Step 1: Write failing tests** for `splitMcpAppTools()` integration — verify that app-visible tools are separated from model-visible ones and app-visible tools are withheld from `streamText`.

- [ ] **Step 2: Add `mcpAppClientCapabilities`** to the MCP client creation in `collectMcpTools()` in `mcp/manager.ts`, so the host advertises it can render `ui://` resources.

- [ ] **Step 3: Use `splitMcpAppTools()`** in `mcp/manager.ts` to filter tools: only `modelVisible` tools go to `tools` in `route.ts`; `appVisible` tools are stored for iframe proxying.

- [ ] **Step 4: Create `read-resource` API route** (`src/app/api/mcp/mcp-app-host/read-resource/route.ts`) that calls `readMCPAppResource()` and returns the normalized HTML + CSP metadata.

- [ ] **Step 5: Create `call-tool` API route** (`src/app/api/mcp/mcp-app-host/call-tool/route.ts`) that validates the requested tool against `appVisible` before forwarding to the MCP client.

- [ ] **Step 6: Create `src/components/ai-elements/mcp-app-renderer.tsx`** — a wrapper around `experimental_MCPAppRenderer` that renders the sandbox iframe and bridges JSON-RPC messages.

- [ ] **Step 7: Run tests:** `pnpm vitest run src/lib/ai/__tests__/mcp-apps.test.ts`

- [ ] **Step 8: Commit** — `feat(mcp): add MCP Apps support with sandboxed iframe rendering`

---

### Task 5: AI SDK DevTools Capture

> ⚠️ **BLOCKED**: `pnpm add @ai-sdk/devtools` fails in this environment due to a read-only pnpm store (`EROFS` on `~/.cache/node/corepack/.../pnpm.mjs`). The package is not installed and cannot be installed. This task should be executed in an environment with write access to the pnpm store.

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/lib/bootstrap.ts`
- Create: `src/lib/ai/ai-sdk-devtools.ts`
- Create: `src/lib/ai/__tests__/ai-sdk-devtools.test.ts`

**Interfaces:**
- Consumes: `registerTelemetry` from `ai`, `DevToolsTelemetry` from `@ai-sdk/devtools`
- Produces: A devtools capture initialized at bootstrap that records AI SDK calls (requests, responses, tool calls, token usage, multi-step runs)

The AI SDK docs (`docs/03-ai-sdk-core/65-devtools.mdx`) describe `@ai-sdk/devtools` capturing AI SDK calls for local debugging. `registerTelemetry(DevToolsTelemetry())` is called **globally** (not per-call), so no `streamText()` changes are needed — the telemetry integration hooks into the SDK lifecycle automatically.

- [ ] **Step 1: Install `@ai-sdk/devtools`** — `pnpm add @ai-sdk/devtools` (BLOCKED in current environment)

- [ ] **Step 2: Write failing tests** for a `getDevToolsInstance()` helper that returns a configured DevTools instance in development, or `undefined` in production.

- [ ] **Step 3: Create `src/lib/ai/ai-sdk-devtools.ts`** that imports `DevToolsTelemetry` from `@ai-sdk/devtools`, `registerTelemetry` from `ai`, and exports `getDevToolsInstance()` — checks `process.env.NODE_ENV === 'development'` and `process.env.AI_SDK_DEVTOOLS_ENABLED`; returns the instance or `undefined`.

- [ ] **Step 4: Register telemetry globally** in `src/lib/bootstrap.ts` by calling `registerTelemetry(getDevToolsInstance())` during bootstrap (guarded by the dev-mode check).

- [ ] **Step 5: Run tests:** `pnpm vitest run src/lib/ai/__tests__/ai-sdk-devtools.test.ts` and `pnpm tsc --noEmit`

- [ ] **Step 6: Commit** — `feat(devtools): integrate AI SDK DevTools for local debugging`

---

## Priority 2 — Medium Impact (context & step-level adaptation)

### Task 6: `runtimeContext` and `toolsContext` Adoption

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/lib/ai/subagent-runner.ts`
- Create: `src/lib/ai/__tests__/runtime-context.test.ts`

**Interfaces:**
- Consumes: `runtimeContext`, `toolsContext` in `streamText()` and `ToolLoopAgent` constructor
- Produces: Server-side state (request ID, feature flags, tenant settings) flowing through the agent loop via `runtimeContext` instead of being captured in closures

The AI SDK docs (`docs/03-agents/02-building-agents.mdx`, "Context and Agent State") describe `runtimeContext` as the agent's shared runtime state that flows through `prepareStep`, lifecycle callbacks, and `onEnd`. The system currently passes request-scoped data via closures and module-level state.

- [ ] **Step 1: Write failing tests** for a `buildRuntimeContext(chatId, modelId)` helper that returns a serializable object with `requestId`, `chatId`, `modelId`, `featureFlags`.

- [ ] **Step 2: Create `buildRuntimeContext()`** in a new `src/lib/ai/runtime-context.ts` module (or inline in `route.ts`).

- [ ] **Step 3: Pass `runtimeContext`** to `streamText()` in `route.ts` with the request-scoped data.

- [ ] **Step 4: Pass `runtimeContext`** to `ToolLoopAgent` constructor in `subagent-runner.ts` so subagents receive the same context.

- [ ] **Step 5: Run tests:** `pnpm vitest run src/lib/ai/__tests__/runtime-context.test.ts`

- [ ] **Step 6: Commit** — `refactor(agent): adopt runtimeContext for request-scoped state flow`

---

### Task 7: `prepareStep` for Per-Step Model Adaptation

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Create: `src/lib/ai/__tests__/prepare-step.test.ts`

**Interfaces:**
- Consumes: `prepareStep` callback in `streamText()`, `activeTools`, `toolChoice`
- Produces: Dynamic per-step model/settings switching based on step number, tool usage, and conversation state

The AI SDK docs (`docs/03-agents/04-loop-control.mdx`, "Prepare Step") describe `prepareStep` for dynamic model selection, context management, tool selection, and model call settings per step. The system currently resolves the model once per request and does not adapt per-step.

- [ ] **Step 1: Write failing tests** for a `createPrepareStep(options)` function that returns a `prepareStep` callback which switches to a higher-reasoning model after step 5 if tool calls are being made.

- [ ] **Step 2: Create `src/lib/ai/prepare-step.ts`** with `createPrepareStep()` that: (a) after step 5 with tool calls, returns `{ model: <fallback-model>, temperature: 0.1 }`; (b) uses `activeTools` to constrain tool availability in later steps for focus.

- [ ] **Step 3: Wire `prepareStep`** into the `streamText()` call in `route.ts`.

- [ ] **Step 4: Run tests:** `pnpm vitest run src/lib/ai/__tests__/prepare-step.test.ts` and `pnpm vitest run src/app/api/__tests__/chat-stream-endpoints.test.ts`

- [ ] **Step 5: Commit** — `feat(agent): add per-step prepareStep model adaptation`

---

### Task 8: `prepareCall` for Pre-Loop Configuration (on `ToolLoopAgent`)

> **Correction:** `prepareCall` is only available on `ToolLoopAgent`, NOT on `streamText` (verified at `node_modules/ai/src/agent/tool-loop-agent-settings.ts:303`). This task applies to subagents in `subagent-runner.ts`.

**Files:**
- Modify: `src/lib/ai/subagent-runner.ts`
- Create: `src/lib/ai/__tests__/prepare-call.test.ts`

**Interfaces:**
- Consumes: `prepareCall` callback on `ToolLoopAgent` constructor
- Produces: Dynamic instruction/system-prompt injection based on call options before the subagent loop starts

The AI SDK docs (`docs/03-agents/02-building-agents.mdx`) describe `prepareCall` as running once before the agent loop starts, transforming call parameters based on runtime context. The system currently bakes instructions into the `ToolLoopAgent` constructor at build time; `prepareCall` lets subagent instructions adapt dynamically per invocation (e.g., injecting the parent's reasoning effort, or adjusting task framing based on the `task` input schema).

- [ ] **Step 1: Write failing tests** for `buildSubagentWithPrepareCall()` — verify that `prepareCall` receives the call options and can augment `instructions` with dynamic context.

- [ ] **Step 2: Add `prepareCall`** to the `ToolLoopAgent` constructor in `buildSubagent()` in `subagent-runner.ts` — it receives `{ prompt, options }` and can modify `instructions` before the loop starts, injecting the subagent's task domain and any runtime context.

- [ ] **Step 3: Use `callOptionsSchema`** on the `ToolLoopAgent` to validate `effort` and other call options, as described in the AI SDK docs.

- [ ] **Step 4: Run tests:** `pnpm vitest run src/lib/ai/__tests__/prepare-call.test.ts`

- [ ] **Step 5: Commit** — `refactor(subagents): add prepareCall for dynamic instruction injection`

---

### Task 9: `DirectChatTransport` for In-Process Communication

**Files:**
- Create: `src/lib/ai/direct-transport.ts`
- Create: `src/lib/ai/__tests__/direct-transport.test.ts`
- Modify: `src/app/api/chat/route.ts`

**Interfaces:**
- Consumes: `DirectChatTransport`, `DefaultChatTransport` from `ai`
- Produces: A transport that invokes an agent's `stream()` directly in-process, for testing without HTTP

The AI SDK docs (`docs/04-ai-sdk-ui/21-transport.mdx`, "Direct Agent Transport") describe `DirectChatTransport` for serverless/SSR/testing scenarios where you want to communicate with an agent without HTTP.

- [ ] **Step 1: Write failing tests** for `createDirectTransport()` that builds a `DirectChatTransport` wrapping the same toolset as the HTTP route.

- [ ] **Step 2: Create `src/lib/ai/direct-transport.ts`** exporting `createDirectChatTransport()` that mirrors the tool setup in `route.ts` but uses `DirectChatTransport` instead of an HTTP transport.

- [ ] **Step 3: Use it in the `__tests__` for the chat route** — replace the mock HTTP transport with `DirectChatTransport` so integration tests run the agent in-process.

- [ ] **Step 4: Run tests:** `pnpm vitest run src/lib/ai/__tests__/direct-transport.test.ts`

- [ ] **Step 5: Commit** — `test(chat): add DirectChatTransport for in-process test communication`

---

### Task 10: `InferAgentUIMessage` for Type-Safe Clients

**Files:**
- Modify: `src/components/ai-elements/agent.tsx`
- Modify: `src/components/chat/MessageParts.tsx`
- Modify: `src/app/api/chat/route.ts`

**Interfaces:**
- Consumes: `InferAgentUIMessage` from `ai`
- Produces: Exported UIMessage type for use in `useChat<T>` on the client

The AI SDK docs (`docs/03-agents/02-building-agents.mdx`, "End-to-end Type Safety") describe `InferAgentUIMessage<typeof agent>` to infer the UI message type from the agent's tool definitions for use in `useChat<T>()`.

- [ ] **Step 1: Write failing tests** verifying the exported `ChatUIMessage` type includes tool part types for `ask_user_question`, `bash`, `memory_search`, etc.

- [ ] **Step 2: Define the tool set** as a module-level constant that both the server agent and the client can import. Currently tools are built inline in `route.ts`.

- [ ] **Step 3: Export `type ChatUIMessage = InferAgentUIMessage<typeof agent>`** (or the equivalent from the merged tool set).

- [ ] **Step 4: Use `<ChatUIMessage>` in `useChat<ChatUIMessage>()`** calls in `ChatArea.tsx` and related components.

- [ ] **Step 5: Run tests:** `pnpm tsc --noEmit` and `pnpm vitest run src/components/chat/`

- [ ] **Step 6: Commit** — `types: export InferAgentUIMessage for type-safe chat components`

---

## Priority 3 — Lower Priority (larger architectural changes)

### Task 11: Durable Workflows via `@ai-sdk/workflow`

> ⚠️ **BLOCKED**: `pnpm add @ai-sdk/workflow workflow@beta` fails in this environment due to a read-only pnpm store (`EROFS`). This task should be executed in an environment with write access to the pnpm store.

**Files:**
- Create: `src/lib/ai/durable-agents.ts`
- Create: `src/workflows/chat-workflow.ts`
- Modify: `src/app/api/chat/route.ts` (conditional)
- Create: `src/lib/ai/__tests__/durable-agents.test.ts`
- Add dependency: `@ai-sdk/workflow`, `workflow` (beta)

**Interfaces:**
- Consumes: `WorkflowAgent`, `WorkflowChatTransport` from `@ai-sdk/workflow`; `createModelCallToUIChunkTransform`
- Produces: A durable, resumable `WorkflowAgent` that survives process restarts with automatic step retries

The AI SDK docs (`docs/03-agents/07-workflow-agent.mdx`) describe `WorkflowAgent` for building durable, resumable agents that run inside Vercel Workflows. Each tool execution is a discrete workflow step with automatic retries, persistence, and built-in approval flows. The system's current subagents use in-memory `ToolLoopAgent`.

- [ ] **Step 1: Write failing tests** for a `createDurableAgent(config)` factory that returns a `WorkflowAgent` with the same tools as the in-memory subagent.

- [ ] **Step 2: Install dependencies** — `pnpm add @ai-sdk/workflow workflow@beta`

- [ ] **Step 3: Create `src/lib/ai/durable-agents.ts`** exporting `createDurableAgent()` that mirrors `buildSubagent()` but uses `WorkflowAgent` with `'use step'` annotations on tool execute functions.

- [ ] **Step 4: Create `src/workflows/chat-workflow.ts`** — the workflow function with `'use workflow'`, `getWritable<ModelCallStreamPart>()`, and `agent.stream()`.

- [ ] **Step 5: Add `x-workflow-run-id` header** to the chat route response and `GET /api/chat/[chatId]/stream` endpoint for reconnection.

- [ ] **Step 6: Run tests:** `pnpm vitest run src/lib/ai/__tests__/durable-agents.test.ts` and `pnpm tsc --noEmit`

- [ ] **Step 7: Commit** — `feat(agent): add durable WorkflowAgent for crash-resilient subagent execution`

---

### Task 12: `Output.object` for Structured Agent Results

**Files:**
- Modify: `src/lib/ai/subagent-runner.ts`
- Modify: `src/lib/ai/tools/task.ts`
- Create: `src/lib/ai/__tests__/structured-output.test.ts`

**Interfaces:**
- Consumes: `Output` from `ai` (or `@ai-sdk/workflow`)
- Produces: Agent results parsed into typed objects with Zod schemas

The AI SDK docs describe `Output.object({ schema })` for parsing agent responses into typed objects. Currently, subagents return free-text summaries and the system has a fragile heuristic (`text.endsWith("SUMMARY COMPLETE.")`) to detect completion.

- [ ] **Step 1: Write failing tests** for a `subagentResultSchema` Zod schema that validates the structured output shape: `{ summary: string, keyFindings: string[], nextSteps: string[] }`.

- [ ] **Step 2: Define `SubagentResultSchema`** in `src/lib/ai/subagent-runner.ts` using Zod.

- [ ] **Step 3: Add `output: Output.object({ schema: SubagentResultSchema })`** to the `ToolLoopAgent` constructor in `buildSubagent()`.

- [ ] **Step 4: Update `toModelOutput`** in `buildSubagentTool()` to use `result.output` instead of extracting text from the accumulated UIMessage.

- [ ] **Step 5: Run tests:** `pnpm vitest run src/lib/ai/__tests__/structured-output.test.ts`

- [ ] **Step 6: Commit** — `feat(subagents): use Output.object for structured subagent results`

---

## Out of Scope (Not Recommended)

The following SDK features are intentionally NOT included in this plan:

- **`@ai-sdk/policy-opa`**: The existing `tool-policy.ts` is a focused, tested regex-based evaluator (490 tests pass). OPA/Rego would be a rewrite of working security logic for marginal benefit. If policy complexity outgrows the current approach, a separate plan can address it.
- **Reranking (`rerank`)**: The memory system uses SQLite `sqlite-vec` for vector search, not an AI SDK reranker. Adding cross-encoder reranking requires a provider that supports it and a UI for configuration — a separate effort.
- **`wrapEmbeddingModel` / `embed` / `embedMany`**: The custom `embeddings.ts` has features (LRU cache, dimension detection, chunking, fallback hash vectors, calibration) that exceed the SDK's `embed()` function. Rewriting to use the SDK would lose these capabilities.
- **`@ai-sdk/tui`**: The system is a web app, not a terminal tool. TUI support is not needed.
- **`pruneMessages`**: The system's `compactAndPruneMessages` is more sophisticated (hierarchical rollup, tool atomicity, token-ratio calibration) than the SDK's built-in `pruneMessages`. No change needed.

---

## Execution Notes

**Testing:** Run the full suite after each task:
```bash
pnpm vitest run
pnpm tsc --noEmit
```

**Order of implementation:** Tasks 1–5 are independent and can be worked in parallel. Tasks 6–7 depend on each other (runtimeContext feeds prepareStep). Task 8 depends on 6 and 7. Tasks 9–10 depend on the tool-set being exported as a constant. Tasks 11–12 are standalone but require new dependencies.
```
