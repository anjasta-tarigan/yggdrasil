"use client";

import { FileCodeIcon, FileTextIcon } from "lucide-react";
import type { ChatArtifact } from "@/lib/artifacts";

type ArtifactChipProps = {
  artifact?: ChatArtifact;
  /** When set, renders the error variant instead of opening a panel. */
  errorText?: string;
  onOpen: (artifact: ChatArtifact) => void;
};

/**
 * Compact inline reference to a created artifact; clicking opens the
 * side panel on it. Semantic button per spec accessibility requirements.
 */
export function ArtifactChip({ artifact, errorText, onOpen }: ArtifactChipProps) {
  if (errorText) {
    return (
      <span className="flex max-w-xs items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-2 pr-3 text-xs text-destructive">
        <FileCodeIcon className="size-4 shrink-0" />
        Artifact failed: {errorText}
      </span>
    );
  }

  const current = artifact!;
  const Icon = current.kind === "document" ? FileTextIcon : FileCodeIcon;
  return (
    <button
      aria-label={`${current.title} — ${current.kind}. ${current.description}`}
      className="flex max-w-xs items-center gap-2.5 rounded-xl border bg-muted/40 p-2 pr-3 text-left transition-colors hover:bg-muted"
      onClick={() => onOpen(current)}
      type="button"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground text-xs">
          {current.title}
        </span>
        <span className="block truncate text-muted-foreground text-[11px]">
          {current.description}
        </span>
      </span>
    </button>
  );
}
