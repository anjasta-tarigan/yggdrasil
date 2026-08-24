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
