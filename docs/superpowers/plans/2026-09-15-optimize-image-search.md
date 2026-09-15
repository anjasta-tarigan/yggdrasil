# Optimize Image Search Behavior and Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize `image_search` retrieval and rendering so that images are concise (1-2 images max), authoritative, deduplicated, and rendered before the AI text explanation (**Images First → AI Explanation Second**).

**Architecture:**
- Multi-tier source authority classification (Tier 1 official/archives > Tier 2 reference/journalism > Tier 3 general, with penalties for watermarked/social media/scrapers) in `src/lib/image-search.ts`.
- Selection algorithm choosing best candidate (image 1) and second-best distinct candidate (image 2 only when distinct and non-redundant).
- Tool schema and system prompt protocols enforcing single-query default and strict behavioral rules.
- Dedicated image-first layout in `src/components/chat/MessageParts.tsx` placing `ImageGallery` above `MessageResponse`, with multi-call consolidation capping normal display to at most 2 images.
- Responsive image cards in `src/components/chat/ImageGallery.tsx` supporting 1-image prominent and 2-image grid views with graceful broken-image collapsing.

**Tech Stack:** Next.js 16, React 19, Tailwind CSS v4, AI SDK v7, Zod v4, Vitest, Radix UI Dialog.

**Spec:** Direct user prompt specifying image-first rendering, 1-2 image limits, source authority hierarchy, single-query focus, and SearXNG integration.

## Global Constraints
- Vitest must be executed sequentially (`pnpm vitest run <file>`) to satisfy memory limits.
- Default image count: 1 image for singular requests, max 2 images for normal display.
- Never expose more than 2 images unless explicitly requested (e.g. "Show me 10 photos...").
- Images must render before the AI textual explanation.
- Source attribution links and badges must be preserved.
- Image search failure must never crash or block the AI textual answer.

---

### Task 1: Source Authority Hierarchy and Scoring in `src/lib/image-search.ts`

**Files:**
- Modify: `src/lib/image-search.ts`
- Test: `src/lib/__tests__/image-search.test.ts`

**Interfaces:**
- Produces:
  - `classifySourceTier(domain: string, preferredDomains?: string[]): { tier: 1 | 2 | 3 | -1; score: number }`
  - `scoreImageCandidate(item: ImageSearchResult, queryTokens: string[], preferredDomains?: string[]): number`

- [ ] **Step 1: Write failing unit tests for source tier classification and scoring**
  Add tests verifying:
  - Official/archive domains (`.gov`, `.edu`, `loc.gov`, `si.edu`, `nvidia.com`) return Tier 1.
  - Reputable educational and publication domains (`wikimedia.org`, `wikipedia.org`, `nature.com`, `theverge.com`, `bbc.com`) return Tier 2.
  - General domains return Tier 3.
  - Social media and stock/watermark aggregators (`pinterest.com`, `alamy.com`, `shutterstock.com`) receive penalty (-1).
  - Single trusted source preference: candidates from an authoritative domain rank above general domains.

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run src/lib/__tests__/image-search.test.ts`
  Expected: FAIL with missing tier classification or score functions.

- [ ] **Step 3: Implement `classifySourceTier` and candidate scoring**
  Add domain pattern lists and scoring logic in `src/lib/image-search.ts`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm vitest run src/lib/__tests__/image-search.test.ts`
  Expected: PASS

---

### Task 2: Strict Deduplication and 1–2 Candidate Selection in `src/lib/image-search.ts`

**Files:**
- Modify: `src/lib/image-search.ts`
- Test: `src/lib/__tests__/image-search.test.ts`

**Interfaces:**
- Modifies: `deduplicateAndRankResults(results: ImageSearchResult[], options: ImageSearchOptions): ImageSearchResult[]`
- Produces:
  - `isNearDuplicate(a: ImageSearchResult, b: ImageSearchResult): boolean`
  - Selection of at most 2 distinct candidates for normal requests, preserving up to requested count only when `explicit_count` is passed.

- [ ] **Step 1: Write failing unit tests for 1-2 candidate selection and near-duplicate rejection**
  Add tests verifying:
  - If results contain 10 candidates from SearXNG, normal requests receive at most 2 candidates.
  - If candidate 2 is a near duplicate (same filename or same subject from same domain), candidate 2 is pruned, leaving only candidate 1.
  - If candidate 2 is a distinct, high-value visual view, both candidate 1 and 2 are returned.
  - If user explicitly requested count (e.g. `count: 10` with `is_explicit_gallery`), up to 10 results are returned.

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run src/lib/__tests__/image-search.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement distinct candidate selection and near-duplicate pruning**
  Enhance `deduplicateAndRankResults` with filename stripping, token similarity, and `MAX_DISPLAYED_IMAGES` capping.

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm vitest run src/lib/__tests__/image-search.test.ts`
  Expected: PASS

---

### Task 3: Tool Schema and System Prompt Protocols

**Files:**
- Modify: `src/lib/ai/tools/image.ts`
- Modify: `src/lib/ai/prompt.ts`
- Test: `src/lib/ai/tools/__tests__/image.test.ts`
- Test: `src/lib/ai/__tests__/prompt.test.ts`

**Interfaces:**
- Modifies: `image_search` tool schema (default count: 2, explicit behavioral instruction).
- Modifies: `buildSystemPrompt` protocol 1c (single-query default, authoritative source prioritization, 1-2 image limits).

- [ ] **Step 1: Write failing tests for updated tool description, schema defaults, and system prompt protocols**
  Verify default `count` is 2, description includes selective usage rule, and system prompt contains single-query and image-first guidelines.

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run src/lib/ai/tools/__tests__/image.test.ts src/lib/ai/__tests__/prompt.test.ts`
  Expected: FAIL

- [ ] **Step 3: Update `image_search` tool and system prompt protocols**
  Update `src/lib/ai/tools/image.ts` and `src/lib/ai/prompt.ts`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm vitest run src/lib/ai/tools/__tests__/image.test.ts src/lib/ai/__tests__/prompt.test.ts`
  Expected: PASS

---

### Task 4: Responsive 1-Image & 2-Image Layout in `src/components/chat/ImageGallery.tsx`

**Files:**
- Modify: `src/components/chat/ImageGallery.tsx`
- Test: `src/components/chat/__tests__/image-gallery.test.tsx`

**Interfaces:**
- Modifies: `ImageGallery({ part, maxImages }: ImageGalleryProps)`
- Features:
  - 1 image: Prominent featured layout (`max-w-md sm:max-w-lg`), clean aspect ratio, clear attribution link.
  - 2 images: 2-column responsive layout (`grid-cols-1 sm:grid-cols-2`), stacking gracefully on mobile.
  - Broken image fallback: If 1 image breaks out of 2, collapse smoothly to single working image without showing empty card.
  - Capped to 2 images maximum unless `is_explicit_gallery` is set.

- [ ] **Step 1: Write failing tests for 1-image prominent layout, 2-image grid, and broken-image collapsing**
  Add component tests in `src/components/chat/__tests__/image-gallery.test.tsx`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run src/components/chat/__tests__/image-gallery.test.tsx`
  Expected: FAIL

- [ ] **Step 3: Implement layout refinements and broken-image collapsing**
  Update `src/components/chat/ImageGallery.tsx`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm vitest run src/components/chat/__tests__/image-gallery.test.tsx`
  Expected: PASS

---

### Task 5: Image-First Ordering & Multi-Call Consolidation in `src/components/chat/MessageParts.tsx`

**Files:**
- Modify: `src/components/chat/MessageParts.tsx`
- Test: `src/components/chat/__tests__/message-parts-image.test.tsx`

**Interfaces:**
- Ordering:
  1. `Reasoning`
  2. CoT trails (`ResearchTrail`, `QuestionTrail`, `TaskList`)
  3. `ToolCallsTrail`
  4. `Sources`
  5. `ArtifactChips`
  6. **`ImageGallery` (Consolidated ImageBlock)**
  7. `MessageResponse` (AI textual answer)
- Consolidation: Capping total displayed images across all `image_search` calls in a message to at most 2 for normal requests.

- [ ] **Step 1: Write failing test verifying ImageGallery renders before MessageResponse in DOM order, and multi-call parts are consolidated**
  Add tests in `src/components/chat/__tests__/message-parts-image.test.tsx`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run src/components/chat/__tests__/message-parts-image.test.tsx`
  Expected: FAIL

- [ ] **Step 3: Update `MessageParts.tsx` to render `ImageGallery` before `MessageResponse` and consolidate parts**
  Move `ImageGallery` above `MessageResponse` in `MessageParts.tsx`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm vitest run src/components/chat/__tests__/message-parts-image.test.tsx`
  Expected: PASS

---

### Task 6: Full Verification and Quality Gate

**Files:**
- Check all modified and created files:
  - `src/lib/image-search.ts`
  - `src/lib/__tests__/image-search.test.ts`
  - `src/lib/ai/tools/image.ts`
  - `src/lib/ai/tools/__tests__/image.test.ts`
  - `src/lib/ai/prompt.ts`
  - `src/lib/ai/__tests__/prompt.test.ts`
  - `src/components/chat/ImageGallery.tsx`
  - `src/components/chat/__tests__/image-gallery.test.tsx`
  - `src/components/chat/MessageParts.tsx`
  - `src/components/chat/__tests__/message-parts-image.test.tsx`

- [ ] **Step 1: Run TypeScript type checker**
  Run: `pnpm exec tsc --noEmit`
  Expected: 0 errors

- [ ] **Step 2: Run ESLint on all touched files**
  Run: `pnpm eslint src/lib/image-search.ts src/lib/ai/tools/image.ts src/lib/ai/prompt.ts src/components/chat/ImageGallery.tsx src/components/chat/MessageParts.tsx`
  Expected: 0 errors, 0 warnings

- [ ] **Step 3: Run all unit and integration test suites**
  Run: `pnpm vitest run src/lib/__tests__/image-search.test.ts src/lib/ai/tools/__tests__/image.test.ts src/components/chat/__tests__/image-gallery.test.tsx src/components/chat/__tests__/message-parts-image.test.tsx src/lib/ai/__tests__/prompt.test.ts src/lib/__tests__/web-search.test.ts`
  Expected: All tests PASS
