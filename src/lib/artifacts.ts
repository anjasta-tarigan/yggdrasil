/**
 * Detection + metadata helpers for AI-generated artifacts.
 *
 * Scans assistant message text for artifact-worthy content — sizable
 * fenced code blocks and long-form documents — so the UI can offer them
 * in the slide-in Artifact panel. Pure functions, no React.
 */

import { bundledLanguages, type BundledLanguage } from "shiki";

export type ArtifactKind = "code" | "document";

export type ChatArtifact = {
  id: string;
  kind: ArtifactKind;
  title: string;
  description: string;
  /** Raw source: code for kind="code", markdown for kind="document". */
  content: string;
  /** Shiki language for kind="code" (only when bundled/supported). */
  language?: BundledLanguage;
  /** Suggested download filename. */
  filename: string;
};

/** A fenced code block as found in raw markdown text. */
export type RawCodeBlock = {
  languageRaw: string;
  code: string;
  /** False while the closing fence hasn't streamed in yet. */
  complete: boolean;
};

/** Minimum size for a code block to be offered as an artifact. */
const CODE_MIN_LINES = 5;
const CODE_MIN_CHARS = 200;
/** Minimum markdown length for a "read as document" artifact. */
const DOC_MIN_CHARS = 1500;

/** Common fence info strings -> download extensions. */
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  javascript: "js",
  js: "js",
  jsx: "jsx",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  python: "py",
  py: "py",
  bash: "sh",
  shell: "sh",
  sh: "sh",
  zsh: "sh",
  json: "json",
  yaml: "yml",
  yml: "yml",
  html: "html",
  css: "css",
  scss: "scss",
  rust: "rs",
  rs: "rs",
  go: "go",
  java: "java",
  kotlin: "kt",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  csharp: "cs",
  "c#": "cs",
  php: "php",
  ruby: "rb",
  sql: "sql",
  markdown: "md",
  md: "md",
};

/**
 * Extracts fenced code blocks from markdown text. Detects complete
 * blocks plus a trailing still-open fence, so a block being streamed
 * right now shows up (and keeps growing) in real time.
 */
export function extractCodeBlocks(text: string): RawCodeBlock[] {
  const blocks: RawCodeBlock[] = [];
  const closed = /```([^\n]*)\n([\s\S]*?)```/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = closed.exec(text)) !== null) {
    blocks.push({
      code: match[2],
      complete: true,
      languageRaw: match[1].trim(),
    });
    lastIndex = closed.lastIndex;
  }

  // A final fence that never closed: the block currently streaming in.
  const tail = text.slice(lastIndex);
  const open = tail.match(/```([^\n]*)\n([\s\S]*)$/);
  if (open) {
    blocks.push({
      code: open[2],
      complete: false,
      languageRaw: open[1].trim(),
    });
  }

  return blocks;
}

export function isArtifactWorthyCode(code: string): boolean {
  const lines = code.split("\n").length;
  return lines >= CODE_MIN_LINES || code.length >= CODE_MIN_CHARS;
}

/**
 * Returns the fence language when shiki can actually highlight it,
 * otherwise null (callers should render plain text instead — passing an
 * unsupported id to createHighlighter throws).
 */
export function normalizeLanguage(
  languageRaw: string
): BundledLanguage | null {
  const lang = languageRaw.split(/\s+/)[0]?.toLowerCase() ?? "";
  return lang.length > 0 && lang in bundledLanguages
    ? (lang as BundledLanguage)
    : null;
}

function extensionFor(languageRaw: string): string {
  const key = languageRaw.split(/\s+/)[0]?.toLowerCase() ?? "";
  return LANGUAGE_EXTENSIONS[key] ?? "txt";
}

/**
 * Best-effort title: the first comment line of the code ("# do x",
 * "// do x", "/* do x *\/"), else a generic label.
 */
export function deriveCodeTitle(code: string): string | null {
  const firstLine = code
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  const comment = firstLine.match(
    /^(?:#+|\/\/+|\/\*+|<!--+|--+)\s*(.+?)(?:\*\/|-->|#+)?$/
  );
  const candidate = (comment?.[1] ?? "").trim();
  if (candidate.length >= 4 && candidate.length <= 60) return candidate;
  return null;
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || fallback;
}

function buildCodeArtifact(
  id: string,
  block: RawCodeBlock,
  index: number
): ChatArtifact {
  const language = normalizeLanguage(block.languageRaw);
  const title =
    deriveCodeTitle(block.code) ??
    (block.languageRaw ? `${block.languageRaw} snippet` : "Code snippet");
  const lines = block.code.split("\n").length;
  return {
    content: block.code.endsWith("\n") ? block.code : `${block.code}\n`,
    description: `${block.languageRaw || "code"} · ${lines} lines`,
    filename: `${slugify(title, `snippet-${index + 1}`)}.${extensionFor(block.languageRaw)}`,
    id,
    kind: "code",
    language: language ?? undefined,
    title,
  };
}

function buildDocumentArtifact(id: string, text: string): ChatArtifact | null {
  if (text.trim().length < DOC_MIN_CHARS) return null;
  const heading = text.match(/^#\s+(.+)$/m);
  const title = heading?.[1]?.trim().slice(0, 80) ?? "Document";
  const words = text.split(/\s+/).filter(Boolean).length;
  return {
    content: text,
    description: `${words} words`,
    filename: `${slugify(title, "document")}.md`,
    id,
    kind: "document",
    title,
  };
}

/**
 * All artifact candidates worth surfacing for one message part:
 * every sizable code block (including one mid-stream) plus, for long
 * prose, a whole-part "document" view.
 */
export function collectArtifacts(idBase: string, text: string): ChatArtifact[] {
  const artifacts: ChatArtifact[] = [];

  extractCodeBlocks(text).forEach((block, index) => {
    if (!isArtifactWorthyCode(block.code)) return;
    artifacts.push(buildCodeArtifact(`${idBase}-code-${index}`, block, index));
  });

  const document = buildDocumentArtifact(`${idBase}-document`, text);
  if (document) artifacts.push(document);

  return artifacts;
}

/** Triggers a browser download for the given text content. */
export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
