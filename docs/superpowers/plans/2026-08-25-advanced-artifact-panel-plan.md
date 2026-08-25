# Advanced Artifact Panel & Multi-File FileTree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Yggdrasil's Artifact Panel to support Claude-style Preview vs. Code toggling for single artifacts, multi-file project/skill bundles with an interactive directory `FileTree` explorer, maximize/fullscreen viewport toggling, and persistent responsive desktop resizing.

**Architecture:** Extend the `create_artifact` tool and `ChatArtifact` type to accept both single deliverables and structured `files: Array<{ path, content, language }>` bundles. Update `ArtifactPanel` with a top header segmented toggle (Preview / Code), copy/download buttons, and maximize toggle. Integrate `FileTree` from `@/components/ai-elements/file-tree.tsx` into a responsive two-column explorer layout for multi-file bundles.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Shiki syntax highlighter, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-25-advanced-artifact-panel-design.md`

## Global Constraints

- Sandboxed Execution: HTML and React artifact previews must remain in sandboxed iframes without `allow-same-origin` or `allow-popups` (Rule 04).
- Accessibility: Interactive buttons and toggles must carry descriptive `aria-label`s and proper keyboard navigation (Escape to close, Enter/Space for tree selection) (Rule 09).
- Responsive Discipline: Layout must gracefully adapt between desktop (draggable split-pane or maximize) and mobile (<md full-screen slide-over) (Rule 19).
- Test-Driven Verification: Write failing unit tests for all tree parsing, mode switching, and rendering before code changes (Rule 16).

---

## File Structure & Responsibilities

```
src/
├── lib/
│   ├── ai/
│   │   └── tools.ts             # Updates create_artifact tool schema to support files array
│   └── artifacts.ts             # Domain types (ChatArtifact, ChatArtifactFile), buildFileTree helper, parser
├── components/
│   ├── artifact-panel.tsx       # Upgraded ArtifactPanel with Preview/Code toggle, Maximize, responsive resize
│   ├── artifact-renderers.tsx   # Upgraded renderer: multi-file FileTree workspace, single Preview/Code views
│   └── __tests__/
│       ├── artifact-panel.test.tsx      # Tests for header toggles, maximize, keyboard shortcuts
│       └── artifact-renderers.test.tsx  # Tests for single preview/code & multi-file tree exploration
```

---

### Task 1: Update `create_artifact` Schema & `artifacts.ts` Multi-File Parser

**Files:**
- Modify: `src/lib/ai/tools.ts`
- Modify: `src/lib/artifacts.ts`
- Modify: `src/lib/__tests__/artifacts.test.ts`

**Interfaces:**
- Produces: `ChatArtifactFile`, `FileTreeNode` hierarchy, `buildFileTree(files: ChatArtifactFile[])`, and upgraded `buildArtifactFromToolOutput`.

- [ ] **Step 1: Write failing test for multi-file artifact parsing and tree construction**

Update `src/lib/__tests__/artifacts.test.ts` to add test cases for multi-file project artifacts and `buildFileTree`:

```typescript
import { buildFileTree, type ChatArtifactFile } from "@/lib/artifacts";

describe("buildFileTree", () => {
  it("converts flat file paths into nested tree nodes", () => {
    const files: ChatArtifactFile[] = [
      { path: "package.json", name: "package.json", content: "{}", kind: "code" },
      { path: "src/App.tsx", name: "App.tsx", content: "export default () => null", kind: "code", language: "tsx" },
      { path: "src/components/Button.tsx", name: "Button.tsx", content: "export const Button = () => null", kind: "code", language: "tsx" },
      { path: "README.md", name: "README.md", content: "# Hello", kind: "document" },
    ];

    const tree = buildFileTree(files);
    expect(tree).toBeDefined();
    // Root should contain package.json, src folder, and README.md
    const srcFolder = tree.find((n) => n.type === "folder" && n.name === "src");
    expect(srcFolder).toBeDefined();
    if (srcFolder && srcFolder.type === "folder") {
      expect(srcFolder.children.find((c) => c.name === "App.tsx")).toBeDefined();
      const compFolder = srcFolder.children.find((c) => c.type === "folder" && c.name === "components");
      expect(compFolder).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/__tests__/artifacts.test.ts`
Expected: FAIL (`buildFileTree is not exported`).

- [ ] **Step 3: Update `src/lib/ai/tools.ts` & `src/lib/artifacts.ts`**

Update `create_artifact` input schema in `src/lib/ai/tools.ts` to accept optional `files: z.array(...)`.
Implement `FileTreeNode`, `buildFileTree`, and update `buildArtifactFromToolOutput` in `src/lib/artifacts.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/__tests__/artifacts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/tools.ts src/lib/artifacts.ts src/lib/__tests__/artifacts.test.ts
git commit -m "feat(artifacts): add multi-file schema and hierarchical file tree parser"
```

---

### Task 2: Implement Preview vs. Code Toggle and Maximize in `ArtifactPanel`

**Files:**
- Modify: `src/components/artifact-panel.tsx`
- Modify: `src/components/__tests__/artifact-panel.test.tsx`

**Interfaces:**
- Produces: Header view mode toggle (`[Eye] Preview | [</>] Code`), `isMaximized` viewport expansion, and active mode state passed to body renderer.

- [ ] **Step 1: Write failing tests for Preview/Code toggle and Maximize controls**

Update `src/components/__tests__/artifact-panel.test.tsx` to test:
- Toggling between Preview and Code view modes.
- Clicking Maximize expands the aside width to full viewport (`w-full` / `max-w-full`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/__tests__/artifact-panel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement header controls and view toggles in `src/components/artifact-panel.tsx`**

Update `src/components/artifact-panel.tsx`:
- Add `viewMode: "preview" | "code"` state.
- Add `isMaximized: boolean` state.
- Add segmented `Preview` / `Code` buttons in `ArtifactHeader`.
- Add `Maximize2` / `Minimize2` toggle button.
- Pass `viewMode` down to `ArtifactBody`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/__tests__/artifact-panel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/artifact-panel.tsx src/components/__tests__/artifact-panel.test.tsx
git commit -m "feat(artifacts): add Preview/Code view toggle and maximize viewport controls"
```

---

### Task 3: Implement Multi-File `FileTree` Explorer Workspace in `ArtifactBody`

**Files:**
- Modify: `src/components/artifact-renderers.tsx`
- Modify: `src/components/__tests__/artifact-renderers.test.tsx`

**Interfaces:**
- Produces: `MultiFileWorkspace` component rendering the `@/components/ai-elements/file-tree.tsx` on the left and active file viewer on the right with Preview/Code support.

- [ ] **Step 1: Write failing test for multi-file project rendering with FileTree**

Update `src/components/__tests__/artifact-renderers.test.tsx` to assert that when an artifact has `files`, `FileTree` is rendered, folders expand, and selecting a file updates the viewed content.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/__tests__/artifact-renderers.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `MultiFileWorkspace` in `src/components/artifact-renderers.tsx`**

Integrate `FileTree`, `FileTreeFolder`, and `FileTreeFile` into `ArtifactBody`:
- Render recursive directory tree from `buildFileTree(artifact.files)`.
- Track `selectedFilePath`.
- Display selected file's live Preview (if HTML/SVG/React/MD) or highlighted Code view according to active `viewMode`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/__tests__/artifact-renderers.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/artifact-renderers.tsx src/components/__tests__/artifact-renderers.test.tsx
git commit -m "feat(artifacts): integrate FileTree explorer for multi-file project artifacts"
```

---

### Task 4: Full Suite Verification & Mobile Responsiveness Polish

**Files:**
- Modify: `src/components/artifact-panel.tsx`
- Modify: `src/components/artifact-renderers.tsx`
- Test: Full Vitest suite & build check

- [ ] **Step 1: Run full Vitest suite**

Run: `pnpm test`
Expected: All 20+ test files pass.

- [ ] **Step 2: Run TypeScript type checker**

Run: `pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Run Next.js Turbopack build**

Run: `pnpm build`
Expected: Successful build.

- [ ] **Step 4: Commit**

```bash
git add src/
git commit -m "feat(artifacts): verify and polish responsive multi-file artifact workspace"
```
