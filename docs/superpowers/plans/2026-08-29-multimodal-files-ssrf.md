# Multimodal File Ingestion, Content Understanding & Secure URL Fetching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement universal file content understanding (images for vision models, decoded code/text/data blocks for all models) and secure URL fetching with SSRF protection conforming to Rule 04.

**Architecture:**
- **File Content Understanding (`src/lib/ai/attachments.ts`)**:
  - Decode text and source code data URLs (`.ts`, `.py`, `.json`, `.csv`, `.md`, etc.) into structured syntax blocks (`[Attached File: filename]`) on the server so 100% of models can read and reason over uploaded code.
  - Retain native `image/*` file parts for vision models.
- **SSRF Defense (`src/lib/security/ssrf.ts`)**:
  - DNS resolution and private IP / loopback / cloud metadata blocking (`127.0.0.0/8`, `169.254.169.254`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`).
  - Safe `secureFetch()` with redirect validation, 10MB limit, and 10s timeout.
- **Tool & Chat Route Integration**:
  - Apply `processIncomingMessageAttachments` in `src/app/api/chat/route.ts`.
  - Apply `secureFetch` in `fetch_page` tool in `src/lib/ai/tools.ts` and `experimental_download` in `streamText`.
- **UI Enhancements**:
  - Wire screenshot action (`<PromptInputActionAddScreenshot>`) in `src/app/page.tsx`.

**Tech Stack:** Next.js 16, AI SDK v7, `node:dns/promises`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-multimodal-files-ssrf-design.md`

## Global Constraints
- Strictly adhere to Rule 04 (SSRF Protection).
- Maximum 5 files per turn; max 10MB per file.
- Zero regressions across existing test suites (61 test files, 524 tests).

---

### Task 1: SSRF Defense & Secure URL Fetching Module

**Files:**
- Create: `src/lib/security/ssrf.ts`
- Create: `src/lib/security/__tests__/ssrf.test.ts`

**Interfaces:**
- Consumes: `node:dns/promises`, `node:net`
- Produces:
  - `isPrivateOrBlockedIP(ip: string): boolean`
  - `assertSafeUrl(urlStr: string): Promise<URL>`
  - `secureFetch(urlStr: string, options?: RequestInit): Promise<Response>`

- [ ] **Step 1: Write unit tests in `src/lib/security/__tests__/ssrf.test.ts`**
- [ ] **Step 2: Implement `src/lib/security/ssrf.ts` with DNS resolution and private IP blocking**
- [ ] **Step 3: Run tests: `pnpm vitest run src/lib/security/__tests__/ssrf.test.ts`**
- [ ] **Step 4: Commit Task 1**

---

### Task 2: Server-Side Universal File Content Extraction

**Files:**
- Create: `src/lib/ai/attachments.ts`
- Create: `src/lib/ai/__tests__/attachments.test.ts`

**Interfaces:**
- Consumes: `UIMessage`, `FileUIPart`
- Produces: `processIncomingMessageAttachments(messages: UIMessage[]): Promise<UIMessage[]>`

- [ ] **Step 1: Write unit tests in `src/lib/ai/__tests__/attachments.test.ts`**
- [ ] **Step 2: Implement `src/lib/ai/attachments.ts` to decode text/code files into markdown blocks and preserve images**
- [ ] **Step 3: Run tests: `pnpm vitest run src/lib/ai/__tests__/attachments.test.ts`**
- [ ] **Step 4: Commit Task 2**

---

### Task 3: Chat Route & Tool Integration

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/lib/ai/tools.ts`

**Interfaces:**
- Consumes: `processIncomingMessageAttachments`, `secureFetch`
- Produces:
  - Multimodal messages with decoded code blocks in `/api/chat`.
  - SSRF-protected `fetch_page` tool execution.
  - `experimental_download` configured on `streamText`.

- [ ] **Step 1: Integrate `processIncomingMessageAttachments` in `src/app/api/chat/route.ts`**
- [ ] **Step 2: Upgrade `fetch_page` in `src/lib/ai/tools.ts` to use `secureFetch`**
- [ ] **Step 3: Run chat API tests: `pnpm vitest run src/app/api/__tests__/chats-api.test.ts`**
- [ ] **Step 4: Commit Task 3**

---

### Task 4: UI Screenshot & Staged Attachment Action Integration

**Files:**
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `<PromptInputActionAddScreenshot>`
- Produces: Screenshot capture button in prompt tools menu.

- [ ] **Step 1: Add `<PromptInputActionAddScreenshot>` to prompt input action menu in `src/app/page.tsx`**
- [ ] **Step 2: Run component tests: `pnpm vitest run src/components/__tests__/attachments.test.tsx`**
- [ ] **Step 3: Commit Task 4**

---

### Task 5: Full Regression & System Verification Pass

**Files:**
- Test: All test files across `src/`

- [ ] **Step 1: Run complete test suite (`pnpm vitest run`)**
- [ ] **Step 2: Run static typecheck (`pnpm tsc --noEmit`)**
- [ ] **Step 3: Commit and push final changes**
