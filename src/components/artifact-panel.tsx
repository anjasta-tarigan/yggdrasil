"use client";

/**
 * Docked artifact pane, Claude-style (spec §3.3):
 * - Desktop: sibling flex column squeezing the chat; draggable left
 *   edge persists its width (desktop only).
 * - Mobile (<md): full-viewport slide-over from the right.
 * - Stays mounted during exit animation; `inert` while hidden.
 * - Escape closes; focus moves into the panel on open.
 */

import {
  Artifact as ArtifactFrame,
  ArtifactAction,
  ArtifactActions,
  ArtifactClose,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "@/components/ai-elements/artifact";
import { ArtifactBody } from "@/components/artifact-renderers";
import {
  downloadTextFile,
  type ChatArtifact,
} from "@/lib/artifacts";
import { cn } from "@/lib/utils";
import {
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  FileCodeIcon,
  FileTextIcon,
  LayersIcon,
} from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const WIDTH_STORAGE_KEY = "artifact-panel-width-desktop";
const MIN_WIDTH = 360;

function clampWidth(width: number): number {
  const max = Math.min(1200, Math.round(window.innerWidth * 0.85));
  return Math.max(MIN_WIDTH, Math.min(max, width));
}

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    return raw ? clampWidth(Number(raw)) : null;
  } catch {
    return null; // storage unavailable — CSS default (spec §5)
  }
}

/**
 * Static component (declared outside render — react-hooks/static-components)
 * picking the header glyph per artifact type.
 */
function ArtifactTypeIcon({ artifact }: { artifact: ChatArtifact }) {
  if (artifact.kind === "document") return <FileTextIcon className="size-4" />;
  if (artifact.language === "html" || artifact.language === "svg") {
    return <FileCodeIcon className="size-4" />;
  }
  return <CodeIcon className="size-4" />;
}

/** Slide-out duration; must match the panel's duration-300 transition. */
export const ARTIFACT_PANEL_EXIT_MS = 300;

export function ArtifactPanel({
  artifact,
  artifactCount,
  open,
  onClose,
}: {
  /** Content to render; null shows an empty shell (mid-slide states). */
  artifact: ChatArtifact | null;
  /** Total artifacts in the conversation (stack indicator). */
  artifactCount: number;
  /**
   * Whether the panel is slid in. Independent of `artifact` so the host can
   * hold content mounted while it slides out, and slide in before content
   * arrives.
   */
  open: boolean;
  onClose: () => void;
}): ReactElement {
  // Width applies to desktop only; mobile ignores it entirely.
  const [width, setWidth] = useState<number | null>(readStoredWidth);
  const closeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    // Move focus into the panel; the aside is the stable focus target
    // because the vendored ArtifactClose does not forward refs.
    closeRef.current?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Drag-resize from the left edge; pointer listeners always removed.
  const startResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const move = (e: PointerEvent) => {
      setWidth(clampWidth(window.innerWidth - e.clientX));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWidth((current) => {
        if (current != null) {
          try {
            window.localStorage.setItem(WIDTH_STORAGE_KEY, String(current));
          } catch {
            /* storage unavailable — non-fatal */
          }
        }
        return current;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  const handleCopy = useCallback(() => {
    if (!artifact) return;
    void navigator.clipboard?.writeText(artifact.content).catch(() => {});
  }, [artifact]);

  const handleDownload = useCallback(() => {
    if (!artifact) return;
    downloadTextFile(artifact.filename, artifact.content);
  }, [artifact]);

  return (
    <aside
      ref={closeRef}
      aria-hidden={!open}
      aria-label="Artifact panel"
      className={cn(
        "relative h-full shrink-0 overflow-visible bg-background",
        "max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:w-full max-md:border-l max-md:shadow-2xl",
        "transition-all duration-300 ease-out",
        open
          ? "max-md:translate-x-0 md:border-l"
          : "max-md:pointer-events-none max-md:translate-x-full md:w-0",
      )}
      inert={!open}
    >
      <div className="h-full w-screen md:relative" style={open && width != null ? { width: `${width}px` } : undefined}>
        {open && (
          <div
            aria-label="Drag to resize panel"
            className="absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize hover:bg-border md:block"
            onPointerDown={startResize}
            role="separator"
          />
        )}

        {artifact && (
          <ArtifactFrame className="flex h-full flex-col overflow-hidden rounded-none border-0 shadow-none">
            <ArtifactHeader>
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
                  <ArtifactTypeIcon artifact={artifact} />
                </span>
                <div className="min-w-0">
                  <ArtifactTitle className="truncate">{artifact.title}</ArtifactTitle>
                  <ArtifactDescription className="truncate">
                    {artifact.description}
                  </ArtifactDescription>
                </div>
              </div>

              <ArtifactActions>
                {artifactCount > 1 && (
                  <span className="flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-muted-foreground text-xs">
                    <LayersIcon className="size-3.5" />
                    {artifactCount} artifacts
                  </span>
                )}

                <ArtifactAction
                  icon={CopyIcon}
                  label={`Copy ${artifact.title}`}
                  onClick={handleCopy}
                  tooltip="Copy to clipboard"
                />
                <ArtifactAction
                  icon={DownloadIcon}
                  label={`Download ${artifact.filename}`}
                  onClick={handleDownload}
                  tooltip={`Download ${artifact.filename}`}
                />
                <ArtifactClose onClick={onClose} />
              </ArtifactActions>
            </ArtifactHeader>

            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <ArtifactBody artifact={artifact} />
            </div>
          </ArtifactFrame>
        )}
      </div>
    </aside>
  );
}
