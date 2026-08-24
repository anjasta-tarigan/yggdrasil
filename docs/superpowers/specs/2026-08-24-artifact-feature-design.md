# 2026-08-24: Artifact Panel via `create_artifact` Tool

## Status: Approved with revisions (awaiting post-revision sign-off)

**Reviewer**: [internal code review]
**Revision applied**: All 10 items from review, committed `83e5a1f`.

## 1. Context & Problem Statement

**Yggdrasil** is a self-hosted chat UI (Next.js 16 App Router, AI SDK `ai@7` + `@ai-sdk/react@4`, vLLM provider). The model has three working tools (`web_search`, `fetch_page`, `manage_tasks`) rendered as typed tool parts in `UIMessage.parts`.

The model sometimes produces substantial, self-contained deliverables (code files, HTML demos, SVGs, long reports) the user wants to view separately, copy, or download. An **Artifacts** feature surfaces these in a dockable side panel.

### Prior attempts (why this spec exists)

Two implementations were built and reverted the same day:

1. **Tag-based** (`2ba686e` → reverted `96c6111`): Model emitted `<artifact>` tags in prose; a streaming parser scanned message text. Reverted — **fragile**: delimiter collisions, mid-stream state, tool-call XML bleed.
2. **Tool + heuristic** (`f2a7712`/`7770f80` → removed `08aebf0`): A `create_artifact` tool plus a client-side text heuristic that detected large code blocks / long prose. The tool approach worked; the heuristic text-parsing was the fragile part.

**This spec adopts approach #2's server tool (the proven part) but drops the text-parsing heuristic entirely.** Robustness is the priority.

## 2. Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| How model produces artifacts | **Tool call** (`create_artifact`) | Leverages existing `tool-${name}` pipeline; no custom text parsing; deterministic; matches `manage_tasks` precedent |
| Content detection | Tool outputs only | No fragile prose scanning; each tool call = one artifact |
| Versioning | None in v1 | Each `create_artifact` call is independent; reopen = new call. Simpler than identifier-based versioning groups |
| Panel behavior | Auto-open latest + chips to reopen | Matches Claude/Code mode mental model |
| React artifact rendering | Sandboxed iframe + CDN Babel | Host app never evals artifact code (Rule 04) |
| HTML rendering | Sandboxed iframe, `srcDoc` | No `allow-same-origin` = opaque origin (Rule 04) |
| SVG rendering | `<img>` data-URL | Scripts in `<img>` context never execute (Rule 04) |

## 3. Components & Files

### 3.1 New: `src/lib/ai/tools.ts` — `create_artifact` tool

Add a fourth tool to `chatTools` (pure passthrough, like `manage_tasks`):

```typescript
create_artifact: tool({
  description: `Save a standalone deliverable — a self-contained code file, HTML/CSS/JS demo, SVG graphic, React component, or document — that the user will want as a distinct, reusable file. Use it for content that belongs in its own file: complete programs, demos, graphics, reports. Do NOT use it for short snippets or brief explanations that illustrate a point inline — inline those in your reply. Pass the full content here; a one-line summary in prose is sufficient, do not repeat the content.`,
  inputSchema: z.object({
    title: z.string().min(1).max(80).describe(
      "Short human-readable title, e.g. 'Fibonacci generator in Rust'"
    ),
    kind: z.enum(["code", "document"]).describe(
      "'code' for programs, scripts, HTML/SVG/JSX; 'document' for markdown/prose"
    ),
    language: z.string().optional().describe(
      "Programming language for syntax highlighting, e.g. 'typescript', 'python'. Required for kind='code'"
    ),
    content: z.string().min(1).describe("The complete artifact content"),
  }),
  execute: async ({ title, kind, language, content }) => ({
    title, kind, language, content,
  }),
})
```

**Schema validation rationale**: `content` has no hard max — the model controls its own output size. The `CodeBlock` and renderers already use `overflow-auto`. A `min(1)` guard prevents empty artifacts. `language` is optional at the schema level (the model may omit it); the client normalizes/validates it against shiki's available languages.

### 3.2 New: `src/lib/artifacts.ts` — pure detection + metadata

Pure functions, no React. Converts tool parts into `ChatArtifact` objects.

```typescript
// Types
export type ArtifactKind = "code" | "document";

export type ChatArtifact = {
  id: string;              // toolCallId — stable key
  kind: ArtifactKind;
  title: string;
  description: string;
  content: string;
  language?: string;       // normalized shiki BundledLanguage or undefined
  filename: string;        // safe download filename
};

// Core: scan messages for create_artifact outputs
export function collectArtifacts(
  messages: readonly UIMessage[]
): ChatArtifact[];

// Newest artifact (for auto-open)
export function latestArtifact(
  messages: readonly UIMessage[]
): ChatArtifact | null;

// Helpers
export function slugify(value: string, fallback: string): string;
export function buildArtifactFilename(artifact: ChatArtifact): string;
export function downloadTextFile(filename: string, content: string): void;
```

**Logic**: Walk `messages` backwards, find `tool-create_artifact` parts with `state: "output-available"`, map through `buildArtifactFromToolOutput`. The `id` is the `toolCallId` — stable across re-renders and persisted with the message. `buildArtifactFromToolOutput` validates the output shape, normalizes `language` via `shiki`'s `bundledLanguages`, and derives a safe filename (slugified title + correct extension).

**Language normalization**: Uses `shiki@3` `bundledLanguages` map to validate against supported highlight languages. Unrecognized → `language` is `undefined` and the renderer falls back to plain `<pre>` (no exception).

**No text parsing**. No `extractCodeBlocks`, no `partialOpenTagLength`, no holdback logic. This eliminates the entire fragility class.

**Filename extension mapping** (applied in `buildArtifactFilename`):

| `kind` | `language` | Extension |
|---|---|---|
| `document` | (any) | `.md` |
| `code` | `typescript` / `ts` | `.ts` |
| `code` | `tsx` | `.tsx` |
| `code` | `javascript` / `js` / `jsx` | `.jsx` |
| `code` | `python` / `py` | `.py` |
| `code` | `rust` / `rs` | `.rs` |
| `code` | `go` | `.go` |
| `code` | `json` | `.json` |
| `code` | `bash` / `sh` / `shell` | `.sh` |
| `code` | `html` | `.html` |
| `code` | `css` / `scss` | `.{ext}` |
| `code` | (any other recognized) | `.{language-raw}` |
| `code` / `document` | unrecognized or none | `.txt` |

### 3.3 New: `src/components/artifact-panel.tsx` — docked split pane

Based on the proven `7770f80` design (Claude-style docked split pane):

- **Desktop**: Sibling column of the chat; `flex` container shrinks chat while panel stays fixed-width. Resize handle on the left edge (drag to set width, persisted to `localStorage`).
- **Mobile**: `position: fixed` full-viewport slide-over from the right, `translate-x` for enter/exit animation.
- **Open/Close**: `open` prop controls; on close, the panel stays mounted for the slide-out animation (via `closingArtifact` state in `ChatArea`), then unmounts.
- **Escape key**: closes the panel; focus returns to the last-triggering chip.
- **`inert`**: when closed, the panel is removed from tab order and hidden.
- **Focus management**: On open, focus moves to the panel's header close button. On close, focus returns to the chip that triggered the open (tracked via `event.currentTarget` or a `ref`). The panel is wrapped in a focus-trap container (`tabindex=-1` on the header, `Esc` handler).
- **Header**: `<ArtifactHeader>` with icon, title, description, Copy/Download/Close actions via `<ArtifactActions>`.
- **Body**: Type-specific renderer (see §3.4).
- **Multi-artifact navigation**: When multiple `create_artifact` calls exist in the conversation, the panel shows a compact "stack" indicator (N chips) in the header toolbar. Clicking any chip swaps the panel content to that artifact (sets `openArtifact` to it, clears `pinnedId` so auto-open doesn't fight back). No back-stack history in v1 — it's a flat set of independently-openable artifacts.
- **Width persistence**: `localStorage` under `artifact-panel-width-desktop`, only read on desktop (`window.matchMedia('(hover: hover)')` or `md` breakpoint check). Mobile uses full-viewport width always. Guarded with `try/catch` (non-fatal).

#### 3.3.1 Multi-artifact navigation

When the conversation contains multiple `create_artifact` outputs (e.g., the model created an HTML file and a CSS file in one turn), the panel header displays a compact stack indicator ("2 artifacts"). Clicking any chip in the chat replaces the panel content with that artifact. There is no back-stack in v1 — it is a flat set of independently-openable artifacts, matching the "each call is independent" design decision. Closing the panel does not clear `artifactIndex`; chips remain in the chat to re-open.

### 3.4 New: `src/components/artifact-renderers.tsx` — one file, all renderers

Consolidates the five renderers the prior implementation split across `src/artifacts/renderers/`. Keeps them co-located with the panel for v1 simplicity.

| Kind / Type | Renderer | Security |
|---|---|---|
| `code` | `<CodeBlock code={content} language={...} />` (existing shiki-based component) | Read-only, no eval |
| `document` | `<Streamdown>` via `<MessageResponse>` (existing chat pipeline) | Sanitized markdown |
| HTML content | `<iframe sandbox="allow-scripts allow-forms allow-modals" srcDoc={content} />` | Opaque origin — no cookie/localStorage access, no same-origin requests (Rule 04). **`allow-popups` removed** per review — no concrete use case justifies `window.open` escape. CSP meta injected into `srcDoc` for defense-in-depth. |
| SVG content | `<img src="data:image/svg+xml,..." />` | Image context — scripts never execute (Rule 04) |
| React content | `<iframe sandbox="allow-scripts allow-forms allow-modals" srcDoc={buildRuntimeDoc(content)} />` | Babel transpiles inside the frame; host app never evals (Rule 04). Same sandbox flags as HTML. |

**React runtime doc** (`buildRuntimeDocument`): Injects **pinned** React 19 UMD + Babel Standalone from `cdn.jsdelivr.net` (specific minor versions: `react@19.1.0`, `react-dom@19.1.0`, `@babel/standalone@7.28.4`). The initial `srcDoc` document contains the error-handling script inline (does not depend on Babel loading first) so offline/unreachable-CDN is handled gracefully. A CSP `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' cdn.jsdelivr.net">` is injected into the iframe `<head>` to restrict network egress (defense-in-depth beyond opaque origin). Transpiles and mounts the default-exported component **inside the frame**. On runtime errors, `window.addEventListener('error')` and `window.addEventListener('unhandledrejection')` in the frame catch them and render a self-contained error card (non-fatal — Rule 02 surfaces the error visibly inside the iframe).

### 3.5 Modified: `src/app/page.tsx`

**`ChatArea` additions** (minimal, surgical per Rule 16):

```typescript
// State
const [openArtifact, setOpenArtifact] = useState<ChatArtifact | null>(null);
const [pinnedId, setPinnedId] = useState<string | null>(null);  // user-pinned = immune to auto-swap
const [closingArtifact, setClosingArtifact] = useState<ChatArtifact | null>(null);

// Derived
const artifactIndex = useMemo(() => collectArtifacts(messages), [messages]);
const latest = useMemo(() => latestArtifact(messages), [messages]);

// Auto-open: newest arrives → opens unless user pinned an older one
// (pinned = user explicitly opened it; respects their focus choice).
// During slide-out (closingArtifact set), a newer artifact forces
// immediate swap instead of waiting for the animation to finish.
useEffect(() => {
  if (!latest) return;
  // User pinned: respect their selection, don't auto-swap.
  if (pinnedId) return;
  // A different artifact is currently open → swap to newest immediately.
  if (openArtifact?.id !== latest.id) {
    if (closingArtifact) setClosingArtifact(null); // interrupt exit animation
    setOpenArtifact(latest);
  }
}, [latest, pinnedId, openArtifact, closingArtifact]);
```

**`MessageParts` additions**:
- Accept `onOpenArtifact: (artifact: ChatArtifact) => void` prop.
- For assistant messages, scan tool parts: if `getToolName(part) === "create_artifact"`, handle by `state`:
  - `input-streaming` / `input-available`: render nothing extra (the model is still deciding)
  - `output-available`: build `ChatArtifact`, render `<ArtifactChip>` **and suppress the `<Tool>` card** (the chip is the sole entry point — see §3.5 Note)
  - `output-error`: render an error `<ArtifactChip>` variant (red, with error text) so the user sees the failure inline
  - All other tool names → existing `<Tool>` card behavior (unchanged)

> **§3.5 Note — Tool card suppression**: Unlike `web_search`/`fetch_page`/`manage_tasks` (where the `<Tool>` card *is* the content), `create_artifact`'s content lives in the panel. Rendering both a JSON tool card *and* a chip is visually noisy. The chip is the single entry point; the `<Tool>` card is intentionally omitted for this tool only. A collapsed/inline summary line ("Created artifact: {title}") can optionally appear if the model added prose around the call.

**`ChatArea` return**: Wraps the conversation in a flex row; `ArtifactPanel` is the sibling. Passes `openArtifact ?? closingArtifact` as content, handles close with exit-animation.

**`AppShell`/layout**: No changes — the panel lives entirely within `ChatArea`'s scope.

### 3.6 Modified: `src/app/api/chat/route.ts`

Add the `create_artifact` guidance to the system prompt:

> **create_artifact** — when you produce self-contained, reusable content that the user would save as a distinct file (a complete code file, an HTML/CSS/JS demo, an SVG graphic, a React component, or a report/document), call this tool instead of outputting a fenced code block. Pass the full content here; do not also print it in prose — a one-line summary suffices. Each call is independently viewable in the side panel. Do not use it for brief snippets or explanations that belong inline.

### 3.7 Existing components reused (no changes)

- `@/components/ai-elements/artifact.tsx` — `Artifact`, `ArtifactHeader`, `ArtifactTitle`, `ArtifactDescription`, `ArtifactActions`, `ArtifactAction`, `ArtifactClose`, `ArtifactContent` (vendored, currently unused)
- `@/components/ai-elements/code-block.tsx` — `CodeBlock` (existing shiki-based syntax highlighter)
- `@/components/ai-elements/message.tsx` — `MessageResponse` (Streamdown markdown)

## 4. Data Flow

```
1. Model calls create_artifact({title, kind, language, content})
       │
2. streamText() → toUIMessageStream() → UIMessage.parts
       │           emits: { type: "tool-create_artifact", state: "input-streaming" }
       │           emits: { type: "tool-create_artifact", state: "input-available", input: {...} }
       │           emits: { type: "tool-create_artifact", state: "output-available", output: {...}, toolCallId }
       │
3. Client (useChat): messages stream in
       │
4. MessageParts: for the assistant message, iterates parts
       │  - Non-create_artifact tool parts → <Tool> card (unchanged)
       │  - create_artifact tool part:
       │    - input-streaming/input-available → no chip (still generating)
       │    - output-available → build ChatArtifact → render <ArtifactChip>
       │      (NO <Tool> card — chip is sole entry point, §3.5 Note)
       │    - output-error → render error <ArtifactChip> variant
       │
5. collectArtifacts(messages) computes full list → artifactIndex
       latestArtifact(messages) → newest → auto-opens panel
       │
6. ArtifactPanel: renders content via type-specific renderer (§3.4)
       │  - Copy → navigator.clipboard.writeText(content)
       │  - Download → downloadTextFile(filename, content) → <a download>
       │  - Close → slide-out animation → unmount
```

## 5. Error Handling

| Scenario | Behavior |
|---|---|
| Tool `execute` throws (shouldn't — pure passthrough) | `ToolUIPart` enters `output-error` state; `<Tool>` card shows `errorText`; no chip appears |
| Tool output malformed (missing fields) | `buildArtifactFromToolOutput` returns `null`; `console.warn` with `toolCallId` (explicit non-fatal); chip skipped; no card rendered for that part |
| Shiki can't highlight language | Falls back to plain `<pre>` (no exception) |
| React artifact: CDN unreachable | In-frame error card shows readable message; host app unaffected |
| React artifact: runtime error in code | `window.addEventListener('error')` and `'unhandledrejection'` in frame catch it; shows in-frame error card |
| Panel resize (pointer events) | `pointerup` listener always removed in cleanup (memory-safe per Rule 02) |
| Escape key listener | Added when open, removed on close/unmount (Rule 02) |
| React iframe error listeners | Attached to iframe's `window` (not host window); auto-cleaned when `srcDoc` is replaced or iframe unmounts — no host-side listener leak |
| `localStorage` unavailable | `try/catch` guard — width falls back to CSS default (non-fatal) |
| Clipboard API unavailable | `navigator.clipboard` null check (existing `CodeBlockCopyButton` pattern) |

**No silent failures**: Every error path either surfaces visibly (tool error card, error `<ArtifactChip>`, in-frame error card) or is explicitly non-fatal with a `console.warn` + documented reason (localStorage fallback, language fallback to plain text, malformed tool output skipped).

## 6. Security (Rule 04)

| Threat | Mitigation |
|---|---|
| XSS via HTML artifact | Sandboxed iframe, **no** `allow-same-origin` → opaque origin → no access to parent's cookies, localStorage, DOM, or same-origin requests. Content injected via `srcDoc`, never `dangerouslySetInnerHTML`. CSP meta injected into `srcDoc`: `default-src 'none'; script-src 'self'` for defense-in-depth. |
| XSS via React artifact | Same sandbox; Babel transpiles **inside** the frame; host app never `eval()`s artifact code. CSP meta restricts script-src to `self` + `cdn.jsdelivr.net` |
| XSS via SVG | `<img>` data-URL context → SVG scripts never execute |
| Path traversal in download filename | `slugify` strips `/`, `\\`, and control chars; filename is `slugified-title.ext` only |
| SSRF via artifact content | Artifacts are client-rendered from model output, not fetched from URLs — no SSRF surface |
| Clickjacking | Panel is `inert` when closed; no `X-Frame-Options` concern (it's the app's own frame) |

## 7. Testing Strategy

**File**: `src/lib/__tests__/artifacts.test.ts` (Vitest)

| Test | Purpose |
|---|---|
| `collectArtifacts` finds tool outputs | Correct extraction from `messages` |
| `collectArtifacts` ignores other tools | Only `create_artifact` parts qualify |
| `collectArtifacts` ignores streaming/incomplete parts | Only `state: "output-available"` |
| `collectArtifacts` returns empty for no messages | Edge case |
| `latestArtifact` returns newest | Reverse-chronological order |
| `latestArtifact` returns null when empty | Edge case |
| `slugify` strips path separators | Security: no `../../` injection |
| `slugify` handles empty/unicode | Fallback to provided name |
| `slugify` all-chars-stripped → fallback | e.g. title "🎉🎊" → fallback slug |
| `buildArtifactFilename` maps kind→extension | Covers all rows in §3.2's table: `document`→`.md`, recognized langs, fallback `.txt` |
| `downloadTextFile` constructs blob URL | Mock `URL.createObjectURL`; verify `URL.revokeObjectURL` is called (via `setTimeout(revoke, 0)` to allow download to fire first) |

**File**: `src/components/__tests__/artifact-panel.test.tsx` (Vitest + React Testing Library, if available)

| Test | Purpose |
|---|---|
| Panel renders artifact content | Type-specific renderer dispatches |
| Escape key closes panel | Keyboard accessibility + focus returns to triggering chip |
| Close button fires onClose | Click handler |
| Copy button writes to clipboard | Mock `navigator.clipboard`; null-check guard |
| Download triggers anchor click | Mock `URL.createObjectURL`; verify `revokeObjectURL` cleanup |
| Width persists to localStorage | Resize + reload (desktop only) |
| Chip is semantic `<button>` | `aria-label` includes title + kind + description |
| Error-state chip renders | Tool part `output-error` → red chip with error text |

**Vitest config** (Rule 18): Check for existing `vitest.config.ts`; if absent, create one with bounded workers (`maxWorkers: 2`, `--max-old-space-size=2048`) to prevent OOM.

## 8. Non-Goals (v1)

- Text-tag parsing / `<artifact>` tags — the fragile path being avoided
- Multi-message artifact editing (model can call `create_artifact` again with updated content)
- Cross-chat artifact persistence (artifacts live in `UIMessage` content, saved by existing `chat-storage.ts`)
- Collaborative/shared artifacts (local-only feature)
- Artifact search/index within panel (v1: single latest auto-open + chip stack)
- Offline bundling of React/Babel runtime (v1 depends on CDN; local vendoring is a future optimization)
