"use client";

import {
  Artifact as ArtifactFrame,
  ArtifactAction,
  ArtifactActions,
  ArtifactClose,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "@/components/ai-elements/artifact";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  artifactFilename,
  downloadArtifactText,
  type Artifact as ArtifactData,
  type ArtifactType,
} from "@/artifacts/types";
import { cn } from "@/lib/utils";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  FileCodeIcon,
  FileTextIcon,
  HistoryIcon,
  ImageIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CodeRenderer } from "./renderers/CodeRenderer";
import { HtmlRenderer } from "./renderers/HtmlRenderer";
import { MarkdownRenderer } from "./renderers/MarkdownRenderer";
import { ReactRenderer } from "./renderers/ReactRenderer";
import { SvgRenderer } from "./renderers/SvgRenderer";

const TYPE_ICONS: Record<ArtifactType, typeof CodeIcon> = {
  "application/code": CodeIcon,
  "application/vnd.react": FileCodeIcon,
  "image/svg+xml": ImageIcon,
  "text/html": FileCodeIcon,
  "text/markdown": FileTextIcon,
};

const TYPE_LABELS: Record<ArtifactType, string> = {
  "application/code": "Code",
  "application/vnd.react": "React",
  "image/svg+xml": "SVG",
  "text/html": "HTML",
  "text/markdown": "Document",
};

const WIDTH_KEY = "artifact-panel-width";
const MIN_WIDTH = 360;

function clampWidth(width: number): number {
  const max = Math.min(1200, Math.round(window.innerWidth * 0.85));
  return Math.max(MIN_WIDTH, Math.min(max, width));
}

function initialWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    return raw ? clampWidth(Number(raw)) : null;
  } catch {
    return null;
  }
}

export function ArtifactPanel({
  activeIdentifier,
  artifacts,
  onClose,
  onSelectArtifact,
  open,
}: {
  /** Identifier currently displayed; null shows nothing. */
  activeIdentifier: string | null;
  /** Full versioned index for this conversation (from the store). */
  artifacts: ArtifactData[];
  onClose: () => void;
  onSelectArtifact: (identifier: string) => void;
  open: boolean;
}) {
  const active =
    artifacts.find((a) => a.identifier === activeIdentifier) ?? null;

  // Desktop pane width, persisted across sessions; null = CSS default.
  const [width, setWidth] = useState<number | null>(initialWidth);
  const resizingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Drag-resize from the left edge (desktop only).
  const startResize = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      resizingRef.current = true;
      const move = (e: PointerEvent) => {
        if (!resizingRef.current) return;
        setWidth(clampWidth(window.innerWidth - e.clientX));
      };
      const up = () => {
        resizingRef.current = false;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setWidth((current) => {
          if (current != null) {
            try {
              window.localStorage.setItem(WIDTH_KEY, String(current));
            } catch {
              /* storage unavailable — non-fatal */
            }
          }
          return current;
        });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    []
  );

  const handleCopy = useCallback(() => {
    if (!active) return;
    const content = active.versions.at(-1)?.content ?? "";
    void navigator.clipboard?.writeText(content).catch(() => {});
  }, [active]);

  const handleDownload = useCallback(() => {
    if (!active) return;
    const content = active.versions.at(-1)?.content ?? "";
    downloadArtifactText(artifactFilename(active), content);
  }, [active]);

  const paneStyle =
    open && width != null ? { width: `${width}px` } : undefined;

  return (
    <aside
      aria-hidden={!open}
      aria-label="Artifact panel"
      className={cn(
        "relative h-full shrink-0 overflow-visible bg-background",
        // Mobile: full-screen sheet sliding in from the right.
        "max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:w-full max-md:border-l max-md:shadow-2xl",
        "transition-all duration-300 ease-out",
        open
          ? "max-md:translate-x-0"
          : "max-md:pointer-events-none max-md:translate-x-full",
        // Desktop: docked column squeezing the chat.
        open ? "md:border-l" : "md:w-0"
      )}
      inert={!open}
      style={paneStyle}
    >
      {/* Fixed-width inner layer so content never squishes mid-animation */}
      <div
        className="h-full w-screen md:relative"
        style={
          open && width != null ? { width: `${width}px` } : undefined
        }
      >
        {/* Resize handle (desktop) */}
        {open && (
          <div
            className="absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize transition-colors hover:bg-border md:block"
            onPointerDown={startResize}
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
          />
        )}

        {active && (
          <ArtifactFrame className="flex h-full flex-col overflow-hidden rounded-none border-0 shadow-none">
            <ArtifactHeader>
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
                  {(() => {
                    const Icon = TYPE_ICONS[active.type];
                    return <Icon className="size-4" />;
                  })()}
                </span>
                <div className="min-w-0">
                  <ArtifactTitle className="truncate">
                    {active.title}
                  </ArtifactTitle>
                  <ArtifactDescription className="truncate">
                    {TYPE_LABELS[active.type]}
                    {active.language ? ` · ${active.language}` : ""}
                  </ArtifactDescription>
                </div>
              </div>

              <ArtifactActions>
                {!active.versions.at(-1)?.complete && (
                  <span
                    aria-label="Streaming"
                    className="mr-1 size-2 animate-pulse rounded-full bg-primary"
                    title="Still writing…"
                  />
                )}

                {artifacts.length > 1 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label="Artifact history"
                        size="icon-sm"
                        variant="ghost"
                      >
                        <HistoryIcon className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>
                        Artifacts ({artifacts.length})
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {artifacts.map((entry) => (
                        <DropdownMenuItem
                          key={entry.identifier}
                          onClick={() => onSelectArtifact(entry.identifier)}
                        >
                          <span className="min-w-0 truncate">
                            {entry.title}
                          </span>
                          <span className="ml-auto pl-2 text-muted-foreground text-xs">
                            v{entry.versions.length}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                <VersionStepper artifact={active} />

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
                  tooltip={`Download ${artifactFilename(active)}`}
                />
                <ArtifactClose onClick={onClose} />
              </ArtifactActions>
            </ArtifactHeader>

            <PanelBody artifact={active} />
          </ArtifactFrame>
        )}
      </div>
    </aside>
  );
}

/**
 * Version navigation: "v{shown}/{total}" with prev/next. Offset is
 * counted from the END so a live-streaming newest version is followed
 * automatically while offset is 0.
 */
function VersionStepper({ artifact }: { artifact: ArtifactData }) {
  const [offsetFromEnd, setOffsetFromEnd] = useState(0);
  const total = artifact.versions.length;
  const shownIndex = total - 1 - Math.min(offsetFromEnd, total - 1);

  if (total <= 1) return null;

  return (
    <div
      aria-label="Artifact versions"
      className="flex items-center gap-0.5 rounded-md border bg-background px-1 py-0.5"
    >
      <Button
        aria-label="Previous version"
        className="size-6 p-0"
        disabled={shownIndex <= 0}
        onClick={() => setOffsetFromEnd((offset) => offset + 1)}
        size="icon-sm"
        variant="ghost"
      >
        <ChevronLeftIcon className="size-3.5" />
      </Button>
      <span className="min-w-10 text-center text-muted-foreground text-xs">
        v{shownIndex + 1}/{total}
      </span>
      <Button
        aria-label="Next version"
        className="size-6 p-0"
        disabled={shownIndex >= total - 1}
        onClick={() => setOffsetFromEnd((o) => Math.max(0, o - 1))}
        size="icon-sm"
        variant="ghost"
      >
        <ChevronRightIcon className="size-3.5" />
      </Button>
    </div>
  );
}

/** Renderer switch; keyed by identifier+version-count upstream so view
 * state resets cleanly when a different artifact/version is shown. */
function PanelBody({ artifact }: { artifact: ArtifactData }) {
  const content = artifact.versions.at(-1)?.content ?? "";

  switch (artifact.type) {
    case "text/markdown":
      return <MarkdownRenderer content={content} />;
    case "text/html":
      return <HtmlRenderer content={content} />;
    case "application/vnd.react":
      return <ReactRenderer content={content} />;
    case "image/svg+xml":
      return <SvgRenderer content={content} />;
    default:
      return (
        <CodeRenderer content={content} language={artifact.language} />
      );
  }
}
