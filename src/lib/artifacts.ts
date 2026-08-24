import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { bundledLanguages, type BundledLanguage } from "shiki";
import { z } from "zod";

/**
 * Detection + metadata helpers for AI-created artifacts.
 *
 * An artifact is the output of the create_artifact chat tool: a
 * self-contained deliverable (code file, document) previewed in the
 * side panel. Pure logic — no React.
 */

/** Discriminator between executable/source artifacts and prose ones. */
export type ArtifactKind = "code" | "document";

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

export const ARTIFACT_TOOL = "create_artifact" as const;

/** Validated shape of the create_artifact tool output (spec §3.1). */
const artifactOutputSchema = z.object({
  title: z.string().min(1),
  kind: z.enum(["code", "document"]),
  language: z.string().optional(),
  content: z.string().min(1),
});

/** A standalone deliverable extracted from a create_artifact tool part. */
export interface ChatArtifact {
  /** Stable id — the originating tool call id. */
  id: string;
  kind: ArtifactKind;
  title: string;
  /** Human summary line, e.g. "html · 12 lines" or "230 words". */
  description: string;
  /** Raw source: code/markup for kind="code", markdown for documents. */
  content: string;
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

/**
 * Convert one create_artifact output into a ChatArtifact. Returns null
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
      `[artifacts] Skipping malformed create_artifact output (${id})`,
      parsed.error.message
    );
    return null;
  }
  const { title, kind, language, content } = parsed.data;
  const lines = content.split("\n").length;
  const description =
    kind === "document"
      ? `${content.split(/\s+/).filter(Boolean).length} words`
      : `${normalizeLanguage(language) ?? language ?? "code"} · ${lines} lines`;
  return {
    id,
    kind,
    title,
    content,
    description,
    language: normalizeLanguage(language),
    filename: buildArtifactFilename({ kind, language, title }),
  };
}

/**
 * All create_artifact outputs in conversation order (oldest first).
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
      if (getToolName(part) !== ARTIFACT_TOOL) continue;
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
