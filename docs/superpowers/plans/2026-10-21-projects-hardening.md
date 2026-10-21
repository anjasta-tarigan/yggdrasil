# Projects Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project CRUD, trust, workspace chat, workflow streams, and tool execution reliable while preserving both configured chat paths until the documented rollout gate is met.

**Architecture:** Keep the existing SQLite services, route handlers, WorkflowAgent path, fallback harness, and local AI Elements. Share safety-critical process execution where feasible, validate at API boundaries, cancel runs before deleting their owning state, and use the AI SDK's version-matched workflow chunk transform and transport contract.

**Tech Stack:** Next.js 16.3.2, React 19.2.8, AI SDK 7.0.97, Workflow 5.0.0-beta.50, Drizzle SQLite, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-21-project-coding-harness-design.md`

## Global Constraints

- Preserve both harness paths until the spec's 20 successful runs across at least seven days are evidenced.
- Project filesystem access remains jailed to a freshly resolved canonical directory.
- Imported directories remain untrusted by default; do not silently increase trust.
- Preserve project file data when deleting database metadata.
- Workflow code must keep Node.js-only work inside step modules.
- Reuse installed AI SDK and local AI Elements; add no package.

## Review Focus

- Workflow chunks must be converted to UI chunks for initial and resumed streams.
- Project/session deletion must stop durable and in-process runs before cascading rows.
- Both bash runners must bound runtime/output and avoid leaking server secrets.
- Malformed file/tool inputs and invalid resume cursors must fail explicitly.
- Workspace loading/error/empty/mobile states must not leave stale session or file state.

## Files and Responsibilities

- `src/lib/project-process.ts`: shared bounded, abortable child-process runner.
- `src/lib/project-harness-tools.ts`, `src/workflows/project-harness-steps.ts`: route both bash paths through shared runner.
- `src/lib/project-service.ts`, project delete/session routes: lifecycle and project-state cleanup.
- Project chat routes and `ProjectWorkspace.tsx`: stream framing, reconnection, and chat state.
- Project service, workflow, route, and component tests: regression coverage.
- Existing UI remains in `components/projects`; use its current AI Elements and house components.

## Tasks

### Task 1: Durable stream protocol and cursor validation

**Files:** modify `src/app/api/projects/chat/route.ts`, `src/app/api/projects/chat/[sessionId]/stream/route.ts`; tests in `src/app/api/__tests__/projects-chat-api.test.ts` and `projects-resume-stream.test.ts`.

- [ ] Add failing assertions that durable POST and reconnect responses stream transformed UIMessageChunks and reject invalid cursors.
- [ ] Run targeted unit tests and confirm the assertions fail.
- [ ] Pipe initial and replayed WorkflowAgent streams through `createModelCallToUIChunkTransform`; accept only non-negative safe integer cursors.
- [ ] Run targeted tests and confirm they pass.

### Task 2: Run deletion lifecycle

**Files:** modify `src/app/api/projects/[id]/route.ts`, `src/app/api/projects/route.ts`, `src/app/api/projects/[id]/sessions/[sessionId]/route.ts`, shared project deletion service as needed; tests in `projects-api.test.ts` and `project-service.test.ts`.

- [ ] Add tests that durable run cancellation is awaited before session/project rows are deleted, including bulk deletion; preserve fallback stream abort.
- [ ] Verify the tests fail before implementation.
- [ ] Cancel every stored active workflow run before deleting owning sessions/projects; fail deletion if cancellation fails.
- [ ] Verify row retention on failed cancellation and deletion success after cancellation.

### Task 3: Safe shared bash execution

**Files:** create `src/lib/project-process.ts`; modify `src/lib/project-harness-tools.ts` and `src/workflows/project-harness-steps.ts`; extend tool and workflow-step tests.

- [ ] Add platform-neutral tests using the current Node executable for timeout, abort, output bounds, and environment allowlisting; verify red.
- [ ] Route both harness bash tools through the shared process runner while retaining command validation, canonical root, and trust checks.
- [ ] Verify unit tests; on Windows, report that invoking the external bash executable itself cannot be validated unless installed.

### Task 4: Project service/API edge cases

**Files:** project API routes and `src/lib/project-service.ts`; existing project service/API tests.

- [ ] Cover invalid pagination values, duplicate IDs/count reporting, directory path canonicalization, and session persistence ownership.
- [ ] Fix only confirmed contract mismatches, preserving existing API shapes where possible.
- [ ] Run service/API tests.

### Task 5: Workspace UI consistency and affordances

**Files:** `ProjectWorkspace.tsx`, `ProjectsList.tsx`, dialogs/trust banner/file tree as indicated; existing component tests.

- [ ] Add regression tests for stale run/session state, visible session errors, keyboard-accessible project selection, and delete confirmation wording.
- [ ] Improve confirmed state/accessibility issues using existing primitives and AI Elements; do not add a new UI dependency.
- [ ] Verify affected component tests and inspect layout at narrow and desktop breakpoints when a browser is available.

### Task 6: Retention and final verification

**Files:** workflow-run retention implementation and tests, scheduler integration only if an existing scheduling seam exists, relevant spec comments/docs.

- [ ] Inspect Workflow World APIs for list/prune support and add tests for completed/failed old runs while retaining live runs.
- [ ] Implement 30-day retention only through a supported runtime API; if no safe API exists, document the limitation and leave data untouched.
- [ ] Run Projects unit/integration tests, workflow boundary tests, lint on changed files, and `pnpm exec tsc --noEmit`.
- [ ] Review the final diff for unplanned behavior changes and data-loss risks.
