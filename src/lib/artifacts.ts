import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { bundledLanguages, type BundledLanguage } from "shiki";
import { z } from "zod";

/**
 * Detection + metadata helpers for AI-created artifacts.
 *
 * An artifact is the output of the artifact_publish chat tool: a
 * self-contained deliverable (code file, document) previewed in the
 * side panel. Pure logic — no React.
 */

/** Discriminator between executable/source artifacts, prose ones, and multi-file projects. */
export type ArtifactKind = "code" | "document" | "project";
export type ArtifactViewMode = "preview" | "code";

/** A single file within a multi-file artifact project. */
export interface ChatArtifactFile {
  path: string;
  name: string;
  content: string;
  language?: BundledLanguage | "svg";
  kind: "code" | "document";
}

export type FileTreeNode =
  | {
      type: "file";
      file: ChatArtifactFile;
      name: string;
      path: string;
    }
  | {
      type: "folder";
      name: string;
      path: string;
      children: FileTreeNode[];
    };

/**
 * Builds a hierarchical tree node structure from a flat list of artifact files.
 * Folders appear before files, and items are sorted alphabetically.
 */
export function buildFileTree(files: ChatArtifactFile[]): FileTreeNode[] {
  interface IntermediateFolder {
    name: string;
    path: string;
    folders: Map<string, IntermediateFolder>;
    files: ChatArtifactFile[];
  }

  const rootFolder: IntermediateFolder = {
    name: "",
    path: "",
    folders: new Map(),
    files: [],
  };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let current = rootFolder;
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!current.folders.has(part)) {
        current.folders.set(part, {
          name: part,
          path: currentPath,
          folders: new Map(),
          files: [],
        });
      }
      current = current.folders.get(part)!;
    }

    current.files.push(file);
  }

  function convertFolder(folder: IntermediateFolder): FileTreeNode[] {
    const folderNodes: FileTreeNode[] = Array.from(folder.folders.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((subFolder) => ({
        type: "folder" as const,
        name: subFolder.name,
        path: subFolder.path,
        children: convertFolder(subFolder),
      }));

    const fileNodes: FileTreeNode[] = folder.files
      .slice()
      .sort((a, b) => (a.name || a.path).localeCompare(b.name || b.path))
      .map((file) => ({
        type: "file" as const,
        file,
        name: file.name || file.path.split("/").pop() || file.path,
        path: file.path,
      }));

    return [...folderNodes, ...fileNodes];
  }

  return convertFolder(rootFolder);
}

/**
 * Language id → download extension, per spec §3.2 table. Keys are
 * lowercase ids as models emit them.
 */
export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  javascript: "jsx",
  js: "jsx",
  jsx: "jsx",
  python: "py",
  py: "py",
  rust: "rs",
  go: "go",
  json: "json",
  yaml: "yml",
  yml: "yml",
  bash: "sh",
  shell: "sh",
  sh: "sh",
  zsh: "sh",
  html: "html",
  css: "css",
  scss: "scss",
};

const MAX_SLUG_LENGTH = 48;

/**
 * Filesystem-safe slug of `value`: keeps [a-z0-9_-], collapses other
 * runs into single dashes, caps length, returns `fallback` when nothing
 * survives (emoji-only titles). Strips path separators so a hostile
 * title cannot escape the downloads directory.
 */
export function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
  return slug || fallback;
}

/**
 * Download extension per spec §3.2: documents are markdown; code uses
 * the map, else the sanitized raw first token of the language string,
 * else txt.
 */
export function extensionFor(kind: ArtifactKind, language?: string): string {
  if (kind === "document") return "md";
  const raw = language?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!raw || /[^a-z0-9+#]/.test(raw)) return "txt";
  return LANGUAGE_EXTENSIONS[raw] ?? raw;
}

/** Safe download filename derived from title/kind/language. */
export function buildArtifactFilename(input: {
  kind: ArtifactKind;
  language?: string;
  title: string;
}): string {
  return `${slugify(input.title, "artifact")}.${extensionFor(input.kind, input.language)}`;
}

export const ARTIFACT_TOOL = "artifact_publish" as const;

/**
 * Tools recognized as artifact producers. Includes the legacy name
 * (create_artifact) so artifacts in historical conversations keep
 * rendering after the rename to artifact_publish.
 */
export const ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
  ARTIFACT_TOOL,
  "create_artifact",
]);

/** Validated shape of the artifact_publish tool output (spec §3.1). */
const artifactOutputSchema = z.object({
  title: z.string().min(1),
  kind: z.enum(["code", "document", "project"]),
  language: z.string().optional(),
  content: z.string().optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
        language: z.string().optional(),
      })
    )
    .optional(),
}).refine(
  (data) => Boolean(data.content || (data.files && data.files.length > 0)),
  {
    message: "Either content or files must be provided",
  }
);

/** A standalone deliverable extracted from an artifact_publish tool part. */
export interface ChatArtifact {
  /** Stable id — the originating tool call id. */
  id: string;
  kind: ArtifactKind;
  title: string;
  /** Human summary line, e.g. "html · 12 lines", "230 words", or "3 files". */
  description: string;
  /** Raw source: code/markup for kind="code", markdown for documents, or primary file content. */
  content: string;
  /** Multi-file project structure if applicable. */
  files?: ChatArtifactFile[];
  /**
   * Language id, only when recognized. "svg" is a first-class renderer
   * route despite having no shiki grammar.
   */
  language?: BundledLanguage | "svg";
  /** Sanitized download filename. */
  filename: string;
}

/**
 * Shiki-highlightable language id, or undefined when unrecognized —
 * renderers then fall back to plain text instead of throwing. "svg" is
 * special-cased: it has no shiki grammar but is a first-class artifact
 * renderer route (spec §3.4 — SVG must render via <img>, where scripts
 * never execute).
 */
function normalizeLanguage(
  raw: string | undefined
): BundledLanguage | "svg" | undefined {
  const lang = raw?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!lang) return undefined;
  if (lang === "svg") return "svg";
  return lang in bundledLanguages ? (lang as BundledLanguage) : undefined;
}

function inferLanguageFromPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "ts") return "typescript";
  if (ext === "js") return "javascript";
  return ext;
}

/**
 * Convert one artifact_publish output into a ChatArtifact. Returns null
 * and warns with the call id for malformed payloads — an explicit
 * non-fatal skip per spec §5, never silent.
 */
export function buildArtifactFromToolOutput(
  id: string,
  output: unknown
): ChatArtifact | null {
  const parsed = artifactOutputSchema.safeParse(output);
  if (!parsed.success) {
    console.warn(
      `[artifacts] Skipping malformed artifact_publish output (${id})`,
      parsed.error.message
    );
    return null;
  }
  const { title, kind, language, content: rawContent, files: rawFiles } = parsed.data;

  let files: ChatArtifactFile[] | undefined;
  if (rawFiles && rawFiles.length > 0) {
    files = rawFiles.map((file) => {
      const fileName = file.path.split("/").pop() || file.path;
      const inferredLang = file.language || inferLanguageFromPath(file.path);
      const isDoc = inferredLang === "markdown" || inferredLang === "md" || file.path.endsWith(".md");
      return {
        path: file.path,
        name: fileName,
        content: file.content,
        language: normalizeLanguage(inferredLang),
        kind: (isDoc ? "document" : "code") as "code" | "document",
      };
    });
  } else if (kind === "project" && rawContent) {
    const inferredLang = language || "typescript";
    const isDoc = inferredLang === "markdown" || inferredLang === "md";
    files = [
      {
        path: title,
        name: title,
        content: rawContent,
        language: normalizeLanguage(inferredLang),
        kind: isDoc ? "document" : "code",
      },
    ];
  }

  const primaryContent =
    rawContent ?? (files && files.length > 0 ? files[0].content : "");

  let description: string;
  if (kind === "project" && files && files.length > 0) {
    description = `${files.length} file${files.length === 1 ? "" : "s"}`;
  } else if (kind === "document") {
    description = `${primaryContent.split(/\s+/).filter(Boolean).length} words`;
  } else {
    const lines = primaryContent.split("\n").length;
    description = `${normalizeLanguage(language) ?? language ?? "code"} · ${lines} lines`;
  }

  return {
    id,
    kind,
    title,
    content: primaryContent,
    files,
    description,
    language: normalizeLanguage(language),
    filename: buildArtifactFilename({ kind, language, title }),
  };
}

/**
 * All artifact_publish outputs in conversation order (oldest first).
 * Only fully-completed, well-formed tool outputs qualify.
 */
export function collectArtifacts(
  messages: readonly UIMessage[]
): ChatArtifact[] {
  const artifacts: ChatArtifact[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      if (!ARTIFACT_TOOLS.has(getToolName(part))) continue;
      if (part.state !== "output-available") continue;
      const artifact = buildArtifactFromToolOutput(
        part.toolCallId,
        part.output
      );
      if (artifact) artifacts.push(artifact);
    }
  }
  return artifacts;
}

/** The newest artifact in the conversation, or null. */
export function latestArtifact(
  messages: readonly UIMessage[]
): ChatArtifact | null {
  const all = collectArtifacts(messages);
  return all.length > 0 ? (all.at(-1) ?? null) : null;
}

/** Trigger a browser download of `content` under a safe filename. */
export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Defer revocation one tick so the browser starts the download first;
  // revoking synchronously cancels it in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
