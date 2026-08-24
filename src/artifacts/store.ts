/**
 * Artifact state management.
 *
 * The store is *derived*, not accumulated: on every render/update we walk
 * the conversation's message texts through the parser and fold each
 * <artifact> occurrence into a versioned record keyed by its identifier
 * slug. This gives us for free:
 *
 * - persistence — artifacts live inside message history, which
 *   lib/chat-storage.ts already saves to localStorage;
 * - reload correctness — restored chats rebuild the same index;
 * - versioning — repeated identifiers append versions instead of
 *   overwriting.
 */

import type { UIMessage } from "ai";
import { artifactsInText } from "./parser";
import { coerceArtifactType, type Artifact } from "./types";

/**
 * Build the full artifact index for a conversation.
 *
 * @param messages Chat messages whose assistant text parts may contain tags.
 * @returns Ordered list; first appearance order of each identifier.
 */
export function buildArtifactIndex(messages: UIMessage[]): Artifact[] {
  const byIdentifier = new Map<string, Artifact>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      for (const ref of artifactsInText(part.text)) {
        const identifier = ref.identifier || slugifyFallback(ref.title);
        const existing = byIdentifier.get(identifier);
        const snapshot = {
          complete: ref.complete,
          content: ref.content,
        };

        if (!existing) {
          byIdentifier.set(identifier, {
            identifier,
            language: ref.language,
            title: ref.title,
            type: coerceArtifactType(ref.type),
            versions: [snapshot],
          });
          continue;
        }

        // Same identifier later in the conversation => new version. A
        // mid-stream update of the SAME occurrence is not a new version:
        // only count refs that are not the in-progress tail of this one,
        // detected by comparing against the last recorded version while
        // it was incomplete.
        const last = existing.versions.at(-1);
        if (
          !ref.complete &&
          last &&
          !last.complete &&
          ref.content.startsWith(last.content)
        ) {
          existing.versions[existing.versions.length - 1] = snapshot;
        } else {
          existing.versions.push(snapshot);
        }
      }
    }
  }

  return [...byIdentifier.values()];
}

/** Lowercase-slug fallback when the model omits the identifier attribute. */
function slugifyFallback(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "artifact"
  );
}

/** Latest version content of an artifact ("current" view). */
export function latestVersion(artifact: Artifact): {
  complete: boolean;
  content: string;
} {
  return artifact.versions.at(-1) ?? { complete: false, content: "" };
}
