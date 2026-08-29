# Architectural Specification: Interactive QnA Form (`ask_user_question`) & Policy-Based Tool Approvals (`toolApproval`)

**Date:** 2026-08-29  
**Status:** Approved  
**Authors:** Anjasta Bagus Tarigan & Yggdrasil Cognitive Architecture Team  

---

## 1. Executive Summary

This specification establishes the architecture for:
1. **Interactive QnA Tool (`ask_user_question`)**: A first-class human-in-the-loop tool modeled after Claude Code's `AskUserQuestion`. When user requirements or task specifications are ambiguous (e.g. scaffolding a new skill, choosing architecture patterns, or picking UI libraries), the agent invokes `ask_user_question` to render an inline, interactive questionnaire with tappable option buttons, descriptions, previews, and custom text inputs. Selecting an answer immediately resolves the tool call on the client via `addToolResult`, resuming agent execution without requiring manual typing.
2. **Policy-Based Tool Approvals (`toolApproval`)**: An automated security governance layer built on AI SDK v7's `toolApproval` protocol that evaluates tool calls (destructive bash commands, skill deletion, critical mutations) and requests explicit user confirmation (`<Confirmation>` Accept / Deny) before execution.

---

## 2. Interactive QnA Tool (`ask_user_question`) Architecture

### 2.1 Tool Schema (`src/lib/ai/tools.ts`)
The `ask_user_question` tool is registered across both standard chat (`chatTools`) and the project harness with the following schema:

```typescript
export const askUserQuestionSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().describe("The specific question to ask the user"),
        header: z
          .string()
          .max(20)
          .describe("Short tag/category chip (e.g., 'Framework', 'Database', 'Approach')"),
        multiSelect: z
          .boolean()
          .default(false)
          .describe("Whether multiple options can be selected"),
        options: z
          .array(
            z.object({
              label: z.string().describe("Concise option title (1-5 words)"),
              description: z
                .string()
                .describe("Explanation of trade-offs, consequences, or implementation details"),
              preview: z
                .string()
                .optional()
                .describe("Optional multi-line code, diagram, or ASCII mockup preview"),
            })
          )
          .min(2)
          .max(4)
          .describe("2-4 distinct mutually exclusive choices"),
      })
    )
    .min(1)
    .max(4)
    .describe("1-4 questions to present to the user"),
});
```

### 2.2 Client-Side Execution Flow
1. **Model Invocation**: The LLM calls `ask_user_question({ questions: [...] })`.
2. **Client State**: In AI SDK v7, the tool call emits as `state: "input-available"` without server-side execution.
3. **Interactive UI (`<QuestionCard>`)**:
   - Renders each question with its header chip, descriptive prompt, and selectable option cards.
   - If an option has a `preview` field, an adjacent or expandable monospace preview box renders the formatted snippet.
   - Provides an auto-appended "Other" text input field for custom responses.
4. **Tool Resolution**:
   - Clicking an option or submitting custom text calls `addToolResult({ toolCallId, result: { answers: [...] } })`.
   - The UI immediately updates the tool call state to `output-available`, and `useChat` sends the answer payload back to the model, resuming multi-step execution automatically.

---

## 3. Policy-Based Tool Approvals (`toolApproval`)

### 3.1 Policy Evaluation Engine (`src/lib/ai/tool-policy.ts`)
A centralized policy evaluator determines whether a tool invocation requires human confirmation:

- **Requires Human Approval (`user-approval`)**:
  - `bash` / `projectBash` commands matching destructive or mutation patterns:
    - Recursive removals (`rm -rf`, `rm -r`).
    - Package manager installations (`npm install`, `pnpm add`, `cargo add`, `pip install`).
    - Global process signals (`kill`, `killall`, `pkill`).
    - Git mutations (`git reset --hard`, `git push --force`, `git clean -f`).
  - Skill management mutations (`delete_skill`, `update_skill`).
  - Dangerous MCP tools with destructive verbs (`delete_*`, `drop_*`, `destroy_*`).
- **Auto-Approved (Permissive Fallback)**:
  - Read-only operations (`web_search`, `fetch_page`, `readFile`, `projectReadFile`, `projectListFiles`, `recall_memories`).
  - Interactive planning and state tools (`ask_user_question`, `manage_tasks`, `remember_note`, `remember_fact`, `create_artifact`).

### 3.2 Confirmation UI (`src/components/ai-elements/confirmation.tsx`)
- When a tool call requires approval, `state` enters `"approval-requested"`.
- The client renders a `<Confirmation>` card displaying the tool name, arguments, and warning description.
- **Accept**: Sends `addToolApprovalResponse({ approvalId, approved: true })` $\to$ executes tool.
- **Deny**: Sends `addToolApprovalResponse({ approvalId, approved: false, reason: "User rejected" })` $\to$ yields `output-denied` and model adjusts approach.

---

## 4. UI/UX Integration & Component Hierarchy

- **New Component**: `src/components/ai-elements/question-card.tsx`
  - Integrated into `src/app/page.tsx` (`MessageParts`) and `src/components/projects-view.tsx`.
- **System Prompt Guidance**:
  - Injected into `src/lib/ai/prompt.ts` Layer 1 invariants:
    *"When a task is underspecified, has multiple valid architectural approaches, or requires design choices, call 'ask_user_question' to present structured multiple-choice options. Do not guess user preferences."*

---

## 5. Testing & Quality Gates

1. **Unit Tests**:
   - `src/lib/ai/__tests__/tool-policy.test.ts`: Verify policy classification on safe vs. destructive commands.
   - `src/components/__tests__/question-card.test.tsx`: Test option selection, custom text submission, and `addToolResult` invocation.
   - `src/components/__tests__/confirmation.test.tsx`: Test tool approval and denial callbacks.
2. **Regression Gate**:
   - 100% pass rate across all 57+ existing test suites.
   - Zero TypeScript static analysis errors (`pnpm tsc --noEmit`).
