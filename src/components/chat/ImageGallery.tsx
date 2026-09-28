"use client";

import * as React from "react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  ArrowSquareOut,
  ArrowsOut,
  CircleNotch,
  Image,
  WarningCircle,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type ImageSearchResultItem = {
  title: string;
  image_url: string;
  thumbnail_url?: string;
  source_url?: string;
  source_name?: string;
  width?: number;
  height?: number;
  mime_type?: string;
  alt_text?: string;
  rank: number;
};

export type ImageGalleryProps = {
  /** Single part (backwards-compatible) or array of parts to merge. */
  part: ToolUIPart | DynamicToolUIPart | Array<ToolUIPart | DynamicToolUIPart>;
  className?: string;
  maxImages?: number;
};

/**
 * Dedup results by image_url, keeping the first highest-ranked occurrence.
 * Preserves insertion order for stable rendering.
 */
function dedupeResults(
  results: ImageSearchResultItem[]
): ImageSearchResultItem[] {
  const seen = new Set<string>();
  const out: ImageSearchResultItem[] = [];
  for (const item of results) {
    if (seen.has(item.image_url)) continue;
    seen.add(item.image_url);
    out.push(item);
  }
  return out;
}

type ImageCardProps = {
  item: ImageSearchResultItem;
  onPreview: (item: ImageSearchResultItem) => void;
  onError: (url: string) => void;
  isSingle: boolean;
};

function ImageCard({ item, onPreview, onError, isSingle }: ImageCardProps) {
  const displayTitle = item.title || item.alt_text || "Image result";
  const sourceHref = item.source_url || item.image_url;
  const sourceName = item.source_name || "Source";

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/60 transition-all hover:border-primary/40 hover:shadow-sm">
      {/* Clickable image area */}
      <button
        type="button"
        aria-label={`Preview ${displayTitle}`}
        onClick={() => onPreview(item)}
        className={cn(
          "relative w-full overflow-hidden bg-muted/40 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isSingle ? "aspect-[16/10] sm:aspect-[4/3]" : "aspect-[4/3]"
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.thumbnail_url || item.image_url}
          alt={item.alt_text || displayTitle}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => onError(item.image_url)}
          className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
        {/* Subtle hover overlay with zoom icon */}
        <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/20 flex items-center justify-center opacity-0 group-hover:opacity-100 duration-200">
          <span className="rounded-full bg-background/80 p-2 text-foreground backdrop-blur-xs shadow-xs">
            <ArrowsOut className="size-4" />
          </span>
        </div>
      </button>

      {/* Card meta & attribution footer */}
      <div className="flex flex-col gap-1 p-2.5">
        <span
          className="line-clamp-1 text-xs font-medium text-foreground"
          title={displayTitle}
        >
          {displayTitle}
        </span>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          {sourceHref ? (
            <a
              href={sourceHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary/80 hover:text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="max-w-[140px] truncate">{sourceName}</span>
              <ArrowSquareOut className="size-2.5 shrink-0" />
            </a>
          ) : (
            <span className="truncate">{sourceName}</span>
          )}

          {item.width && item.height && (
            <span className="text-[10px] text-muted-foreground/70">
              {item.width}×{item.height}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const MAX_DEFAULT_DISPLAY_IMAGES = 2;

export function ImageGallery({ part, className, maxImages }: ImageGalleryProps) {
  const [activePreview, setActivePreview] =
    React.useState<ImageSearchResultItem | null>(null);
  const [failedUrls, setFailedUrls] = React.useState<Set<string>>(new Set());

  const handleImageError = React.useCallback((url: string) => {
    setFailedUrls((prev) => {
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  }, []);

  // Normalize to an array of parts so a single ImageGallery can merge
  // multiple image_search results and dedupe them.
  const parts: Array<ToolUIPart | DynamicToolUIPart> = Array.isArray(part)
    ? part
    : [part];

  // Use the first part as the "lead" for loading/error/query display.
  const leadPart = parts[0];

  // Extract query from lead part's input or output
  const inputQuery =
    leadPart.input && typeof leadPart.input === "object"
      ? (leadPart.input as { query?: string }).query
      : undefined;

  const outputObj =
    leadPart.state === "output-available" &&
    leadPart.output &&
    typeof leadPart.output === "object"
      ? (leadPart.output as {
          query?: string;
          results?: ImageSearchResultItem[];
          error?: string;
        })
      : undefined;

  const query = outputObj?.query || inputQuery || "images";

  // Check if count > 2 was explicitly requested in input (from lead part)
  const requestedCount =
    leadPart.input && typeof leadPart.input === "object" && "count" in leadPart.input
      ? Number((leadPart.input as { count?: number }).count)
      : undefined;
  const allowExpanded = requestedCount !== undefined && requestedCount > 2;

  // Maximum displayed images: enforced ceiling of 2 unless explicitly requested
  const displayLimit =
    maxImages ??
    (allowExpanded
      ? Math.min(requestedCount, 10)
      : MAX_DEFAULT_DISPLAY_IMAGES);

  // 1. Loading / streaming states
  if (
    leadPart.state === "input-streaming" ||
    leadPart.state === "input-available" ||
    leadPart.state === "approval-requested"
  ) {
    return (
      <div
        className={cn(
          "my-2 rounded-xl border border-border/60 bg-muted/20 p-4 max-w-2xl w-full",
          className
        )}
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CircleNotch className="size-3.5 animate-spin text-primary" />
          <span>
            Searching images for <strong className="text-foreground">{`"${query}"`}</strong>...
          </span>
        </div>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="aspect-[4/3] rounded-lg bg-muted/60 animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  // 2. Error state
  if (leadPart.state === "output-error" || outputObj?.error) {
    const errorText =
      ("errorText" in leadPart && leadPart.errorText) || outputObj?.error || "Search error";
    return (
      <div
        className={cn(
          "my-2 flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground",
          className
        )}
      >
        <WarningCircle className="size-3.5 text-muted-foreground/70 shrink-0" />
        <span>
          Image search unavailable for <strong>{`"${query}"`}</strong> ({errorText}).
        </span>
      </div>
    );
  }

  // Merge results from all parts, deduping by image_url to avoid duplicates
  // when multiple image_search tool calls return overlapping results.
  const mergedResults = dedupeResults(
    parts
      .filter(
        (p): p is ToolUIPart & { state: "output-available"; output: object } =>
          p.state === "output-available" && p.output != null
      )
      .flatMap((p) =>
        (p.output as { results?: ImageSearchResultItem[] } | undefined)?.results ?? []
      )
  );

  // Distribute the display limit across parts: if we have multiple parts,
  // try to show at least one image from each before filling remaining slots
  // from the merged pool. This prevents all slots going to one part.
  const perPartLimit = Math.max(1, Math.floor(displayLimit / parts.length));
  const distributedResults: ImageSearchResultItem[] = [];
  const seenInDistributed = new Set<string>();

  for (const p of parts) {
    if (p.state !== "output-available" || p.output == null) continue;
    const partResults =
      (p.output as { results?: ImageSearchResultItem[] } | undefined)?.results ?? [];
    const partDeduped = dedupeResults(partResults);
    let addedFromThisPart = 0;
    for (const item of partDeduped) {
      if (addedFromThisPart >= perPartLimit) break;
      if (distributedResults.length >= displayLimit) break;
      if (!seenInDistributed.has(item.image_url)) {
        seenInDistributed.add(item.image_url);
        distributedResults.push(item);
        addedFromThisPart++;
      }
    }
  }

  // Fill remaining slots from the merged pool
  for (const item of mergedResults) {
    if (distributedResults.length >= displayLimit) break;
    if (!seenInDistributed.has(item.image_url)) {
      seenInDistributed.add(item.image_url);
      distributedResults.push(item);
    }
  }

  const rawResults = distributedResults.length > 0 ? distributedResults : mergedResults;

  // 3. Empty results state
  if (rawResults.length === 0) {
    return (
      <div
        className={cn(
          "my-2 flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground",
          className
        )}
      >
        <Image className="size-3.5 text-muted-foreground/70 shrink-0" />
        <span>
          No images found for <strong>{`"${query}"`}</strong>.
        </span>
      </div>
    );
  }

  // Filter candidates by displayLimit (max 2 for normal requests) and prune broken images
  const candidateResults = rawResults.slice(0, displayLimit);
  const visibleItems = candidateResults.filter(
    (item) => !failedUrls.has(item.image_url)
  );

  // If all images in candidate set failed, display clean fallback note
  if (visibleItems.length === 0) {
    return (
      <div
        className={cn(
          "my-2 flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground",
          className
        )}
      >
        <Image className="size-3.5 text-muted-foreground/70 shrink-0" />
        <span>
          Image unavailable for <strong>{`"${query}"`}</strong>.
        </span>
      </div>
    );
  }

  // 4. Output available with results (Images first layout)
  return (
    <div className={cn("my-2 flex flex-col gap-2 w-full", className)}>
      <div className="flex items-center justify-between text-xs text-muted-foreground px-0.5 max-w-2xl">
        <span className="flex items-center gap-1.5 font-medium">
          <Image className="size-3.5 text-primary" />
          <span>Images for {`"${query}"`}</span>
        </span>
        <span className="text-[11px] text-muted-foreground/70">
          {visibleItems.length} result{visibleItems.length === 1 ? "" : "s"}
        </span>
      </div>

      <div
        className={cn(
          "grid gap-3.5 w-full",
          visibleItems.length === 1
            ? "max-w-md sm:max-w-lg grid-cols-1"
            : visibleItems.length === 2
            ? "max-w-2xl grid-cols-1 sm:grid-cols-2"
            : "max-w-3xl grid-cols-2 sm:grid-cols-3"
        )}
      >
        {visibleItems.map((item, index) => (
          <ImageCard
            key={`${item.image_url}-${index}`}
            item={item}
            onPreview={setActivePreview}
            onError={handleImageError}
            isSingle={visibleItems.length === 1}
          />
        ))}
      </div>

      {/* Lightbox / Zoom Dialog */}
      <Dialog
        open={Boolean(activePreview)}
        onOpenChange={(open) => {
          if (!open) setActivePreview(null);
        }}
      >
        <DialogContent className="max-w-3xl overflow-hidden p-4 sm:p-6">
          {activePreview && (
            <div className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle className="text-base font-semibold leading-tight text-foreground line-clamp-2">
                  {activePreview.title || activePreview.alt_text || "Image preview"}
                </DialogTitle>
              </DialogHeader>

              <div className="relative flex max-h-[65vh] w-full items-center justify-center overflow-hidden rounded-lg bg-black/5 dark:bg-black/40">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={activePreview.image_url}
                  alt={activePreview.alt_text || activePreview.title || "Full image"}
                  referrerPolicy="no-referrer"
                  className="max-h-[65vh] w-auto max-w-full rounded-lg object-contain shadow-sm"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-2">
                  {activePreview.source_name && (
                    <Badge variant="secondary" className="text-xs">
                      {activePreview.source_name}
                    </Badge>
                  )}
                  {activePreview.width && activePreview.height && (
                    <span className="text-xs text-muted-foreground/80">
                      {activePreview.width} × {activePreview.height} px
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {activePreview.source_url && (
                    <Button
                      size="sm"
                      variant="outline"
                      asChild
                      className="h-8 gap-1.5 text-xs"
                    >
                      <a
                        href={activePreview.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <span>Visit page</span>
                        <ArrowSquareOut className="size-3" />
                      </a>
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    asChild
                    className="h-8 gap-1.5 text-xs"
                  >
                    <a
                      href={activePreview.image_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span>Open image</span>
                      <ArrowSquareOut className="size-3" />
                    </a>
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
