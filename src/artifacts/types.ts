/**
 * Artifact feature types.
 *
 * An "artifact" is a self-contained piece of content (document, code
 * file, web page, SVG, React component) that the model emits inside an
 * <artifact> tag instead of a markdown code block. The client parses the
 * tag out of the chat text and renders it in a side panel with preview,
 * copy/download actions and per-identifier versioning.
 */

/** MIME-ish type discriminator for the artifact payload. */
export type ArtifactType =
  | "application/code"
  | "application/vnd.react"
  | "image/svg+xml"
  | "text/html"
  | "text/markdown";

export const ARTIFACT_TYPES: readonly ArtifactType[] = [
  "application/code",
  "application/vnd.react",
  "image/svg+xml",
  "text/html",
  "text/markdown",
];

/** One immutable snapshot of an artifact's content. */
export interface ArtifactVersion {
  content: string;
  /** True while the closing </artifact> has not streamed in yet. */
  complete: boolean;
}

/** A versioned artifact grouped under its stable identifier slug. */
export interface Artifact {
  identifier: string;
  language?: string;
  title: string;
  type: ArtifactType;
  versions: ArtifactVersion[];
}

/** A segment of parsed chat text: plain prose or an artifact reference. */
export type TextSegment =
  | { artifact: ParsedArtifactRef; kind: "artifact" }
  | { kind: "text"; text: string };

/**
 * An artifact occurrence inside one specific text buffer (one message
 * part). `identifier` links it to the shared versioned Artifact; content
 * is the snapshot as of this point in the stream.
 */
export interface ParsedArtifactRef {
  complete: boolean;
  content: string;
  identifier: string;
  language?: string;
  title: string;
  type: ArtifactType;
}

/** Hard cap on artifact content length, guarding renderer freezes. */
export const MAX_ARTIFACT_CHARS = 200_000;

export function isArtifactType(value: unknown): value is ArtifactType {
  return (
    typeof value === "string" &&
    (ARTIFACT_TYPES as readonly string[]).includes(value)
  );
}

/** Fallback when the model omits or misspells the type attribute. */
export function coerceArtifactType(value: unknown): ArtifactType {
  if (isArtifactType(value)) return value;
  return "text/markdown";
}

const TYPE_EXTENSIONS: Record<ArtifactType, string> = {
  "application/code": "txt",
  "application/vnd.react": "jsx",
  "image/svg+xml": "svg",
  "text/html": "html",
  "text/markdown": "md",
};

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  javascript: "js",
  jsx: "jsx",
  python: "py",
  shell: "sh",
  bash: "sh",
  typescript: "ts",
  tsx: "tsx",
};

/**
 * Sanitized download filename derived from identifier/title. Strips path
 * separators and control characters so a hostile title cannot escape the
 * downloads directory.
 */
export function artifactFilename(artifact: Artifact): string {
  const base =
    artifact.identifier
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "artifact";
  const extension =
    artifact.type === "application/code"
      ? (LANGUAGE_EXTENSIONS[artifact.language ?? ""] ?? "txt")
      : TYPE_EXTENSIONS[artifact.type];
  return `${base.slice(0, 64)}.${extension}`;
}

/** Trigger browser download of arbitrary text under a safe filename. */
export function downloadArtifactText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
