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
import { useCallback, useEffect } from "react";

/**
 * Slide-in panel (right edge of the screen) hosting the ai-elements
 * <Artifact> for generated code / documents.
 *
 * Purely presentational: the parent owns both the currently open
 * artifact and the one retained while the panel slides out, so this
 * component never manages state. Stays mounted to animate; `inert`
 * keeps it out of tab order while hidden.
 */
export function ArtifactPanel({
  content,
  onClose,
  open,
}: {
  /** Artifact to render (the last-open one during the exit slide). */
  content: ChatArtifact | null;
  onClose: () => void;
  open: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const handleCopy = useCallback(() => {
    if (!content) return;
    void navigator.clipboard?.writeText(content.content).catch(() => {});
  }, [content]);

  const handleDownload = useCallback(() => {
    if (!content) return;
    downloadTextFile(content.filename, content.content);
  }, [content]);

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
      {content && (
        <Artifact className="flex-1 overflow-hidden rounded-none border-0 shadow-none">
          <ArtifactHeader>
            <div className="min-w-0">
              <ArtifactTitle className="truncate">
                {content.title}
              </ArtifactTitle>
              <ArtifactDescription className="truncate">
                {content.description}
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
                tooltip={`Download ${content.filename}`}
              />
              <ArtifactClose onClick={onClose} />
            </ArtifactActions>
          </ArtifactHeader>
          <ArtifactContent
            className={content.kind === "code" ? "p-0" : undefined}
          >
            {content.kind === "code" ? (
              content.language ? (
                <CodeBlock
                  className="rounded-none border-y-0 border-r-0"
                  code={content.content}
                  language={content.language}
                  showLineNumbers
                />
              ) : (
                <pre className="overflow-auto p-4 font-mono text-xs leading-relaxed">
                  {content.content}
                </pre>
              )
            ) : (
              <MessageResponse>
                {normalizeLatexDelimiters(content.content)}
              </MessageResponse>
            )}
          </ArtifactContent>
        </Artifact>
      )}
    </aside>
  );
}
