# AI SDK v7 Multimodal Attachments, Citations, Structured Output & Message Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full multimodal file attachments (images, PDFs, code files) with vision upload, hybrid source document citations (`SourceDocumentUIPart`, `<Sources>`, `<InlineCitation>`), structured data generation (`Output.object`), and interactive message actions (copy, regenerate, branch) across regular chat and project harness.

**Architecture:**
- **Multimodal Pipeline**: `<PromptInput>` file upload and paste listener converting `FileList` to `FileUIPart[]` data URLs, passed through `useChat({ files })` and mapped to vision model parts via `convertToModelMessages()`.
- **Citations & Sources**: Emission of `SourceDocumentUIPart` in stream responses for web search/memory results, rendered with collapsible `<Sources>` trays and interactive `<InlineCitation>` hover-card badges in assistant markdown.
- **Structured Data Generation**: Upgrade memory consolidation (`src/lib/memory/consolidation.ts`) to use AI SDK v7 `generateText` with `Output.object({ schema: consolidationSchema })`.
- **Message Actions**: `<MessageActions>` toolbar with one-click copy, regeneration, and prompt retry.

**Tech Stack:** Next.js 16, AI SDK v7 (`ai`, `@ai-sdk/openai-compatible`), Radix UI, Tailwind CSS v4, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-ai-sdk-v7-multimodal-citations-actions-design.md`

## Global Constraints
- Maximum 5 files per turn; max file size 10MB (Rule 06 / isolation).
- No silent errors (Rule 02) and no N+1 database queries (Rule 12).
- Zero regressions across existing test suites (49 test files).

---

### Task 1: Structured Memory Consolidation with `Output.object`

**Files:**
- Modify: `src/lib/memory/consolidation.ts`
- Modify: `src/lib/memory/__tests__/ingestion.test.ts`
- Create: `src/lib/memory/__tests__/consolidation.test.ts`

**Interfaces:**
- Consumes: `Output.object` from `ai`, `defaultModel` from `@/lib/ai/provider`
- Produces: `consolidateEpisodicMemories` with schema-validated structured summary extraction

- [ ] **Step 1: Write unit tests for structured consolidation in `src/lib/memory/__tests__/consolidation.test.ts`**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Update `src/lib/memory/consolidation.ts` with `Output.object` and Zod schema validation**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit Task 1**

---

### Task 2: Multimodal Attachments & Vision Upload Pipeline

**Files:**
- Modify: `src/components/ai-elements/prompt-input.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/components/projects-view.tsx`
- Create: `src/components/__tests__/attachments.test.tsx`

**Interfaces:**
- Consumes: `FileUIPart`, `convertBlobUrlToDataUrl`, `<Attachments>`
- Produces: Drag-and-drop / file picker / paste upload flow for images and documents in prompt input, and grid preview in messages.

- [ ] **Step 1: Write component tests for file conversion and staged attachment tray in `attachments.test.tsx`**
- [ ] **Step 2: Update `prompt-input.tsx` with file upload trigger and data URL conversion**
- [ ] **Step 3: Update `src/app/page.tsx` and `src/components/projects-view.tsx` to handle `FileUIPart[]` in `sendMessage` and render `<Attachments>` gallery**
- [ ] **Step 4: Run component tests**
- [ ] **Step 5: Commit Task 2**

---

### Task 3: Source Documents & Hybrid Inline Citations

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/components/projects-view.tsx`
- Create: `src/components/__tests__/inline-citation.test.tsx`

**Interfaces:**
- Consumes: `<Sources>`, `<Source>`, `<InlineCitation>`, `SourceDocumentUIPart`
- Produces: Numbered inline citation markers and collapsible sources drawer for search and document results.

- [ ] **Step 1: Write component tests for citation hover-cards in `inline-citation.test.tsx`**
- [ ] **Step 2: Update `MessageParts` in `src/app/page.tsx` and `src/components/projects-view.tsx` to render `<Sources>` and parse inline citation markers**
- [ ] **Step 3: Run citation tests**
- [ ] **Step 4: Commit Task 3**

---

### Task 4: Interactive Message Actions Toolbar (Copy & Regenerate)

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/components/projects-view.tsx`
- Create: `src/components/__tests__/message-actions.test.tsx`

**Interfaces:**
- Consumes: `<MessageActions>`, `regenerate` from `useChat`
- Produces: Hover toolbar on message rows with copy and regenerate actions.

- [ ] **Step 1: Write tests for copy and regenerate message actions**
- [ ] **Step 2: Wire `<MessageActions>` toolbar into message rows in `page.tsx` and `projects-view.tsx`**
- [ ] **Step 3: Run message action tests**
- [ ] **Step 4: Commit Task 4**

---

### Task 5: Full Regression & System Verification Pass

**Files:**
- Test: All test suites in `src/`

- [ ] **Step 1: Run full test suite (`pnpm vitest run`)**
- [ ] **Step 2: Run TypeScript static analysis (`pnpm tsc --noEmit`)**
- [ ] **Step 3: Commit and push final changes**
