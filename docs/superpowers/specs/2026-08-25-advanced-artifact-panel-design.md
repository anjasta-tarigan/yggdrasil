# Advanced Responsive Artifact Panel & Multi-File FileTree Specification

## 1. Overview
This document specifies the design for an upgraded, powerful, and responsive Artifact Panel in Yggdrasil. The system supports Claude-style **Preview vs. Code** toggle modes for single-file deliverables, multi-file project/skill bundles integrated with `@/components/ai-elements/file-tree.tsx`, fullscreen/maximize toggle controls, and persistent responsive desktop resizing.

## 2. Goals
- **Preview & Code Dual-Mode**: Seamlessly toggle between live rendered output (HTML/React sandboxed iframe, SVG image, rendered markdown) and raw syntax-highlighted code.
- **Multi-File & Structured Project Explorer**: Render hierarchical directory trees for multi-file bundles using `FileTree`, `FileTreeFolder`, and `FileTreeFile`.
- **Responsive Workspace & Maximize Mode**: Support desktop drag-to-resize, full-viewport maximization toggle, and mobile drawer/breadcrumb adaptation.
- **Unified Tool Schema**: Upgrade `create_artifact` tool to accept single file content or structured `files: Array<{ path, content, language }>` arrays without breaking legacy outputs.

## 3. Data Model & Tool Schema

### 3.1 `create_artifact` Tool Schema (`src/lib/ai/tools.ts`)
```typescript
export const createArtifactSchema = z.object({
  title: z.string().min(1).max(80).describe("Short title, e.g. 'Snake Game in HTML5' or 'Code Review Skill Bundle'"),
  kind: z.enum(["code", "document", "project"]).describe("'code' for single program/script; 'document' for prose; 'project' for multi-file bundle"),
  language: z.string().optional().describe("Primary syntax language id (e.g. 'html', 'python', 'tsx', 'markdown')"),
  content: z.string().optional().describe("Primary file content for single deliverables"),
  files: z.array(
    z.object({
      path: z.string().describe("Relative file path, e.g. 'src/App.tsx', 'README.md'"),
      content: z.string().describe("Full file content"),
      language: z.string().optional().describe("Syntax language id for this file"),
    })
  ).optional().describe("Array of files for multi-file project or skill bundles"),
});
```

### 3.2 Artifact Types (`src/lib/artifacts.ts`)
```typescript
export type ArtifactKind = "code" | "document" | "project";
export type ArtifactViewMode = "preview" | "code";

export interface ChatArtifactFile {
  path: string;
  name: string;
  content: string;
  language?: BundledLanguage | "svg";
  kind: "code" | "document";
}

export interface ChatArtifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  language?: BundledLanguage | "svg";
  content?: string;
  files?: ChatArtifactFile[];
  description: string;
  filename: string;
}
```

## 4. UI Architecture & Components

### 4.1 Header Controls (`src/components/artifact-panel.tsx`)
- **Title & Description**: Shows title, type, and total lines/words/files.
- **View Mode Segmented Toggle**:
  - `[EyeIcon] Preview`: Active by default for HTML, SVG, React, and Markdown documents.
  - `[CodeIcon] Code`: Active by default for standalone code files (Python, Rust, Go, JSON, Bash).
- **Action Toolbar**:
  - `Copy`: Copies active file content to clipboard with check feedback.
  - `Download`: Downloads active file (or zip for projects).
  - `Maximize / Minimize`: Toggles between docked split-screen width and full viewport width.
  - `Close`: Slides panel closed.

### 4.2 Multi-File Tree Explorer (`src/components/artifact-renderers.tsx`)
- When `artifact.files` contains $\ge 2$ files or `artifact.kind === "project"`:
  - Builds a nested virtual tree structure from file paths (e.g. `src/components/Button.tsx`).
  - Left Column (Explorer, 220px on desktop, collapsible):
    - `FileTree`: Renders directory nodes using `FileTreeFolder` and leaf nodes using `FileTreeFile`.
    - Shows file icons mapped from file extensions (TS, JSX, CSS, JSON, MD, etc.).
  - Right Column (Viewer):
    - Renders the selected active file's Preview or Code view.

### 4.3 Security & Sandbox (Rule 04 & Spec §6)
- HTML and React previews run strictly inside sandboxed `<iframe>` elements (`allow-scripts allow-forms allow-modals` without `allow-same-origin` or `allow-popups`).
- SVGs render via `<img>` tags where scripts are inert.
- Inline CSP headers enforce strict origins.

## 5. Implementation Phases
1. **Schema & Extraction**: Update `src/lib/ai/tools.ts` and `src/lib/artifacts.ts` to parse single and multi-file structures.
2. **File Tree Builder Utilities**: Implement hierarchical path parser `buildFileTree(files: ChatArtifactFile[])`.
3. **Artifact Panel UI & Controls**: Implement Preview/Code toggle, maximize/fullscreen mode, and responsive layout in `src/components/artifact-panel.tsx`.
4. **Multi-File Workspace Component**: Implement split explorer view with `FileTree` in `src/components/artifact-renderers.tsx`.
5. **Testing & Verification**: Unit test all file tree parsing, preview/code toggling, and multi-file downloads.
