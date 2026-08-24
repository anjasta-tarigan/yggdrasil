"use client";

import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactClose,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "@/components/ai-elements/artifact";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import { downloadTextFile, type ChatArtifact } from "@/lib/artifacts";
import { normalizeLatexDelimiters } from "@/lib/latex";
import { cn } from "@/lib/utils";
import { CopyIcon, DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

/**
 * Slide-in panel (right edge of the screen) hosting the ai-elements
 * <Artifact> for generated code / documents.
 *
 * Stays mounted so the open/close transition animates; `inert` keeps the
 * hidden panel out of tab order. While sliding out it keeps rendering the
 * previous artifact (mirrored ref) instead of popping empty.
 */
export function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: ChatArtifact | null;
  onClose: () => void;
}) {
  // Mirror the latest non-null artifact so content survives the exit slide.
  const lastRef = useRef<ChatArtifact | null>(null);
  if (artifact) lastRef.current = artifact;
  const shown = artifact ?? lastRef.current;

  const open = artifact != null;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const handleCopy = useCallback(() => {
    const current = artifact ?? lastRef.current;
    if (!current) return;
    void navigator.clipboard?.writeText(current.content).catch(() => {});
  }, [artifact]);

  const handleDownload = useCallback(() => {
    const current = artifact ?? lastRef.current;
    if (!current) return;
    downloadTextFile(current.filename, current.content);
  }, [artifact]);

  return (
    <aside
      aria-hidden={!open}
      aria-label="Artifact"
      className={cn(
        "fixed inset-y-0 right-0 z-50 flex w-[min(100vw,40rem)] flex-col border-l bg-background shadow-2xl outline-none",
        "transition-[transform,visibility] duration-300 ease-out",
        open ? "visible translate-x-0" : "invisible translate-x-full"
      )}
      inert={!open}
    >
      {shown && (
        <Artifact className="flex-1 overflow-hidden rounded-none border-0 shadow-none">
          <ArtifactHeader>
            <div className="min-w-0">
              <ArtifactTitle className="truncate">{shown.title}</ArtifactTitle>
              <ArtifactDescription className="truncate">
                {shown.description}
              </ArtifactDescription>
            </div>
            <ArtifactActions>
              <ArtifactAction
                icon={CopyIcon}
                label="Copy"
                onClick={handleCopy}
                tooltip="Copy to clipboard"
              />
              <ArtifactAction
                icon={DownloadIcon}
                label="Download"
                onClick={handleDownload}
                tooltip={`Download ${shown.filename}`}
              />
              <ArtifactClose onClick={onClose} />
            </ArtifactActions>
          </ArtifactHeader>
          <ArtifactContent className={shown.kind === "code" ? "p-0" : undefined}>
            {shown.kind === "code" ? (
              shown.language ? (
                <CodeBlock
                  className="rounded-none border-y-0 border-r-0"
                  code={shown.content}
                  language={shown.language}
                  showLineNumbers
                />
              ) : (
                <pre className="overflow-auto p-4 font-mono text-xs leading-relaxed">
                  {shown.content}
                </pre>
              )
            ) : (
              <MessageResponse>
                {normalizeLatexDelimiters(shown.content)}
              </MessageResponse>
            )}
          </ArtifactContent>
        </Artifact>
      )}
    </aside>
  );
}
