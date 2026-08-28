# Architectural Specification: Project Harness Agent, System Reasoning & AI SDK v7 Tool Alignment

**Date:** 2026-08-29  
**Status:** Approved  
**Author:** Yggdrasil Cognitive System  

---

## 1. Executive Summary

This specification defines the architectural design for:
1. **Rich Project Harness Chat & Workspace Execution**: Full-stack autonomous software engineering harness scoped to authorized project directories (`src/components/projects-view.tsx`, `src/lib/project-service.ts`, `src/app/api/projects/chat/route.ts`).
2. **System-Wide Reasoning & Chain-of-Thought Engine**: Auto-detection of reasoning capabilities with `xhigh` effort default and cascade fallback (`high` / `medium` / `low` / token budgets), paired with a stream transformer for `<think>...</think>` tags and `<Reasoning>` / `<ChainOfThought>` UI elements.
3. **AI SDK v7 Tool & Harness Standard Alignment**: Integration of `projectBash`, `projectWriteFile`, `projectReadFile`, `projectListFiles`, `manage_tasks`, `create_artifact`, and sandbox `bash` with proper subprocess cancellation (`req.signal`), UTF-8 decoders, and session persistence.

---

## 2. Reasoning Engine & Stream Transformation

### 2.1 Auto-Detect & Fallback Strategy (`xhigh` Default)
- Provider options in `src/lib/ai/provider.ts` dynamically evaluate model metadata and configuration:
  - If the provider/model supports structured reasoning effort (OpenAI o-series, Claude 3.7 Sonnet extended thinking, DeepSeek-R1 / Qwen-2.5 on Ollama / vLLM):
    - Sets `providerOptions.openai.reasoningEffort: "high"` (or `"xhigh"` where accepted).
    - Sets `providerOptions.anthropic.thinking = { type: "enabled", budgetTokens: 16000 }` (or up to provider limits).
  - When models do not support `xhigh` parameter names, gracefully falls back down the hierarchy without throwing runtime errors.

### 2.2 `<think>` Stream Transformer (`toUIMessageStream`)
- Many open-weight reasoning models (DeepSeek-R1, Qwen-2.5-Coder-R1) output their reasoning within plain text wrapped in `<think>...</think>` blocks.
- A custom stream parser intercepts tokens during streaming:
  - Text inside `<think>...</think>` is emitted as `{ type: "reasoning", text: chunk }`.
  - Text outside `<think>...</think>` is emitted as standard `{ type: "text", text: chunk }`.
  - Works seamlessly alongside native AI SDK v7 reasoning parts, ensuring both proprietary and open-source models render live reasoning in the UI.

---

## 3. Project Harness Chat Architecture

### 3.1 Backend Orchestration (`/api/projects/chat`)
- **Execution Lifecycle & Subprocess Management**:
  - `streamText` executes up to 30 tool steps with `abortSignal: req.signal`.
  - When a user stops generation, in-flight bash commands and child process trees receive `SIGTERM` / `SIGKILL` cleanly.
  - `safeEndChatTracking()` is strictly guaranteed in `onEnd`, `onError`, `toUIMessageStream({ onError })`, and the root `try/catch`.
- **Project Tools**:
  - `projectBash`: Executed in project directory root with `safeEnv`, `StringDecoder("utf8")`, output truncation, and dangerous command blockers.
  - `projectWriteFile` & `projectReadFile`: File operations guarded by `validateAndResolveProjectPath` with `fs.realpath` symlink boundary enforcement.
  - `manage_tasks`: Multi-step plan checklist creation and state mutation.
  - `create_artifact`: Interactive UI, React apps, and documents rendered in the artifact drawer.
  - `web_search` & `fetch_page`: Live research capabilities.

### 3.2 Frontend Harness Feed (`src/components/projects-view.tsx`)
- Renders rich interactive agent components matching `AppShell`:
  - `<Reasoning>` cards with live timer duration, auto-open during streaming, and streamdown formatting.
  - Dedicated `<Terminal>` cards for `projectBash` displaying command prompt, status badges, stdout/stderr streams, and exit codes.
  - `<Task>` checklist cards for `manage_tasks` calls.
  - `<ArtifactChip>` chips that open the artifact preview panel on click.
  - `<Tool>` collapsible cards for file inspections and writes.
  - Session history switcher and live Stop / Cancel controls.

---

## 4. System Verification & Test Plan

1. **Unit & Integration Tests**:
   - `src/app/api/__tests__/projects-chat-api.test.ts`: Test project chat streaming, reasoning extraction, tool calling, and error tracking cleanup.
   - `src/lib/__tests__/project-service.test.ts`: Verify symlink jail traversal rejection, UTF-8 decoders, and batched session queries.
   - `src/components/__tests__/projects-view.test.tsx`: Test session switching, reasoning rendering, terminal tool output, and prompt submission.
2. **Full Regression Verification**:
   - Run complete test suite across all 47+ test files to confirm zero regressions.
EOF
,file_path: