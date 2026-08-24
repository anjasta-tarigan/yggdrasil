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
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import { downloadTextFile, type ChatArtifact } from "@/lib/artifacts";
import { normalizeLatexDelimiters } from "@/lib/latex";
import { cn } from "@/lib/utils";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * Docked artifact pane, Claude-style: on desktop it is a sibling column
 * of the chat (the conversation compresses while it stays open), on
 * small screens it takes over the full viewport. Stays mounted so both
 * transitions animate; `inert` keeps hidden panels out of tab order.
 */
export function ArtifactPanel({
  content,
  onClose,
  onSelectVersion,
  open,
  versions,
}: {
  /** Artifact currently displayed (last-open one during exit slide). */
  content: ChatArtifact | null;
  onClose: () => void;
  /** Switch to another version within the open group. */
  onSelectVersion: (id: string) => void;
  open: boolean;
  /** All versions (same title+kind) of the displayed artifact, oldest first. */
  versions: ChatArtifact[];
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

  const activeIndex = content
    ? versions.findIndex((v) => v.id === content.id)
    : -1;

  return (
    <aside
      aria-hidden={!open}
      aria-label="Artifact"
      className={cn(
        "h-full shrink-0 overflow-hidden bg-background",
        // Small screens: slide-over covering the viewport.
        "max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:w-full max-md:border-l max-md:shadow-2xl",
        "transition-all duration-300 ease-out",
        open
          ? "max-md:translate-x-0"
          : "max-md:pointer-events-none max-md:translate-x-full",
        // md+: docked split pane; the width animation squeezes the chat.
        open ? "md:w-[min(60%,52rem)] md:border-l" : "md:w-0"
      )}
      inert={!open}
    >
      {/* Fixed inner width so content never squishes while animating */}
      <div className="h-full w-screen md:w-[min(60%,52rem)]">
        {content && (
          <Artifact className="flex h-full flex-col overflow-hidden rounded-none border-0 shadow-none">
            <ArtifactHeader>
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
                  {content.kind === "code" ? (
                    <CodeIcon className="size-4" />
                  ) : (
                    <FileTextIcon className="size-4" />
                  )}
                </span>
                <div className="min-w-0">
                  <ArtifactTitle className="truncate">
                    {content.title}
                  </ArtifactTitle>
                  <ArtifactDescription className="truncate">
                    {content.description}
                  </ArtifactDescription>
                </div>
              </div>              <ArtifactActions>
                {versions.length > 1 && activeIndex >= 0 && (
                  <div
                    aria-label="Artifact versions"
                    className="flex items-center gap-0.5 rounded-md border bg-background px-1 py-0.5"
                  >
                    <Button
                      aria-label="Previous version"
                      className="size-6 p-0"
                      disabled={activeIndex <= 0}
                      onClick={() =>
                        onSelectVersion(versions[activeIndex - 1].id)
                      }
                      size="icon-sm"
                      variant="ghost"
                    >
                      <ChevronLeftIcon className="size-3.5" />
                    </Button>
                    <span className="min-w-10 text-center text-muted-foreground text-xs">
                      v{activeIndex + 1}/{versions.length}
                    </span>
                    <Button
                      aria-label="Next version"
                      className="size-6 p-0"
                      disabled={activeIndex >= versions.length - 1}
                      onClick={() =>
                        onSelectVersion(versions[activeIndex + 1].id)
                      }
                      size="icon-sm"
                      variant="ghost"
                    >
                      <ChevronRightIcon className="size-3.5" />
                    </Button>
                  </div>
                )}
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
              className={
                isPreviewable(content) || content.kind === "code"
                  ? "flex flex-col p-0"
                  : undefined
              }
            >
              <ArtifactBody content={content} />
            </ArtifactContent>
          </Artifact>
        )}
      </div>
    </aside>
  );
}

/** HTML artifacts can be rendered live next to their source. */
function isPreviewable(artifact: ChatArtifact): boolean {
  return artifact.kind === "code" && artifact.language === "html";
}

/**
 * Code / Preview switch for HTML artifacts; keyed by artifact id upstream
 * so switching artifacts resets to the source view without effects.
 */
function ArtifactBody({ content }: { content: ChatArtifact }) {
  const [tab, setTab] = useState<"code" | "preview">("code");

  if (!isPreviewable(content)) {
    return <ArtifactStaticBody content={content} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
        <Button
          className="h-7 rounded-md px-2.5 text-xs"
          onClick={() => setTab("code")}
          size="sm"
          type="button"
          variant={tab === "code" ? "secondary" : "ghost"}
        >
          Code
        </Button>
        <Button
          className="h-7 rounded-md px-2.5 text-xs"
          onClick={() => setTab("preview")}
          size="sm"
          type="button"
          variant={tab === "preview" ? "secondary" : "ghost"}
        >
          Preview
        </Button>
      </div>
      {tab === "preview" ? (
        <iframe
          className="h-full w-full flex-1 border-0 bg-white"
          sandbox="allow-scripts allow-modals allow-forms allow-popups"
          srcDoc={content.content}
          title={`${content.title} preview`}
        />
      ) : (
        <ArtifactStaticBody content={content} />
      )}
    </div>
  );
}

/** Non-previewable rendering: highlighted code, plain code, or markdown. */
function ArtifactStaticBody({ content }: { content: ChatArtifact }) {
  if (content.kind !== "code") {
    return (
      <MessageResponse>
        {normalizeLatexDelimiters(content.content)}
      </MessageResponse>
    );
  }
  if (content.language) {
    return (
      <CodeBlock
        className="min-h-0 flex-1 rounded-none border-y-0 border-r-0"
        code={content.content}
        language={content.language}
        showLineNumbers
      />
    );
  }
  return (
    <pre className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
      {content.content}
    </pre>
  );
}
