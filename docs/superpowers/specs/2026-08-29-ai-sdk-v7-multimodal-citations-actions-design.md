# Architectural Specification: AI SDK v7 Multimodal Attachments, Inline Citations, Structured Output & Message Actions

**Date:** 2026-08-29  
**Status:** Approved  
**Authors:** Anjasta Bagus Tarigan & Yggdrasil Cognitive Architecture Team  

---

## 1. Executive Summary

This specification establishes the architecture for:
1. **Multimodal File Attachments & Vision Pipeline**: Full support for drag-and-drop, clipboard paste, and file picker uploads (images, PDFs, code files) converted to `FileUIPart` data URLs and mapped to multimodal model parts (`convertToModelMessages`).
2. **Hybrid Research Trail & Numbered Inline Citations**: Integration of `SourceDocumentUIPart`, top collapsible `<Sources>` trays, and interactive `<InlineCitation>` hover-card badges in assistant markdown.
3. **Structured Data Generation (`Output.object`)**: Standardization of backend memory consolidation and skill parameters on AI SDK v7 `Output.object({ schema })`.
4. **Interactive Message Actions**: Hover action toolbars (`<MessageActions>`) with copy to clipboard and regenerate/retry across both regular chat and project harness.

---

## 2. Multimodal Attachments Architecture

### 2.1 File Attachment Specifications
- **Supported Formats**:
  - Images: `image/png`, `image/jpeg`, `image/webp`, `image/gif`
  - Documents: `application/pdf`
  - Code & Text: `text/*`, `.ts`, `.tsx`, `.js`, `.json`, `.py`, `.rs`, `.md`, `.csv`, `.yaml`, `.sql`
- **Limits**: Maximum 5 files per turn; max 10MB per file.

### 2.2 Client-Side Conversion & UI Flow
- `<PromptInput>` provides:
  - Drag-and-drop zone overlay.
  - File picker button (`<input type="file" multiple />`).
  - Clipboard image paste listener in `<PromptInputTextarea>`.
- Files are converted to data URLs using `convertFilesToDataURLs(files: FileList)` and stored as `AttachmentData[]`.
- Staged attachments display in an `<Attachments variant="inline">` tray inside the prompt box with removal buttons (`XIcon`).
- On submit, `sendMessage({ text, files: fileUIParts })` packages attachments as `FileUIPart[]`.

### 2.3 Backend Handling & Vision Model Compatibility
- Both `/api/chat` and `/api/projects/chat` receive messages with file parts.
- `convertToModelMessages` converts `FileUIPart` objects to standard model image and document parts.
- Vision-capable models (Claude 3.7, GPT-4o, Gemini 2.0, Ollama LLaVA/Qwen-VL) receive multimodal payloads natively.

### 2.4 Message Gallery Rendering
- User messages with file parts render an `<Attachments variant="grid">` gallery displaying:
  - Image thumbnails with hover-card zoom preview.
  - Document & PDF badges with filename and size.
  - Text file chips with syntax icon.

---

## 3. Hybrid Research Trail & Numbered Inline Citations

### 3.1 Source Document Emission
- When `web_search` or `fetch_page` completes, search results are formatted into source metadata records:
  ```typescript
  type SourceDocument = {
    sourceId: string; // e.g. "source-1", "source-2"
    title: string;
    url: string;
    snippet?: string;
  };
  ```
- Emitted in the message stream as `source-document` parts (`SourceDocumentUIPart`).

### 3.2 Frontend Citation Visualizer
- **Top Collapsible `<Sources count={N}>` Tray**:
  - Renders above the assistant response when source parts exist.
  - Clicking expands a grid of `<Source>` cards with favicons, titles, and links.
- **`<ChainOfThought>` Research Trail**:
  - Positioned directly beneath `<Sources>` to show live search query step-by-step progress (`Searching for "..." → via Exa/Firecrawl`).
- **Interactive `<InlineCitation>`**:
  - Markdown renderer intercepts citation references (`[1]`, `[2]`, `[source-N]`) and renders an interactive `<InlineCitation index={N} source={source}>` badge with hover-card preview.

---

## 4. Structured Data Generation (`Output.object`)

- **Memory Consolidation (`src/lib/memory/consolidation.ts`)**:
  - Upgrades `defaultSummarizer` to use `generateText` with `Output.object({ schema: consolidationSchema })`:
    ```typescript
    export const consolidationSchema = z.object({
      summary: z.string().describe("Concise summary of enduring facts and user preferences"),
      extractedFacts: z.array(z.object({
        content: z.string(),
        category: z.string(),
        importance: z.number().min(0).max(1),
      })),
    });
    ```
  - Replaces fragile text prompts with constrained decoding, providing high-reliability fact extraction.

---

## 5. Interactive Message Actions (`<MessageActions>`)

- Added to assistant and user message rows across `src/app/page.tsx` and `src/components/projects-view.tsx`:
  - **Copy Action**: Copies message markdown text with checkmark feedback.
  - **Regenerate Action**: Re-runs generation from the previous user message.
  - **Smooth hover transition**: Appears subtly on message hover without visual clutter.

---

## 6. Test Plan

1. **Unit & Integration Tests**:
   - `src/lib/memory/__tests__/consolidation.test.ts`: Verify `Output.object` consolidation schema extraction.
   - `src/components/__tests__/message-actions.test.tsx`: Test copy and regenerate button handlers.
   - `src/components/__tests__/attachments.test.tsx`: Test file conversion, attachment tray rendering, and removal.
2. **Full Regression Gate**:
   - 100% pass across all 49+ existing test suites.
   - Zero TypeScript compilation errors (`pnpm tsc --noEmit`).
