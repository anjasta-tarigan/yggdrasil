# Interactive QnA Form (`ask_user_question`) & Policy-Based Tool Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the interactive QnA form tool (`ask_user_question`) for structured multiple-choice decision-making with option buttons, descriptions, and code previews, alongside AI SDK v7 policy-based tool approvals (`toolApproval`) with interactive `<Confirmation>` Accept / Deny gates.

**Architecture:**
- **Tool Schema & Policy Engine**:
  - `src/lib/ai/tools.ts`: `ask_user_question` tool with schema supporting 1-4 questions, category headers, option descriptions, previews, and multi-select.
  - `src/lib/ai/tool-policy.ts`: Centralized policy evaluator inspecting tool names and command patterns (`rm -rf`, package installs, process kills, skill deletions) to return `'user-approval'` or `undefined`.
- **UI Components**:
  - `src/components/ai-elements/question-card.tsx`: Interactive question component rendering category chips, option cards, preview drawers, and an "Other" custom text input that resolves via `addToolResult()`.
  - `src/components/ai-elements/confirmation.tsx`: Wired to handle `tool-approval-request` states with one-click Accept / Reject actions.
- **Chat Feed Integration**:
  - `src/app/page.tsx` & `src/components/projects-view.tsx`: Connect `ask_user_question` and `approval-requested` states to `addToolResult` and `addToolApprovalResponse` from `useChat`.

**Tech Stack:** Next.js 16, AI SDK v7 (`ai`, `@ai-sdk/react`), Radix UI, Tailwind CSS v4, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-tool-approvals-qna-design.md`

## Global Constraints
- Maximum 4 options per question; 1-4 questions per tool call.
- No silent error suppression (Rule 02).
- Zero regressions across existing test suites (57 test files, 490 tests).

---

### Task 1: `ask_user_question` Tool Schema & Policy Evaluator

**Files:**
- Create: `src/lib/ai/tool-policy.ts`
- Modify: `src/lib/ai/tools.ts`
- Modify: `src/lib/ai/prompt.ts`
- Create: `src/lib/ai/__tests__/tool-policy.test.ts`

**Interfaces:**
- Consumes: `z` from `zod`, `tool` from `ai`
- Produces:
  - `ask_user_question` tool in `chatTools`
  - `evaluateToolApproval(toolName: string, input: unknown): Promise<"user-approval" | undefined>`

- [ ] **Step 1: Write unit tests in `src/lib/ai/__tests__/tool-policy.test.ts`**
- [ ] **Step 2: Implement `src/lib/ai/tool-policy.ts` with destructive pattern checks**
- [ ] **Step 3: Add `ask_user_question` to `src/lib/ai/tools.ts` and update system prompt in `prompt.ts`**
- [ ] **Step 4: Run tests: `pnpm vitest run src/lib/ai/__tests__/tool-policy.test.ts`**
- [ ] **Step 5: Commit Task 1**

---

### Task 2: Interactive `<QuestionCard>` Component

**Files:**
- Create: `src/components/ai-elements/question-card.tsx`
- Create: `src/components/__tests__/question-card.test.tsx`

**Interfaces:**
- Consumes: `ToolUIPart`, `DynamicToolUIPart`, `Badge`, `Button`, `Input`
- Produces: `<QuestionCard>` rendering question header, options with descriptions, code preview box, custom text input, and `onAnswer` callback.

- [ ] **Step 1: Write component tests for `<QuestionCard>` in `question-card.test.tsx`**
- [ ] **Step 2: Implement `src/components/ai-elements/question-card.tsx`**
- [ ] **Step 3: Run component tests: `pnpm vitest run src/components/__tests__/question-card.test.tsx`**
- [ ] **Step 4: Commit Task 2**

---

### Task 3: Tool Approval Policy Engine & `<Confirmation>` Test Suite

**Files:**
- Create: `src/components/__tests__/confirmation.test.tsx`
- Modify: `src/components/ai-elements/confirmation.tsx`

**Interfaces:**
- Consumes: `Confirmation`, `ConfirmationTitle`, `ConfirmationRequest`, `ConfirmationActions`, `ConfirmationAction`
- Produces: Streamlined tool approval card with Accept and Deny buttons wired to `addToolApprovalResponse`.

- [ ] **Step 1: Write tests for `<Confirmation>` component in `confirmation.test.tsx`**
- [ ] **Step 2: Ensure `<Confirmation>` cleanly handles tool approval states and action buttons**
- [ ] **Step 3: Run confirmation tests: `pnpm vitest run src/components/__tests__/confirmation.test.tsx`**
- [ ] **Step 4: Commit Task 3**

---

### Task 4: Chat Feed Integration (`page.tsx` & `projects-view.tsx`)

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/components/projects-view.tsx`
- Modify: `src/components/__tests__/projects-view.test.tsx`

**Interfaces:**
- Consumes: `<QuestionCard>`, `<Confirmation>`, `addToolResult` from `useChat`
- Produces: Seamless inline questionnaire display, option clicking to answer, and tool approval gates in chat.

- [ ] **Step 1: Update `MessageParts` in `src/app/page.tsx` to render `<QuestionCard>` for `ask_user_question` and `<Confirmation>` for approval requests**
- [ ] **Step 2: Update `src/components/projects-view.tsx` to render `<QuestionCard>` and `<Confirmation>` in project harness**
- [ ] **Step 3: Run UI tests: `pnpm vitest run src/components/__tests__/projects-view.test.tsx`**
- [ ] **Step 4: Commit Task 4**

---

### Task 5: Full Regression & System Verification Pass

**Files:**
- Test: All 57+ test files in `src/`

- [ ] **Step 1: Run complete test suite (`pnpm vitest run`)**
- [ ] **Step 2: Run static typecheck (`pnpm tsc --noEmit`)**
- [ ] **Step 3: Commit and push final changes**
