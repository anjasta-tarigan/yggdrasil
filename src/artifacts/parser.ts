/**
 * Streaming-safe parser for <artifact> tags in chat text.
 *
 * Framework-agnostic state machine (no React, no DOM): feed it the full
 * accumulated text buffer of a streaming message part on every update and
 * it returns the split into plain prose segments and artifact references.
 *
 * Design notes:
 * - Chunk tolerance: an opening tag may arrive split across chunks and an
 *   artifact body is incomplete until `</artifact>` arrives; both are
 *   reported with complete=false so the UI can render progressively.
 * - Holdback: text that could be the prefix of "<artifact" or a still-
 *   unterminated opening tag is withheld from prose output so half a tag
 *   never flashes in the chat bubble.
 * - Not regex-over-whole-string: scanning uses indexOf on the two sentinels
 *   ("<artifact", "</artifact>") so cost stays linear per update.
 */

import {
  coerceArtifactType,
  MAX_ARTIFACT_CHARS,
  type ParsedArtifactRef,
  type TextSegment,
} from "./types";

const OPEN_TAG = "<artifact";
const CLOSE_TAG = "</artifact>";

/**
 * Tool-call vocabulary some models bleed into prose after making tool
 * calls in the same turn (seen as "</arg_value>" instead of
 * "</artifact>"). Stripped so artifacts survive the collision.
 */
const TOOL_BLEED = /<\/?(?:arg_value|arg_key|tool_call|function_result)\s*\/?>/g;

function sanitizeBody(raw: string): string {
  return raw.replace(TOOL_BLEED, "").replace(/^\r?\n/, "").trimEnd();
}

/** Longest suffix of `buffer` that is a proper prefix of OPEN_TAG. */
function partialOpenTagLength(buffer: string): number {
  const max = Math.min(OPEN_TAG.length - 1, buffer.length);
  for (let length = max; length > 0; length -= 1) {
    if (buffer.endsWith(OPEN_TAG.slice(0, length))) return length;
  }
  return 0;
}

/**
 * True when index sits at a real "<artifact" tag start, i.e. followed by
 * whitespace or ">" — avoids matching e.g. "<artifacts>" prose.
 */
function isOpenTagAt(buffer: string, index: number): boolean {
  if (!buffer.startsWith(OPEN_TAG, index)) return false;
  const next = buffer[index + OPEN_TAG.length];
  return next === ">" || /\s/.test(next ?? "");
}

/** Parse `name="value"` / name='value' attributes out of a tag interior. */
function parseAttributes(interior: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(interior)) !== null) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return attributes;
}

export interface ArtifactParseResult {
  /** Ordered chat content: prose runs and artifact occurrences. */
  segments: TextSegment[];
  /**
   * Every artifact occurrence in buffer order (dedup not applied — one
   * tag equals one entry).
   */
  artifacts: ParsedArtifactRef[];
}

const EMPTY_RESULT: ArtifactParseResult = { artifacts: [], segments: [] };

/**
 * Split a (possibly mid-stream) text buffer into prose and artifacts.
 * Pure function: call it again with the grown buffer after each chunk.
 */
export function parseArtifacts(buffer: string): ArtifactParseResult {
  if (!buffer.includes("<")) return EMPTY_RESULT;

  const segments: TextSegment[] = [];
  const artifacts: ParsedArtifactRef[] = [];
  let cursor = 0;
  let searchFrom = 0;

  while (cursor < buffer.length) {
    const openIndex = buffer.indexOf(OPEN_TAG, searchFrom);

    // No further tag candidate: emit the rest as prose, minus any tail
    // that might still grow into "<artifact".
    if (openIndex === -1) {
      if (segments.length === 0 && artifacts.length === 0 && cursor === 0) {
        const holdback = partialOpenTagLength(buffer);
        const text = buffer.slice(0, buffer.length - holdback);
        if (text) segments.push({ kind: "text", text });
      } else {
        const tail = buffer.slice(cursor);
        const holdback = partialOpenTagLength(tail);
        const text = tail.slice(0, tail.length - holdback);
        if (text) segments.push({ kind: "text", text });
      }
      break;
    }

    if (!isOpenTagAt(buffer, openIndex)) {
      // False positive like "<artifacts>" in prose — skip it and keep
      // scanning without splitting the surrounding sentence.
      searchFrom = openIndex + 1;
      continue;
    }

    // Prose before the tag.
    if (openIndex > cursor) {
      segments.push({ kind: "text", text: buffer.slice(cursor, openIndex) });
    }

    // Opening tag interior: wait for ">" while streaming.
    const tagEnd = buffer.indexOf(">", openIndex);
    if (tagEnd === -1) break; // unterminated opening tag — hold everything

    const attributes = parseAttributes(buffer.slice(openIndex + OPEN_TAG.length, tagEnd));
    const identifier = (attributes.identifier || "").trim();
    const ref: ParsedArtifactRef = {
      complete: false,
      content: "",
      identifier,
      language: attributes.language?.trim() || undefined,
      title: attributes.title?.trim() || identifier || "Untitled artifact",
      type: coerceArtifactType(attributes.type),
    };

    // Body: up to </artifact>, else everything (still streaming). Strip
    // the single newline the model puts right after the opening tag and
    // trailing whitespace before the closing tag.
    const bodyStart = tagEnd + 1;
    const closeIndex = buffer.indexOf(CLOSE_TAG, bodyStart);
    const rawContent =
      closeIndex === -1
        ? buffer.slice(bodyStart)
        : buffer.slice(bodyStart, closeIndex);

    const sanitized = sanitizeBody(rawContent);
    const truncated = sanitized.length > MAX_ARTIFACT_CHARS;
    ref.content = truncated
      ? sanitized.slice(0, MAX_ARTIFACT_CHARS)
      : sanitized;
    ref.complete = closeIndex !== -1 && !truncated;
    artifacts.push(ref);
    segments.push({ artifact: ref, kind: "artifact" });

    if (closeIndex === -1) break; // rest of buffer belongs to the body
    cursor = closeIndex + CLOSE_TAG.length;
    searchFrom = cursor; // resume scanning AFTER the closed artifact

    // Swallow a single newline right after a closed tag so markdown does
    // not merge the following line into a stray paragraph.
    if (buffer[cursor] === "\r") cursor += 1;
    if (buffer[cursor] === "\n") cursor += 1;
  }

  return { artifacts, segments };
}

/** Convenience: just the artifacts found in one text buffer. */
export function artifactsInText(buffer: string): ParsedArtifactRef[] {
  return parseArtifacts(buffer).artifacts;
}
