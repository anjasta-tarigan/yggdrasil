# Production-Ready `image_search` Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a production-grade, secure, multi-provider `image_search` built-in tool for the AI assistant, enabling autonomous retrieval of real web images with source attribution, aspect-ratio/dimension filtering, deduplication, SSRF defense, and a dedicated responsive image gallery UI in the chat response.

**Architecture:** 
- The backend search engine (`src/lib/image-search.ts`) builds upon the project's existing multi-provider search infrastructure (Exa, SearXNG, Firecrawl) with automated priority fallback, quota cooldowns, strict URL validation against SSRF (`src/lib/security/ssrf.ts`), and result deduplication/ranking.
- The AI SDK v7 tool definition (`src/lib/ai/tools/image.ts`) defines an explicit Zod input schema with bounds and clamps, registering into `builtinTools` (`src/lib/ai/tools/index.ts`).
- Dynamic prompt protocols (`src/lib/ai/prompt.ts`) guide the LLM on precise query generation, autonomous invocation for visual references, and natural response synthesis.
- The frontend chat renderer (`src/components/chat/ImageGallery.tsx` and `src/components/chat/MessageParts.tsx`) transforms tool outputs into a responsive, accessible image gallery with image error fallbacks, source attribution badges, and Radix Dialog lightboxes.

**Tech Stack:** TypeScript, Next.js 16 (App Router), AI SDK v7 (`ai`), Zod v4, React 19, Tailwind CSS v4, Radix UI Dialog, Lucide React, Vitest.

**Spec:** Task specification for production-ready `image_search` tool.

## Global Constraints

- **Single sequential test runs:** Never run concurrent `vitest` processes to prevent memory exhaustion (Rule 18). Always use `pnpm vitest run <file>`.
- **SSRF & URL Security:** All retrieved URLs must be HTTP/HTTPS only. Localhost, loopback (127.0.0.0/8, ::1), private IPv4/IPv6, cloud metadata (169.254.169.254), and internal domain suffixes must be rejected.
- **Untrusted external data:** All metadata (title, alt_text, source_name) must be sanitized and bounded against prompt injection and excessive payload sizes. No executable script/HTML tags.
- **Graceful degradation:** Provider failures, missing API keys, or empty results must never crash the stream or chat turn; the AI must still deliver its normal textual answer.
- **Clean attribution:** Every image displayed must retain its original source domain/name and links to the source webpage/image.

---

## File Structure

```
src/
├── lib/
│   ├── image-search.ts                      # Core multi-provider search engine, ranking, deduplication, SSRF checks
│   ├── __tests__/
│   │   └── image-search.test.ts             # Comprehensive unit tests for search engine & providers
│   └── ai/
│       ├── prompt.ts                        # Added image_search protocol guidelines for the LLM
│       └── tools/
│           ├── image.ts                     # AI SDK v7 image_search tool definition & schema
│           ├── index.ts                     # Builtin tool registration (exports image_search)
│           └── __tests__/
│               └── image.test.ts            # Tool contract & execution tests
├── components/
│   ├── chat/
│   │   ├── ImageGallery.tsx                 # Responsive image grid/cards, lightbox, error fallbacks, attribution
│   │   ├── MessageParts.tsx                 # Integration of ImageGallery and image sources
│   │   └── __tests__/
│   │       └── image-gallery.test.tsx       # Component tests for image gallery & interactions
│   └── settings/
│       └── tools-tab.tsx                    # Image search status & toggle
├── app/
│   └── api/
│       └── settings/
│           └── route.ts                     # Tool readiness status for image_search
└── env.ts                                   # Verification of search provider environment variables
```

---

### Task 1: Core Multi-Provider Image Search Engine (`src/lib/image-search.ts`)

**Files:**
- Create: `src/lib/image-search.ts`
- Test: `src/lib/image-search.test.ts` (placed in `src/lib/__tests__/image-search.test.ts`)

**Interfaces:**
- Produces:
  ```typescript
  export type ImageSearchResult = {
    title: string;
    image_url: string;
    thumbnail_url?: string;
    source_url?: string;
    source_name?: string;
    width?: number;
    height?: number;
    mime_type?: string;
    alt_text?: string;
    rank: number;
  };

  export type ImageSearchOptions = {
    count?: number;
    safe_search?: boolean;
    preferred_domains?: string[];
    aspect_ratio?: "square" | "portrait" | "landscape" | "any";
    min_width?: number;
    min_height?: number;
    timeoutMs?: number;
  };

  export type ImageSearchOutcome = {
    query: string;
    provider: "exa" | "searxng" | "firecrawl";
    results: ImageSearchResult[];
    attempts: Array<{ provider: string; ok: boolean; error?: string }>;
  };

  export function runImageSearch(
    query: string,
    options?: ImageSearchOptions
  ): Promise<ImageSearchOutcome>;
  ```

- [ ] **Step 1: Write the failing tests**
  Create `src/lib/__tests__/image-search.test.ts` covering:
  - Provider dispatch (Exa, SearXNG, Firecrawl)
  - Parameter handling (`count`, `safe_search`, `preferred_domains`, `aspect_ratio`, `min_width`, `min_height`)
  - Deduplication of identical image URLs and canonical URL cleaning
  - SSRF protection: blocking `javascript:`, `file:`, `localhost`, `127.0.0.1`, `169.254.169.254`, `10.0.0.1`, `metadata.google.internal`
  - Fallback chain on provider errors & quota cooldowns
  - Text and metadata sanitization (stripping HTML tags, bounding length)
  - Empty search results handling

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run src/lib/__tests__/image-search.test.ts`
  Expected: FAIL with module not found or functions undefined.

- [ ] **Step 3: Implement `src/lib/image-search.ts`**
  Implement:
  - Sanitization helpers: `sanitizeText`, `cleanUrl`
  - SSRF validator: `isSafeImageUrl` using URL checks and IP checks from `@/lib/security/ssrf`
  - Deduplication: Map by normalized image URL
  - Filtering: `matchesAspectRatio`, `matchesDimensions`
  - Ranking: Prioritize domains in `preferred_domains` and official/authoritative top-level domains
  - Exa adapter: fetches `https://api.exa.ai/search` with `contents: { extras: { imageLinks: ... } }`, `includeDomains`, maps `result.image` and `extras.imageLinks`
  - SearXNG adapter: queries `categories=images&format=json`, extracts `img_src`, `thumbnail_src`, `resolution`, `source`
  - Firecrawl adapter: searches `/v2/search`, parses markdown image tags `![alt](url)` and page metadata
  - Fallback orchestration: checks enabled providers, honors quota cooldowns, executes in priority order

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm vitest run src/lib/__tests__/image-search.test.ts`
  Expected: PASS

- [ ] **Step 5: Verify existing search tests remain unaffected**
  Run: `pnpm vitest run src/lib/__tests__/web-search.test.ts`
  Expected: PASS

---

### Task 2: AI SDK v7 Tool Definition & Registration (`src/lib/ai/tools/image.ts`)

**Files:**
- Create: `src/lib/ai/tools/image.ts`
- Modify: `src/lib/ai/tools/index.ts`
- Test: `src/lib/ai/tools/__tests__/image.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export const image_search: Tool<...>;
  ```
- Consumes:
  - `runImageSearch` from `@/lib/image-search`

- [ ] **Step 1: Write the failing tests**
  Create `src/lib/ai/tools/__tests__/image.test.ts` testing:
  - Tool properties: `description`, `inputSchema`
  - Schema validation: query required, count defaults to 4, clamped between 1 and 10, valid optional parameters
  - Tool execution: invokes `runImageSearch` and returns structured JSON
  - Error tolerance: handles missing providers or backend errors gracefully without unhandled crashes

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run src/lib/ai/tools/__tests__/image.test.ts`
  Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/lib/ai/tools/image.ts` and register in `index.ts`**
  - Define `image_search` with AI SDK `tool({...})` using `zod` schema matching all task requirements
  - Add clear, actionable description instructing the LLM on appropriate autonomous invocation
  - Wire into `builtinTools` in `src/lib/ai/tools/index.ts`

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm vitest run src/lib/ai/tools/__tests__/image.test.ts`
  Expected: PASS

- [ ] **Step 5: Verify all tools index exports compile and test passes**
  Run: `pnpm vitest run src/lib/ai/tools/__tests__/web.test.ts`
  Expected: PASS

---

### Task 3: System Prompt Protocols for Image Search (`src/lib/ai/prompt.ts`)

**Files:**
- Modify: `src/lib/ai/prompt.ts:133-145`
- Test: `src/lib/ai/__tests__/prompt.test.ts`

**Interfaces:**
- Consumes:
  - Active tool names in `buildToolProtocolsBlock`
- Produces:
  - Detailed system prompt instructions for `image_search`

- [ ] **Step 1: Write failing test in `src/lib/ai/__tests__/prompt.test.ts`**
  Add a test verifying that when `image_search` is present in `activeTools`, the prompt includes:
  - Guidelines on when to use `image_search` (visual subjects, products, people, diagrams, landmarks)
  - Clear distinction between `image_search` (retrieval) vs `web_search` (text facts) vs image generation
  - Instructions on creating high-quality, specific search queries
  - Explaining that images are displayed automatically in the visual gallery alongside the text response

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run src/lib/ai/__tests__/prompt.test.ts`
  Expected: FAIL with assertion on image search guidelines.

- [ ] **Step 3: Update `src/lib/ai/prompt.ts`**
  Add `image_search` protocol block in `buildToolProtocolsBlock`:
  - Autonomous triggering for visual queries
  - High-precision query generation guidelines
  - Natural textual synthesis referencing the visual gallery

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm vitest run src/lib/ai/__tests__/prompt.test.ts`
  Expected: PASS

---

### Task 4: Frontend Image Gallery Component (`src/components/chat/ImageGallery.tsx`)

**Files:**
- Create: `src/components/chat/ImageGallery.tsx`
- Test: `src/components/chat/__tests__/image-gallery.test.tsx`

**Interfaces:**
- Produces:
  ```typescript
  export type ImageGalleryProps = {
    part: ToolUIPart | DynamicToolUIPart;
  };
  export function ImageGallery(props: ImageGalleryProps): React.JSX.Element | null;
  ```
- Consumes:
  - Radix Dialog (`@/components/ui/dialog`)
  - Icons from `lucide-react` (`ImageIcon`, `ExternalLinkIcon`, `Maximize2Icon`, `AlertCircleIcon`)

- [ ] **Step 1: Write the failing tests**
  Create `src/components/chat/__tests__/image-gallery.test.tsx` testing:
  - Streaming/loading state renders query and loading animation
  - Error state renders graceful fallback note
  - Successful output renders grid of images with alt text, title, and source attribution
  - Broken image (`onError`) swaps to fallback container without crashing layout
  - Clicking an image card opens the lightbox Dialog with high-res view and source link
  - External link button opens original source URL with `rel="noopener noreferrer"`

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run src/components/chat/__tests__/image-gallery.test.tsx`
  Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/components/chat/ImageGallery.tsx`**
  - Implement loading state with pulse/shimmer and query badge
  - Implement responsive card layout (1 image featured, 2-4 in responsive grid, 5+ in compact grid)
  - Implement `ImageCard` with `useState(false)` for `hasError`
  - Implement source attribution badge linking to originating webpage
  - Implement lightbox dialog displaying image, full title, dimensions, and direct link

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm vitest run src/components/chat/__tests__/image-gallery.test.tsx`
  Expected: PASS

---

### Task 5: Integrate `ImageGallery` into `MessageParts.tsx`

**Files:**
- Modify: `src/components/chat/MessageParts.tsx`
- Test: `src/components/chat/__tests__/message-parts-image.test.tsx`

**Interfaces:**
- Consumes:
  - `ImageGallery` from `./ImageGallery`
  - `image_search` tool parts in `message.parts`

- [ ] **Step 1: Write the failing tests**
  Create `src/components/chat/__tests__/message-parts-image.test.tsx` testing:
  - Assistant message containing `image_search` tool part renders `ImageGallery`
  - `image_search` is excluded from generic `ToolCallsTrail` / `ToolInvocation`
  - Image sources are extracted and added to `Sources` references list
  - Text response and images co-exist cleanly

- [ ] **Step 2: Run test to verify it fails**
  Run: `pnpm vitest run src/components/chat/__tests__/message-parts-image.test.tsx`
  Expected: FAIL

- [ ] **Step 3: Update `src/components/chat/MessageParts.tsx`**
  - Identify `image_search` parts (`imageSearchParts`)
  - Exclude `image_search` from `genericParts`
  - In sources extraction loop, include `source_url` from `image_search` results in `sourcesList`
  - Render `imageSearchParts` with `<ImageGallery />` positioned alongside the response text

- [ ] **Step 4: Run test to verify it passes**
  Run: `pnpm vitest run src/components/chat/__tests__/message-parts-image.test.tsx`
  Expected: PASS

- [ ] **Step 5: Verify existing message parts tests pass**
  Run: `pnpm vitest run src/components/chat/__tests__/question-trail.test.tsx`
  Expected: PASS

---

### Task 6: Settings API & Tools Tab Integration (`src/app/api/settings/route.ts`)

**Files:**
- Modify: `src/app/api/settings/route.ts`
- Test: `src/app/api/__tests__/settings-api.test.ts`

- [ ] **Step 1: Update `src/app/api/settings/route.ts`**
  - Handle `name === "image_search"` in tool list resolution:
    Mark `configured: isImageSearchConfigured()` (checks Exa/Firecrawl/SearXNG credentials)
    Specify `requires: "EXA_API_KEY / FIRECRAWL_API_KEY / SEARXNG_BASE_URL (any)"`

- [ ] **Step 2: Run settings tests**
  Run: `pnpm vitest run src/app/api/__tests__/settings-api.test.ts`
  Expected: PASS

---

### Task 7: Documentation & Quality Gate Verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Update `.env.example` & `README.md`**
  - Document `image_search` capabilities, configuration, and fallback behavior
  - Document supported parameters and query guidelines

- [ ] **Step 2: Run all relevant test suites**
  Run:
  - `pnpm vitest run src/lib/__tests__/image-search.test.ts`
  - `pnpm vitest run src/lib/ai/tools/__tests__/image.test.ts`
  - `pnpm vitest run src/components/chat/__tests__/image-gallery.test.tsx`
  - `pnpm vitest run src/components/chat/__tests__/message-parts-image.test.tsx`
  - `pnpm vitest run src/lib/ai/__tests__/prompt.test.ts`
  - `pnpm vitest run src/lib/__tests__/web-search.test.ts`

- [ ] **Step 3: Run TypeScript type-checking**
  Run: `pnpm exec tsc --noEmit`
  Expected: Clean compilation with 0 errors.

---
